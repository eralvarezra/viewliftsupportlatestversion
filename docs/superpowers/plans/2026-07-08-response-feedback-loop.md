# Response Feedback Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rate buttons (👍/👎) on generated responses; 👎 go to a superadmin review queue where the developer writes corrections; 👍 and corrections are injected as few-shot examples into future similar `/generate` calls.

**Architecture:** Reuse `ResponseHistory` (already has `feedback` column) + `LocalEmbeddingService` (already used for FAQ similarity). Three new columns store the rated message's embedding, the developer's correction, and the review status. `/generate` retrieves top-3 similar rated examples (cosine ≥ 0.60, corrections ranked first) and prepends them to `faq_context`. All learning code is fail-open: any exception → generate behaves exactly as today.

**Tech Stack:** FastAPI + SQLAlchemy + SQLite (backend), React + Vite + Tailwind (frontend), sentence embeddings via existing `LocalEmbeddingService`.

## Global Constraints

- **The app lives on the server** `root@135.181.37.72` at `/opt/schn`. There is no local checkout. Edit cycle per file: `scp` the file down to the scratchpad, `Edit` locally, `scp` back up. SSH/scp command prefix (retry up to 5 times on network failure, the connection sometimes drops):
  `sshpass -p '53403E@@r' ssh -o StrictHostKeyChecking=no -o ConnectTimeout=25 root@135.181.37.72 "<cmd>"`
  `sshpass -p '53403E@@r' scp -o StrictHostKeyChecking=no -o ConnectTimeout=25 <local> root@135.181.37.72:<remote>` (and reverse).
- **Deploy cycle** (code is baked into images, not volume-mounted):
  `cd /opt/schn && docker compose build backend && docker compose up -d backend` (same for `frontend`). Backend build ~1 min, frontend ~2 min.
- **No test framework exists.** Verification = `docker exec -e PYTHONPATH=/app schn-backend-1 python3 -c "..."` snippets and `curl` against `http://localhost:8000` from the server. Each task ends with its verification commands.
- **Do not touch** `.env*`, `backend/schn.db` (live data), or any file not listed in a task.
- **Commit after every task** on the server repo (`cd /opt/schn && git add <files> && git commit`). Do NOT push until the final task.
- UI copy is **English** (existing convention). Feedback values are exactly `'useful'` / `'not_useful'` (existing convention).
- The three learning-data invariants: (1) unrated responses behave exactly as today; (2) rated entries are **exempt** from the daily cleanup and the 100-record cap; (3) every learning code path is wrapped in try/except and degrades to current behavior.

---

### Task 1: DB — model columns + migration

**Files:**
- Modify: `/opt/schn/backend/app/models.py` (class `ResponseHistory`, ~line 82)
- Modify: `/opt/schn/backend/app/database.py` (function `run_migrations`)

**Interfaces:**
- Produces: `ResponseHistory.message_embedding` (LargeBinary, nullable), `ResponseHistory.corrected_response` (Text, nullable), `ResponseHistory.review_status` (String, nullable; values `'pending'|'corrected'|'dismissed'`). All later tasks rely on these exact names.

- [ ] **Step 1: Add columns to the model**

In `models.py`, `class ResponseHistory`, after the existing `feedback` line:

```python
    feedback = Column(String, nullable=True)  # 'useful', 'not_useful', null
    message_embedding = Column(LargeBinary, nullable=True)  # embedding of rated message (lazy: set on rating)
    corrected_response = Column(Text, nullable=True)  # developer's correction from review queue
    review_status = Column(String, nullable=True)  # for not_useful: 'pending' | 'corrected' | 'dismissed'
```

Ensure `LargeBinary` is in the `from sqlalchemy import ...` line at the top (add it if missing — `FAQChunk.embedding` may already import it).

- [ ] **Step 2: Add migration**

In `database.py` `run_migrations()`, inside the existing `with engine.connect() as conn:` block, after the last existing `ALTER TABLE` group and **before** the platform seeding section:

```python
        # Feedback-loop columns on response_history
        cols = [r[1] for r in conn.execute(text("PRAGMA table_info(response_history)")).fetchall()]
        if "message_embedding" not in cols:
            conn.execute(text("ALTER TABLE response_history ADD COLUMN message_embedding BLOB"))
        if "corrected_response" not in cols:
            conn.execute(text("ALTER TABLE response_history ADD COLUMN corrected_response TEXT"))
        if "review_status" not in cols:
            conn.execute(text("ALTER TABLE response_history ADD COLUMN review_status TEXT"))
```

- [ ] **Step 3: Deploy backend and verify migration ran**

Upload both files, then:
```bash
cd /opt/schn && docker compose build backend && docker compose up -d backend && sleep 8
docker exec -e PYTHONPATH=/app schn-backend-1 python3 -c "
from app.database import engine
from sqlalchemy import text
with engine.connect() as c:
    cols = [r[1] for r in c.execute(text('PRAGMA table_info(response_history)')).fetchall()]
print('message_embedding' in cols, 'corrected_response' in cols, 'review_status' in cols)
"
```
Expected: `True True True`. Also `docker ps` shows backend healthy.

- [ ] **Step 4: Commit**

```bash
cd /opt/schn && git add backend/app/models.py backend/app/database.py && git commit -m "feat: add feedback-loop columns to response_history"
```

---

### Task 2: Backend — rating endpoint computes embedding; protect rated entries from cleanup

**Files:**
- Modify: `/opt/schn/backend/app/routes/history.py` (`update_feedback` ~line 152, `_cleanup_old_history` ~line 24)
- Modify: `/opt/schn/backend/app/routes/generate.py` (100-record cap, ~line 604)

**Interfaces:**
- Consumes: Task 1 columns.
- Produces: rating an entry sets `message_embedding` and (for `not_useful`) `review_status='pending'`. Helper `_feedback_embedding_text(entry) -> str` in `history.py` (Task 3 reuses it).

- [ ] **Step 1: Add embedding helper + extend `update_feedback` in history.py**

Above `update_feedback`:

```python
def _feedback_embedding_text(entry: ResponseHistory) -> str:
    """Same semantics as /generate's search query: problem_summary + context, falling back to raw message."""
    pd = entry.parsed_data if isinstance(entry.parsed_data, dict) else {}
    ps = (pd.get("problem_summary") or "").strip()
    ctx = (pd.get("context") or "").strip()
    return f"{ps} {ctx}".strip() if ps else entry.customer_message


def _ensure_embedding(entry: ResponseHistory) -> None:
    """Compute+store the message embedding. Fail-open: rating must never fail because of this."""
    if entry.message_embedding is not None:
        return
    try:
        from app.services.local_embeddings import LocalEmbeddingService
        svc = LocalEmbeddingService()
        entry.message_embedding = svc.serialize_embedding(svc.get_embedding(_feedback_embedding_text(entry)))
    except Exception:
        pass
```

In `update_feedback`, replace the two lines `entry.feedback = request.feedback` / `db.commit()` with:

```python
    entry.feedback = request.feedback
    if request.feedback == "not_useful":
        if entry.review_status not in ("corrected", "dismissed"):
            entry.review_status = "pending"
    else:
        entry.review_status = None
    _ensure_embedding(entry)
    db.commit()
```

- [ ] **Step 2: Exempt rated entries from daily cleanup**

In `_cleanup_old_history`, add one filter:

```python
    db.query(ResponseHistory).filter(
        ResponseHistory.user_id == user_id,
        ResponseHistory.created_at < _today_start(),
        ResponseHistory.feedback.is_(None),
    ).delete(synchronize_session=False)
```

- [ ] **Step 3: Exempt rated entries from the 100-record cap in generate.py**

In the "Step 7: Enforce 100-record cap" block (~line 604), add `.filter(ResponseHistory.feedback.is_(None))` to **both** the `count()` query and the `oldest` query, so only unrated entries are counted and deleted.

- [ ] **Step 4: Deploy + verify**

Upload both files, rebuild/restart backend, then:
```bash
docker exec -e PYTHONPATH=/app schn-backend-1 python3 -c "
from app.database import SessionLocal
from app.models import ResponseHistory
from app.routes.history import _ensure_embedding
db = SessionLocal()
e = db.query(ResponseHistory).order_by(ResponseHistory.id.desc()).first()
e.feedback = 'not_useful'; e.review_status = 'pending'
_ensure_embedding(e); db.commit()
print('id', e.id, 'emb bytes:', len(e.message_embedding or b''), 'status:', e.review_status)
e.feedback = None; e.review_status = None; e.message_embedding = None; db.commit()  # leave data clean
"
```
Expected: `emb bytes:` > 0 (e.g. 1536+), `status: pending`.

- [ ] **Step 5: Commit**

```bash
git add backend/app/routes/history.py backend/app/routes/generate.py && git commit -m "feat: rating computes embedding; rated entries exempt from cleanup/cap"
```

---

### Task 3: Backend — review queue endpoints (superadmin)

**Files:**
- Modify: `/opt/schn/backend/app/routes/history.py`
- Modify: `/opt/schn/backend/app/schemas.py`

**Interfaces:**
- Consumes: Task 1 columns; `_ensure_embedding` from Task 2; `User.is_superadmin` (exists).
- Produces:
  - `GET /api/history/review-queue` → `{"count": int, "items": [{id, customer_name, customer_message, generated_response, created_at, platform_name, agent_username}]}` (superadmin only, all users).
  - `POST /api/history/{id}/correct` body `{"corrected_response": str}` → 200 `{"message": ...}`.
  - `POST /api/history/{id}/dismiss` → 200 `{"message": ...}`.

- [ ] **Step 1: Add schemas** (in `schemas.py`, next to `FeedbackRequest`)

```python
class CorrectRequest(BaseModel):
    corrected_response: str


class ReviewQueueItem(BaseModel):
    id: int
    customer_name: Optional[str]
    customer_message: str
    generated_response: str
    created_at: datetime
    platform_name: Optional[str] = None
    agent_username: Optional[str] = None


class ReviewQueueResponse(BaseModel):
    count: int
    items: List[ReviewQueueItem]
```

- [ ] **Step 2: Add endpoints in history.py**

Import the new schemas in the existing `from app.schemas import ...` line. Add a guard helper near the top:

```python
def _require_superadmin(user: User) -> None:
    if not getattr(user, "is_superadmin", False):
        raise HTTPException(status_code=403, detail="Superadmin only")
```

**ROUTE ORDER MATTERS:** `GET /review-queue` must be declared **before** `GET /{history_id}` in the file, or FastAPI will match `review-queue` as a `history_id` and 422. Insert all three endpoints immediately **before** `get_history_detail`:

```python
@router.get("/review-queue", response_model=ReviewQueueResponse)
async def get_review_queue(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _require_superadmin(current_user)
    entries = (
        db.query(ResponseHistory)
        .filter(ResponseHistory.feedback == "not_useful", ResponseHistory.review_status == "pending")
        .order_by(ResponseHistory.created_at.desc())
        .limit(200)
        .all()
    )
    items = [
        ReviewQueueItem(
            id=e.id,
            customer_name=e.customer_name,
            customer_message=e.customer_message,
            generated_response=e.generated_response,
            created_at=e.created_at,
            platform_name=e.platform.name if e.platform else None,
            agent_username=e.user.username if e.user else None,
        )
        for e in entries
    ]
    return ReviewQueueResponse(count=len(items), items=items)


@router.post("/{history_id}/correct")
async def correct_response(
    history_id: int,
    request: CorrectRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _require_superadmin(current_user)
    corrected = (request.corrected_response or "").strip()
    if not corrected:
        raise HTTPException(status_code=400, detail="Corrected response cannot be empty")
    entry = db.query(ResponseHistory).filter(ResponseHistory.id == history_id).first()
    if not entry:
        raise HTTPException(status_code=404, detail="History entry not found")
    entry.corrected_response = corrected
    entry.review_status = "corrected"
    entry.feedback = "not_useful"
    _ensure_embedding(entry)
    db.commit()
    return {"message": "Correction saved"}


@router.post("/{history_id}/dismiss")
async def dismiss_response(
    history_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _require_superadmin(current_user)
    entry = db.query(ResponseHistory).filter(ResponseHistory.id == history_id).first()
    if not entry:
        raise HTTPException(status_code=404, detail="History entry not found")
    entry.review_status = "dismissed"
    db.commit()
    return {"message": "Dismissed"}
```

Note: `ResponseHistory.user` and `.platform` relationships already exist in the model. `username` — confirm the `User` model field name with `grep -n 'username' backend/app/models.py` before uploading; if the field is `username` (expected), keep as-is.

- [ ] **Step 3: Deploy + verify**

Rebuild/restart backend. Verify route order and auth:
```bash
docker exec -e PYTHONPATH=/app schn-backend-1 python3 -c "
from app.main import app
paths = [r.path for r in app.routes]
rq = [p for p in paths if 'review-queue' in p or 'correct' in p or 'dismiss' in p]
print(rq)
detail_idx = paths.index('/api/history/{history_id}')
queue_idx = paths.index('/api/history/review-queue')
print('queue before detail:', queue_idx < detail_idx)
"
```
Expected: three paths listed, `queue before detail: True`.

Then functional check via ORM (no auth token needed):
```bash
docker exec -e PYTHONPATH=/app schn-backend-1 python3 -c "
from fastapi.testclient import TestClient" 2>/dev/null || echo 'no testclient — verify via curl with a real token instead'
```
If `fastapi.testclient` is unavailable, verify with curl using a superadmin login:
`curl -s -X POST http://localhost:8000/api/auth/login -H 'Content-Type: application/json' -d '{"username":"<superadmin_user>","password":"<pass>"}'` → take token → `curl -s http://localhost:8000/api/history/review-queue -H "Authorization: Bearer $TOKEN"` → expect `{"count":0,"items":[]}` (or existing pending items). A non-superadmin token must get 403.

- [ ] **Step 4: Commit**

```bash
git add backend/app/routes/history.py backend/app/schemas.py && git commit -m "feat: review queue endpoints (list/correct/dismiss, superadmin)"
```

---

### Task 4: Backend — `/generate` returns `history_id`

**Files:**
- Modify: `/opt/schn/backend/app/schemas.py` (class `GenerateResponse`, ~line 127)
- Modify: `/opt/schn/backend/app/routes/generate.py` (all 5 `ResponseHistory` save sites)

**Interfaces:**
- Produces: `GenerateResponse.history_id: Optional[int]` — the id of the `ResponseHistory` row created for this generation. Frontend (Task 6) relies on the exact field name `history_id`.

- [ ] **Step 1: Add field to schema**

```python
class GenerateResponse(BaseModel):
    parsed: ParsedData
    response: Optional[str] = None
    next_steps: Optional[str] = None
    bot_notes: Optional[str] = None
    needs_verification: bool = False
    faq_sources: List[FAQSource] = []
    canned_sources: List[CannedSource] = []
    cache_hit: bool = False
    history_id: Optional[int] = None
```

- [ ] **Step 2: Capture the row id at every save site in generate.py**

There are **5** sites. Four early returns (resolved ~line 316, no-account ~line 360, no-subscription ~line 395, canned shortcut ~line 520) all follow this pattern — change each from:

```python
            db.add(ResponseHistory(
                ...fields...
            ))
            db.commit()
            return GenerateResponse(
                ...,
            )
```
to:
```python
            _hist = ResponseHistory(
                ...same fields...
            )
            db.add(_hist)
            db.commit()
            return GenerateResponse(
                ...,
                history_id=_hist.id,
            )
```

The final site (~line 622) adds the row before cost accounting and commits later — change `db.add(ResponseHistory(...))` to `_hist = ResponseHistory(...)` + `db.add(_hist)`, and add `history_id=_hist.id` to the final `return GenerateResponse(...)` (the `db.commit()` at line ~650 runs before that return, so `.id` is populated).

Find all sites with: `grep -n 'db.add(ResponseHistory' backend/app/routes/generate.py` — update every hit.

- [ ] **Step 3: Deploy + verify**

Rebuild/restart backend, then confirm the schema and a syntax-clean import:
```bash
docker exec -e PYTHONPATH=/app schn-backend-1 python3 -c "
from app.schemas import GenerateResponse
import app.routes.generate as g
print('history_id' in GenerateResponse.model_fields)
import inspect, re
src = inspect.getsource(g)
print('save sites converted:', src.count('_hist = ResponseHistory('), 'of', src.count('ResponseHistory('))
"
```
Expected: `True`, and `save sites converted: 5 of 5` (plus query usages don't match the paren pattern).

- [ ] **Step 4: Commit**

```bash
git add backend/app/schemas.py backend/app/routes/generate.py && git commit -m "feat: /generate returns history_id for rating"
```

---

### Task 5: Backend — few-shot learning injection in `/generate`

**Files:**
- Modify: `/opt/schn/backend/app/routes/generate.py`

**Interfaces:**
- Consumes: `query_embedding` (already computed at ~line 426), `LocalEmbeddingService.deserialize_embedding` / `.cosine_similarity`, Task 1 columns.
- Produces: module-level function `_learned_examples_block(db, embedding_service, query_embedding, platform_id) -> str` and its injection into `faq_context`.

- [ ] **Step 1: Add the retrieval helper** (module level, near `_build_agent_notes`)

```python
def _learned_examples_block(db, embedding_service, query_embedding, platform_id) -> str:
    """Top-3 rated past interactions similar to the incoming message, as a prompt block.

    Uses feedback='useful' responses and developer-corrected 'not_useful' ones
    (corrections ranked first). Fail-open: any error returns '' and /generate
    behaves exactly as without this feature.
    """
    try:
        from sqlalchemy import or_, and_
        rows = (
            db.query(ResponseHistory)
            .filter(ResponseHistory.platform_id == platform_id)
            .filter(ResponseHistory.message_embedding.isnot(None))
            .filter(or_(
                ResponseHistory.feedback == "useful",
                and_(
                    ResponseHistory.feedback == "not_useful",
                    ResponseHistory.corrected_response.isnot(None),
                    ResponseHistory.review_status == "corrected",
                ),
            ))
            .order_by(ResponseHistory.created_at.desc())
            .limit(500)
            .all()
        )
        scored = []
        for r in rows:
            emb = embedding_service.deserialize_embedding(r.message_embedding)
            sim = embedding_service.cosine_similarity(query_embedding, emb)
            if sim < 0.60:
                continue
            is_corrected = r.feedback == "not_useful"
            response_text = r.corrected_response if is_corrected else r.generated_response
            if response_text:
                scored.append((is_corrected, sim, r.customer_message, response_text))
        if not scored:
            return ""
        scored.sort(key=lambda x: (0 if x[0] else 1, -x[1]))  # corrections first, then similarity
        parts = [
            "LEARNED EXAMPLES (responses to similar past interactions, rated by the team — "
            "follow their content, decisions and style whenever they apply to this case):"
        ]
        for i, (is_corrected, sim, msg, resp) in enumerate(scored[:3], 1):
            label = "developer-corrected" if is_corrected else "rated good"
            parts.append(
                f"\n[Example {i} — {label}, similarity {sim:.2f}]\n"
                f"Customer message: {msg[:600]}\n"
                f"Good response:\n{resp}"
            )
        return "\n".join(parts)
    except Exception:
        return ""
```

- [ ] **Step 2: Inject into the prompt**

In the `generate` endpoint, right **after** the canned-responses block finishes building `faq_context` (after the `else:` branch that prepends `canned_block`, ~line 555) and **before** the `parsed_dict = {` line, insert:

```python
    # Learned examples from rated past interactions (feedback loop)
    learned_block = _learned_examples_block(db, embedding_service, query_embedding, request.platform_id)
    if learned_block:
        faq_context = (learned_block + "\n\n" + faq_context).strip()
```

- [ ] **Step 3: Deploy + verify end-to-end retrieval**

Rebuild/restart backend, then simulate: rate a synthetic entry, retrieve with a similar query:
```bash
docker exec -e PYTHONPATH=/app schn-backend-1 python3 -c "
from app.database import SessionLocal
from app.models import ResponseHistory
from app.routes.generate import _learned_examples_block
from app.routes.history import _ensure_embedding
from app.services.local_embeddings import LocalEmbeddingService
db = SessionLocal(); svc = LocalEmbeddingService()
e = ResponseHistory(user_id=1, customer_name='Test', platform_id=1,
    customer_message='I cannot log into my account, password reset email never arrives',
    parsed_data={'problem_summary': 'password reset email not arriving', 'context': ''},
    generated_response='Hi Test, please check your spam folder; I have also re-sent the reset link.')
e.feedback = 'useful'; _ensure_embedding(e)
db.add(e); db.commit()
q = svc.get_embedding('customer cannot receive password reset email')
block = _learned_examples_block(db, svc, q, 1)
print('HIT' if 'rated good' in block else 'MISS'); print(block[:300])
q2 = svc.get_embedding('totally unrelated topic about billing refunds for playoff games')
print('unrelated is empty:', _learned_examples_block(db, svc, q2, 1) == '')
db.delete(e); db.commit()  # clean up test row
"
```
Expected: `HIT`, block shows the example, and `unrelated is empty: True` (if the unrelated query still matches ≥0.60, that's a signal to raise the threshold — flag it rather than shipping silently).

- [ ] **Step 4: Commit**

```bash
git add backend/app/routes/generate.py && git commit -m "feat: inject rated examples as few-shot context in /generate"
```

---

### Task 6: Frontend — rating buttons in Generate

**Files:**
- Modify: `/opt/schn/frontend/src/pages/Generate.jsx`

**Interfaces:**
- Consumes: `response.data.history_id` (Task 4), `PATCH /history/{id}/feedback` (Task 2).

- [ ] **Step 1: Add state** (next to `generatedResponse` state, ~line 56)

```jsx
  const [historyId, setHistoryId] = useState(null)
  const [responseRating, setResponseRating] = useState(null) // 'useful' | 'not_useful' | null
```

- [ ] **Step 2: Capture history_id on every generate**

In `runGenerate` (after `setCannedSources(response.data.canned_sources || [])`, ~line 254) and in `handleRegenerate` (same spot, ~line 310), add:

```jsx
      setHistoryId(response.data.history_id || null)
      setResponseRating(null)
```

- [ ] **Step 3: Add the rate handler** (near `handleRegenerate`)

```jsx
  const rateResponse = async (value) => {
    if (!historyId) return
    const prev = responseRating
    setResponseRating(value)
    try {
      await client.patch(`/history/${historyId}/feedback`, { feedback: value })
      toast.success(value === 'useful' ? 'Rated as good response' : 'Sent to review queue')
    } catch (error) {
      setResponseRating(prev)
      toast.error('Failed to save rating')
    }
  }
```

- [ ] **Step 4: Add the buttons**

In the response card header, immediately after the Cached/Fresh badge closing `)}` (~line 1583), inside the same `flex items-center gap-2 min-w-0` div:

```jsx
                  {generatedResponse && historyId && (
                    <div className="flex items-center gap-1 ml-1">
                      <button
                        onClick={() => rateResponse('useful')}
                        title="Good response — teaches the bot to answer similar cases like this"
                        className={`px-2 py-1 rounded-md text-sm transition-colors border ${
                          responseRating === 'useful'
                            ? 'bg-green-100 border-green-400 dark:bg-green-900/40 dark:border-green-600'
                            : 'bg-transparent border-gray-200 dark:border-gray-600 opacity-60 hover:opacity-100'
                        }`}
                      >
                        👍
                      </button>
                      <button
                        onClick={() => rateResponse('not_useful')}
                        title="Bad response — sends it to the developer review queue"
                        className={`px-2 py-1 rounded-md text-sm transition-colors border ${
                          responseRating === 'not_useful'
                            ? 'bg-red-100 border-red-400 dark:bg-red-900/40 dark:border-red-600'
                            : 'bg-transparent border-gray-200 dark:border-gray-600 opacity-60 hover:opacity-100'
                        }`}
                      >
                        👎
                      </button>
                    </div>
                  )}
```

- [ ] **Step 5: Deploy + verify**

Upload, `docker compose build frontend && docker compose up -d frontend`. Verify in the app (https://the SCHN frontend URL): generate a response → 👍/👎 appear next to the Cached/Fresh badge; click 👍 → toast "Rated as good response" and button highlights; click 👎 → toast "Sent to review queue". Confirm in DB:
```bash
docker exec -e PYTHONPATH=/app schn-backend-1 python3 -c "
from app.database import SessionLocal
from app.models import ResponseHistory
db = SessionLocal()
e = db.query(ResponseHistory).order_by(ResponseHistory.id.desc()).first()
print(e.id, e.feedback, e.review_status, 'emb:', e.message_embedding is not None)
"
```

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/Generate.jsx && git commit -m "feat: rate buttons on generated response"
```

---

### Task 7: Frontend — Review Queue page + nav

**Files:**
- Create: `/opt/schn/frontend/src/pages/ReviewQueue.jsx`
- Modify: `/opt/schn/frontend/src/App.jsx` (import + route)
- Modify: `/opt/schn/frontend/src/components/Header.jsx` (`settingsLinks`, ~line 78)

**Interfaces:**
- Consumes: `GET /history/review-queue`, `POST /history/{id}/correct`, `POST /history/{id}/dismiss` (Task 3); `user?.is_superadmin` from `useAuth`.

- [ ] **Step 1: Create ReviewQueue.jsx**

```jsx
import { useState, useEffect, useCallback } from 'react'
import Layout from '../components/Layout'
import client from '../api/client'
import toast from 'react-hot-toast'

function QueueItem({ item, onDone }) {
  const [correction, setCorrection] = useState(item.generated_response)
  const [busy, setBusy] = useState(false)

  const save = async () => {
    if (!correction.trim()) { toast.error('Correction cannot be empty'); return }
    setBusy(true)
    try {
      await client.post(`/history/${item.id}/correct`, { corrected_response: correction })
      toast.success('Correction saved — the bot will learn from it')
      onDone(item.id)
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to save correction')
    } finally { setBusy(false) }
  }

  const dismiss = async () => {
    setBusy(true)
    try {
      await client.post(`/history/${item.id}/dismiss`)
      toast.success('Dismissed')
      onDone(item.id)
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to dismiss')
    } finally { setBusy(false) }
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-5 space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
        <span className="font-semibold text-gray-700 dark:text-gray-200">{item.customer_name || 'Unknown customer'}</span>
        {item.platform_name && <span className="px-2 py-0.5 rounded-full bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300">{item.platform_name}</span>}
        {item.agent_username && <span>agent: {item.agent_username}</span>}
        <span>{new Date(item.created_at).toLocaleString()}</span>
      </div>
      <div>
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Customer message</p>
        <div className="text-sm text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-700/50 rounded-md p-3 whitespace-pre-wrap max-h-48 overflow-y-auto">
          {item.customer_message}
        </div>
      </div>
      <div>
        <p className="text-xs font-semibold text-red-400 uppercase tracking-wide mb-1">Bad response — edit it into the correct one</p>
        <textarea
          value={correction}
          onChange={(e) => setCorrection(e.target.value)}
          rows={10}
          className="w-full text-sm border border-gray-200 dark:border-gray-600 rounded-lg p-3 bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-400 font-mono"
        />
      </div>
      <div className="flex justify-end gap-2">
        <button
          onClick={dismiss}
          disabled={busy}
          className="px-4 py-2 text-sm font-medium text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-40 transition-colors"
        >
          Dismiss
        </button>
        <button
          onClick={save}
          disabled={busy}
          className="px-4 py-2 text-sm font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-40 transition-colors"
        >
          Save correction
        </button>
      </div>
    </div>
  )
}

export default function ReviewQueue() {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await client.get('/history/review-queue')
      setItems(res.data.items || [])
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to load review queue')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const remove = (id) => setItems((prev) => prev.filter((i) => i.id !== id))

  return (
    <Layout>
      <div className="max-w-4xl mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-bold text-gray-800 dark:text-white">
            Review Queue {items.length > 0 && <span className="ml-1 text-sm font-semibold text-white bg-red-500 rounded-full px-2 py-0.5">{items.length}</span>}
          </h2>
          <button onClick={load} className="text-sm text-blue-600 dark:text-blue-400 hover:underline">↺ Refresh</button>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Responses rated 👎 by agents. Edit each one into the response the bot <em>should</em> have written — corrections are injected as examples when similar cases arrive.
        </p>
        {loading ? (
          <p className="text-sm text-gray-400">Loading…</p>
        ) : items.length === 0 ? (
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-8 text-center text-gray-400">
            🎉 No bad responses pending review
          </div>
        ) : (
          items.map((item) => <QueueItem key={item.id} item={item} onDone={remove} />)
        )}
      </div>
    </Layout>
  )
}
```

- [ ] **Step 2: Add route in App.jsx**

Import: `import ReviewQueue from './pages/ReviewQueue'` (after the `OpenTickets` import). Route (next to the other protected routes):

```jsx
        <Route
          path="/review-queue"
          element={
            <ProtectedRoute>
              <ReviewQueue />
            </ProtectedRoute>
          }
        />
```

- [ ] **Step 3: Add nav entry in Header.jsx**

In `settingsLinks` (~line 78) — this array renders in the desktop settings dropdown AND the burger menu's Settings section, which is where the user wants it:

```jsx
  const settingsLinks = [
    { to: '/profile', label: 'Profile' },
    ...(isAdmin ? [
      { to: '/faqs', label: 'FAQs' },
      { to: '/users', label: 'Users' },
    ] : []),
    ...(isAdmin && user?.is_superadmin ? [
      { to: '/review-queue', label: 'Review Queue' },
    ] : []),
  ]
```

- [ ] **Step 4: Deploy + verify**

Upload the 3 files, rebuild/restart frontend. In the app as superadmin: "Review Queue" appears in the settings/burger menu; page loads; a 👎-rated response from Task 6 shows up; edit the textarea → Save correction → item disappears with success toast. As a normal agent: no menu entry, and direct navigation to `/review-queue` shows the load error (403). Confirm in DB:
```bash
docker exec -e PYTHONPATH=/app schn-backend-1 python3 -c "
from app.database import SessionLocal
from app.models import ResponseHistory
db = SessionLocal()
e = db.query(ResponseHistory).filter(ResponseHistory.review_status == 'corrected').order_by(ResponseHistory.id.desc()).first()
print(e.id if e else None, (e.corrected_response or '')[:80] if e else '')
"
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/ReviewQueue.jsx frontend/src/App.jsx frontend/src/components/Header.jsx && git commit -m "feat: review queue page for correcting bad responses (superadmin)"
```

---

### Task 8: Full E2E verification + push

**Files:** none (verification only)

- [ ] **Step 1: Learning round-trip through the real `/generate` endpoint**

Using the corrected entry from Task 7 (or create one: rate 👎 a generated response about a distinctive topic, correct it in the queue with a recognizably different response), call `/generate` from the UI with a **similar** customer message. Verify:
1. The new response reflects the correction's content/decisions.
2. Backend log or a temporary check confirms injection — run:
```bash
docker exec -e PYTHONPATH=/app schn-backend-1 python3 -c "
from app.database import SessionLocal
from app.services.local_embeddings import LocalEmbeddingService
from app.routes.generate import _learned_examples_block
db = SessionLocal(); svc = LocalEmbeddingService()
q = svc.get_embedding('<the similar test message>')
print(_learned_examples_block(db, svc, q, <platform_id>)[:400])
"
```
Expected: block contains the correction labeled `developer-corrected`.

- [ ] **Step 2: Neutral-path check (no ratings → identical behavior)**

Send a message on a platform with no rated entries. Expect: response generates normally, `_learned_examples_block` returns `''` for it, no errors in `docker logs schn-backend-1 --since 5m`.

- [ ] **Step 3: Persistence check**

Confirm rated entries survive cleanup:
```bash
docker exec -e PYTHONPATH=/app schn-backend-1 python3 -c "
from app.database import SessionLocal
from app.routes.history import _cleanup_old_history
from app.models import ResponseHistory
db = SessionLocal()
rated_before = db.query(ResponseHistory).filter(ResponseHistory.feedback.isnot(None)).count()
# cleanup for every user with rated entries
for (uid,) in db.query(ResponseHistory.user_id).filter(ResponseHistory.feedback.isnot(None)).distinct():
    _cleanup_old_history(uid, db)
rated_after = db.query(ResponseHistory).filter(ResponseHistory.feedback.isnot(None)).count()
print('rated survived cleanup:', rated_before == rated_after, rated_before)
"
```
Expected: `True`.

- [ ] **Step 4: Push everything**

```bash
cd /opt/schn && git push origin main
```
Expected: all task commits (plus the spec/plan docs) land on GitHub.
