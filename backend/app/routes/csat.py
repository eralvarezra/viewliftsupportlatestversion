"""CSAT analysis — classify dissatisfaction tickets as controllable or not,
grounded in the loaded FAQ knowledge base (our "policies")."""
import csv
import io
import json
import re
from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth.routes import get_current_user, require_admin
from app.database import get_db
from app.models import User, FAQDocument, FAQChunk
from app.services.claude_client import ClaudeClient
from app.services.local_embeddings import LocalEmbeddingService

router = APIRouter()

# Group / company name keyword -> platform id (for picking the right FAQ set)
_NAME_TO_PLATFORM = {
    "schn": 1, "my view": 1, "space city": 1,
    "liv": 2, "livgolf": 2,
    "altitude": 3,
    "monumental": 4, "msn": 4, "lnp": 4,
    "tbl": 5, "lightning": 5, "tampa": 5,
    "fox": 6,
    "knight": 7, "vgk": 7, "vegas": 7,
    "motv": 8,
    "dirtvision": 10, "dirt": 10,
}

_NEG_RATING_KW = [
    "unhappy", "dissatisf", "negative", "not happy", "not satisfied",
    "poor", "bad", "angry", "frustrat", "terrible", "awful", "1 star", "one star",
]
_POS_RATING_KW = [
    "extremely happy", "very happy", "happy", "satisf", "positive",
    "good", "great", "excellent", "neutral",
]


def _is_dissatisfied(rating: str) -> bool:
    r = (rating or "").strip().lower()
    if not r:
        return False
    # Numeric: Freshdesk uses negative codes (-101/-102/-103) for unhappy.
    try:
        n = float(r)
        return n < 0
    except ValueError:
        pass
    if any(k in r for k in _NEG_RATING_KW):
        return True
    # Explicitly positive/neutral -> satisfied
    if any(k in r for k in _POS_RATING_KW):
        return False
    return False


def _platform_for(group: str, company: str) -> int:
    blob = f"{group} {company}".lower()
    for kw, pid in _NAME_TO_PLATFORM.items():
        if kw in blob:
            return pid
    return None


def _col(row: dict, *names):
    """Case/space-insensitive column getter."""
    norm = {re.sub(r"[^a-z0-9]", "", k.lower()): v for k, v in row.items()}
    for n in names:
        key = re.sub(r"[^a-z0-9]", "", n.lower())
        if key in norm:
            return (norm[key] or "").strip()
    return ""


class CsatAnalyzeRequest(BaseModel):
    csv_text: str


@router.post("/analyze")
def analyze_csat(
    req: CsatAnalyzeRequest,
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    text = req.csv_text or ""
    if not text.strip():
        raise HTTPException(status_code=400, detail="Empty CSV")

    # Parse CSV (handle BOM + varying delimiters)
    sample = text[:2000]
    delim = "\t" if sample.count("\t") > sample.count(",") else ","
    reader = csv.DictReader(io.StringIO(text.lstrip("﻿")), delimiter=delim)
    rows = list(reader)
    if not rows:
        raise HTTPException(status_code=400, detail="No rows found in CSV")

    # Collect distinct ratings (for transparency) and filter dissatisfaction
    ratings_seen = {}
    dissatisfied = []
    for row in rows:
        rating = _col(row, "Rating")
        ratings_seen[rating] = ratings_seen.get(rating, 0) + 1
        if _is_dissatisfied(rating):
            dissatisfied.append({
                "ticket_id": _col(row, "Ticket Id", "TicketId", "Ticket ID", "id"),
                "rating": rating,
                "comment": _col(row, "Comment", "Feedback"),
                "requester": _col(row, "Requester Name", "Requester"),
                "email": _col(row, "Requester Email", "Email"),
                "company": _col(row, "Company"),
                "group": _col(row, "Group"),
                "agent": _col(row, "Agent"),
                "received": _col(row, "Survey Received Time", "Received Time", "Time"),
            })

    if not dissatisfied:
        return {
            "total_rows": len(rows),
            "dissatisfied_count": 0,
            "ratings_seen": ratings_seen,
            "results": [],
            "summary": {"controllable": 0, "not_controllable": 0},
        }

    dissatisfied = dissatisfied[:200]  # safety cap

    embedding_service = LocalEmbeddingService()
    claude = ClaudeClient()

    # Phase 1 (sequential — DB access is not thread-safe): resolve platform and
    # build FAQ context per ticket. Chunks are loaded once per platform.
    _chunk_cache = {}

    def _chunks_for(pid: int):
        if pid in _chunk_cache:
            return _chunk_cache[pid]
        doc_ids = [d.id for d in db.query(FAQDocument.id).filter(
            FAQDocument.document_type == "faq", FAQDocument.platform_id == pid).all()]
        chunks = db.query(FAQChunk).filter(
            FAQChunk.embedding.isnot(None),
            FAQChunk.document_id.in_(doc_ids)).all() if doc_ids else []
        data = [(c.id, c.content, c.embedding) for c in chunks]
        _chunk_cache[pid] = data
        return data

    for t in dissatisfied:
        pid = _platform_for(t["group"], t["company"])
        t["_pid"] = pid
        faq = ""
        if t["comment"] and pid:
            chunk_data = _chunks_for(pid)
            if chunk_data:
                qemb = embedding_service.get_embedding(t["comment"])
                similar = embedding_service.find_similar_chunks(
                    query_embedding=qemb, chunks_with_embeddings=chunk_data,
                    top_k=5, min_similarity=0.25,
                )
                faq = "\n\n".join(content for _, content, _ in similar)
        t["_faq"] = faq

    # Phase 2 (parallel — no DB, only Claude API calls)
    def _judge(t: dict) -> dict:
        pid = t["_pid"]
        faq = t["_faq"]
        platform_name = t["group"] or t["company"] or "the service"
        prompt = (
            f"You are a QA analyst for {platform_name} customer support. A customer left a "
            f"NEGATIVE satisfaction rating. Using ONLY our support knowledge base (FAQ) below, "
            f"decide whether this dissatisfaction was CONTROLLABLE by our support team.\n\n"
            f"CONTROLLABLE = support could have prevented or resolved it: the FAQ shows a correct "
            f"answer/solution the agent should have provided, or it was about agent handling "
            f"(wrong info, slow reply, tone, missed documented steps).\n"
            f"NOT CONTROLLABLE = outside support's control per our knowledge base: product/content "
            f"limitations, third-party or billing issues we don't manage, customer error/device "
            f"issue, or a policy we correctly enforced.\n\n"
            f"FAQ KNOWLEDGE BASE:\n{faq or '(no relevant FAQ found)'}\n\n"
            f"CUSTOMER COMMENT: {t['comment'] or '(no comment left)'}\n"
            f"AGENT: {t['agent']}\n\n"
            'Respond ONLY with JSON: {"controllable": "yes" or "no", "explanation": '
            '"1-2 sentences with the reason, grounded in the FAQ/handling"}'
        )
        controllable, explanation = "unknown", ""
        try:
            resp = claude.client.messages.create(
                model=claude.PARSE_MODEL,  # Haiku — cheap classification with context
                max_tokens=300,
                messages=[{"role": "user", "content": prompt}],
            )
            raw = resp.content[0].text.strip()
            m = re.search(r"\{.*\}", raw, re.DOTALL)
            if m:
                data = json.loads(m.group(0))
                controllable = (data.get("controllable") or "unknown").strip().lower()
                explanation = (data.get("explanation") or "").strip()
        except Exception as e:
            explanation = f"analysis error: {str(e)[:80]}"
        out = {k: v for k, v in t.items() if not k.startswith("_")}
        out.update({"controllable": controllable, "explanation": explanation, "platform_id": pid})
        return out

    results = []
    with ThreadPoolExecutor(max_workers=5) as pool:
        results = list(pool.map(_judge, dissatisfied))

    controllable_n = sum(1 for r in results if r["controllable"] == "yes")
    not_controllable_n = sum(1 for r in results if r["controllable"] == "no")

    return {
        "total_rows": len(rows),
        "dissatisfied_count": len(results),
        "ratings_seen": ratings_seen,
        "results": results,
        "summary": {
            "controllable": controllable_n,
            "not_controllable": not_controllable_n,
            "unknown": len(results) - controllable_n - not_controllable_n,
        },
    }
