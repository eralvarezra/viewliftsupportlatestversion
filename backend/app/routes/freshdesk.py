import math
import requests
from fastapi import APIRouter, Depends, HTTPException
from app.auth.routes import get_current_user
from app.database import get_db
from sqlalchemy.orm import Session
from app.models import User
from app.config import settings

router = APIRouter()

FRESHDESK_BASE = f"https://{settings.FRESHDESK_DOMAIN}/api/v2"
FRESHDESK_AUTH = (settings.FRESHDESK_API_KEY, "X")

STATUS_MAP = {2: "Open", 3: "Pending", 4: "Resolved", 5: "Closed", 6: "Waiting on Customer", 7: "Waiting on Third Party"}
PRIORITY_MAP = {1: "Low", 2: "Medium", 3: "High", 4: "Urgent"}


def _rate_limit_error(r) -> HTTPException:
    retry_after = r.headers.get("Retry-After")
    if retry_after:
        try:
            seconds = int(retry_after)
            minutes = math.ceil(seconds / 60)
            msg = f"Freshdesk rate limit reached. Try again in {minutes} minute{'s' if minutes != 1 else ''}."
        except ValueError:
            msg = f"Freshdesk rate limit reached. Try again after {retry_after}."
    else:
        msg = "Freshdesk rate limit reached, try again later."
    return HTTPException(status_code=429, detail=msg)


def _build_full_thread(ticket: dict, conversations: list) -> str:
    """Build a formatted message thread similar to manual paste format."""
    requester_name = ticket.get("requester", {}).get("name", "Customer")
    requester_email = ticket.get("requester", {}).get("email", "")
    company = ticket.get("company", {}).get("name") if ticket.get("company") else None
    subject = ticket.get("subject", "")
    status = STATUS_MAP.get(ticket.get("status"), str(ticket.get("status")))
    tags = ticket.get("tags", [])

    lines = []

    # Header
    lines.append(f"[Ticket #{ticket['id']}] {subject}")
    lines.append(f"Status: {status} | Priority: {PRIORITY_MAP.get(ticket.get('priority'), '')}")
    if company:
        lines.append(f"Client: {company}")
    lines.append(f"From: {requester_name} ({requester_email})")
    if tags:
        lines.append(f"Tags: {', '.join(tags)}")
    lines.append("")

    # Original message
    lines.append("[Customer - Original Message]")
    lines.append(ticket.get("description_text", "").strip())
    lines.append("")

    # Conversations (replies and notes)
    for conv in conversations:
        if conv.get("private"):
            continue
        is_incoming = conv.get("incoming", False)
        body = conv.get("body_text", "").strip()
        if not body:
            continue

        if is_incoming:
            lines.append(f"[Customer Reply]")
        else:
            lines.append(f"[Agent Reply]")

        lines.append(body)
        lines.append("")

    return "\n".join(lines)



@router.get("/agents")
async def list_agents_with_fd_key(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Return all active users who have a Freshdesk API key configured."""
    from app.models import User as UserModel
    users = db.query(UserModel).filter(
        UserModel.freshdesk_api_key.isnot(None),
        UserModel.freshdesk_api_key != "",
        UserModel.status != "inactive",
        UserModel.id != current_user.id,
    ).order_by(UserModel.username).all()
    return [{"id": u.id, "username": u.username, "email": u.email} for u in users]

@router.get("/ticket/{ticket_id}")
async def get_freshdesk_ticket(
    ticket_id: int,
    current_user: User = Depends(get_current_user),
):
    auth = (current_user.freshdesk_api_key, "X") if current_user.freshdesk_api_key else FRESHDESK_AUTH

    r = requests.get(
        f"{FRESHDESK_BASE}/tickets/{ticket_id}?include=requester,company",
        auth=auth,
        timeout=10,
    )
    if r.status_code == 404:
        raise HTTPException(status_code=404, detail="Ticket not found")
    if r.status_code == 429:
        raise _rate_limit_error(r)
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Freshdesk returned {r.status_code}")

    t = r.json()

    conv_r = requests.get(
        f"{FRESHDESK_BASE}/tickets/{ticket_id}/conversations",
        auth=auth,
        timeout=10,
    )
    conversations = conv_r.json() if conv_r.status_code == 200 else []

    full_thread = _build_full_thread(t, conversations)

    rl_remaining = r.headers.get("X-RateLimit-Remaining")
    rl_total = r.headers.get("X-RateLimit-Total")

    return {
        "id": t["id"],
        "subject": t.get("subject", ""),
        "description": t.get("description_text", ""),
        "full_thread": full_thread,
        "status": STATUS_MAP.get(t.get("status"), str(t.get("status"))),
        "priority": PRIORITY_MAP.get(t.get("priority"), str(t.get("priority"))),
        "type": t.get("type"),
        "tags": t.get("tags", []),
        "requester_name": t.get("requester", {}).get("name"),
        "requester_email": t.get("requester", {}).get("email"),
        "company": t.get("company", {}).get("name") if t.get("company") else None,
        "url": f"https://{settings.FRESHDESK_DOMAIN}/a/tickets/{t['id']}",
        "group_id": t.get("group_id"),
        "client_name": (t.get("custom_fields") or {}).get("cf_b2b_client_name"),
        "conversation_count": len(conversations),
        "rate_limit_remaining": int(float(rl_remaining)) if rl_remaining else None,
        "rate_limit_total": int(float(rl_total)) if rl_total else 5000,
    }


@router.get("/tracker/{tracker_id}")
async def get_tracker_details(
    tracker_id: int,
    current_user: User = Depends(get_current_user),
):
    auth = (current_user.freshdesk_api_key, "X") if current_user.freshdesk_api_key else FRESHDESK_AUTH

    r = requests.get(f"{FRESHDESK_BASE}/tickets/{tracker_id}", auth=auth, timeout=10)
    if r.status_code == 404:
        raise HTTPException(status_code=404, detail="Tracker not found")
    if r.status_code == 429:
        raise _rate_limit_error(r)
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Freshdesk returned {r.status_code}")

    t = r.json()

    conv_r = requests.get(f"{FRESHDESK_BASE}/tickets/{tracker_id}/conversations", auth=auth, timeout=10)
    conversations = conv_r.json() if conv_r.status_code == 200 else []

    latest_note = None
    for c in reversed(conversations):
        body = c.get("body_text", "").strip()
        if not body:
            continue
        latest_note = {
            "body": body[:500],
            "is_private": c.get("private", False),
            "created_at": c.get("created_at", ""),
            "incoming": c.get("incoming", False),
        }
        break

    TRACKER_STATUS_MAP = {2: "Open", 3: "Pending", 4: "Resolved", 5: "Closed", 6: "Waiting on Customer", 7: "Waiting on Third Party", 13: "Ready for Production"}

    return {
        "tracker_id": tracker_id,
        "subject": t.get("subject", f"Tracker #{tracker_id}"),
        "status": TRACKER_STATUS_MAP.get(t.get("status"), str(t.get("status"))),
        "tags": t.get("tags", []),
        "total_linked": len(t.get("associated_tickets_list", [])),
        "all_linked_ids": t.get("associated_tickets_list", []),
        "latest_note": latest_note,
    }


@router.get("/status")
async def get_freshdesk_status(
    current_user: User = Depends(get_current_user),
):
    """Quick check: is the Freshdesk API available and how many calls remain?"""
    auth = (current_user.freshdesk_api_key, "X") if current_user.freshdesk_api_key else FRESHDESK_AUTH
    try:
        r = requests.get(
            f"{FRESHDESK_BASE}/tickets?per_page=1",
            auth=auth,
            timeout=8,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail="Could not reach Freshdesk API")

    rl_remaining = r.headers.get("X-RateLimit-Remaining")
    rl_total = r.headers.get("X-RateLimit-Total")
    retry_after = r.headers.get("Retry-After")

    if r.status_code == 429:
        wait_seconds = None
        wait_str = "try again later"
        if retry_after:
            try:
                wait_seconds = int(retry_after)
                minutes = math.ceil(wait_seconds / 60)
                wait_str = f"in {minutes} minute{'s' if minutes != 1 else ''}"
            except ValueError:
                wait_str = f"after {retry_after}"
        return {
            "status": "rate_limited",
            "remaining": 0,
            "total": int(float(rl_total)) if rl_total else 5000,
            "retry_after_seconds": wait_seconds,
            "message": f"Freshdesk API rate limit reached — try again {wait_str}.",
        }

    return {
        "status": "ok",
        "remaining": int(float(rl_remaining)) if rl_remaining else None,
        "total": int(float(rl_total)) if rl_total else 5000,
        "retry_after_seconds": None,
        "message": None,
    }

# ── Bot-maintained ticket summary ────────────────────────────────────────────
# Invisible zero-width marker appended to summaries the bot writes, so it can
# recognize its own summary and keep updating it — while NEVER touching a
# summary a human wrote (no marker → skip).
BOT_SUMMARY_MARKER = "\u200b\u200d\u200b\u200d\u200b"  # ZWSP+ZWJ sequence, invisible when rendered


def _upsert_ticket_summary(ticket_id: int, auth, problem_summary: str, reply_text: str) -> str:
    """Create/update the Freshdesk ticket summary. Best-effort: never raises."""
    try:
        r = requests.get(f"{FRESHDESK_BASE}/tickets/{ticket_id}/summary", auth=auth, timeout=10)
        if r.status_code == 200:
            existing = r.json() or {}
            existing_text = (existing.get("body") or "") + (existing.get("body_text") or "")
            if BOT_SUMMARY_MARKER not in existing_text:
                return "skipped_human"  # a person wrote it — never touch
        elif r.status_code != 404:  # 404 = no summary yet → create
            return f"error_get_{r.status_code}"

        import re as _re
        from app.services.claude_client import ClaudeClient
        plain_reply = _re.sub(r"<[^>]+>", " ", reply_text or "")[:1500]
        claude = ClaudeClient()
        msg = claude.client.messages.create(
            model=ClaudeClient.PARSE_MODEL,
            max_tokens=300,
            temperature=0.2,
            messages=[{
                "role": "user",
                "content": (
                    "Write a support-ticket summary in 3-4 short plain-text lines: "
                    "(1) the customer's issue, (2) current state of the case, "
                    "(3) latest action taken by support. No greeting, no markdown, "
                    "no field labels — just the summary text.\n\n"
                    f"Customer issue: {problem_summary or '(derive it from the reply below)'}\n\n"
                    f"Latest support reply sent to the customer:\n{plain_reply}"
                ),
            }],
        )
        summary_text = msg.content[0].text.strip()
        body_html = summary_text.replace("\n", "<br>") + BOT_SUMMARY_MARKER
        pr = requests.put(
            f"{FRESHDESK_BASE}/tickets/{ticket_id}/summary",
            auth=auth,
            json={"body": body_html},
            timeout=10,
        )
        if pr.status_code in (200, 201):
            return "updated" if r.status_code == 200 else "created"
        return f"error_put_{pr.status_code}"
    except Exception as e:
        return f"error_{type(e).__name__}"


@router.post("/ticket/{ticket_id}/reply")
async def post_freshdesk_reply(
    ticket_id: int,
    payload: dict,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Post a public reply to a Freshdesk ticket, optionally with image attachments."""
    import base64 as b64lib
    cover_user_id = payload.get("cover_user_id")
    if cover_user_id and current_user.role == "admin":
        from app.models import User as UserModel
        cover_user = db.query(UserModel).filter(UserModel.id == cover_user_id).first()
        fd_key = cover_user.freshdesk_api_key if cover_user else None
    else:
        fd_key = current_user.freshdesk_api_key
    auth = (fd_key, "X") if fd_key else FRESHDESK_AUTH
    body_text = payload.get("body", "")
    # Always convert newlines to <br> for HTML email (works for both plain and HTML with <strong>)
    body_html = body_text.replace('\n', '<br>')
    images = payload.get("images") or []

    if images:
        files = [("body", (None, body_html))]
        for i, img in enumerate(images):
            raw = b64lib.b64decode(img["base64"])
            mime = img.get("media_type", "image/png")
            ext = mime.split("/")[-1]
            files.append(("attachments[]", (f"screenshot_{i+1}.{ext}", raw, mime)))
        r = requests.post(
            f"{FRESHDESK_BASE}/tickets/{ticket_id}/reply",
            auth=auth,
            files=files,
            timeout=30,
        )
    else:
        r = requests.post(
            f"{FRESHDESK_BASE}/tickets/{ticket_id}/reply",
            auth=auth,
            json={"body": body_html},
            timeout=10,
        )
    if r.status_code == 429:
        raise _rate_limit_error(r)
    if r.status_code not in (200, 201):
        raise HTTPException(status_code=502, detail=f"Freshdesk returned {r.status_code}: {r.text[:200]}")

    # Optional bot-maintained ticket summary (agent toggle). Best-effort: a
    # summary failure never fails the reply that was already sent.
    summary_status = None
    if payload.get("update_summary"):
        summary_status = _upsert_ticket_summary(
            ticket_id,
            auth,
            problem_summary=payload.get("problem_summary") or "",
            reply_text=body_html,
        )
    return {"ok": True, "summary": summary_status}

@router.post("/ticket/{ticket_id}/note")
async def post_freshdesk_note(
    ticket_id: int,
    payload: dict,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    import base64 as b64lib
    cover_user_id = payload.get("cover_user_id")
    if cover_user_id and current_user.role == "admin":
        from app.models import User as UserModel
        cover_user = db.query(UserModel).filter(UserModel.id == cover_user_id).first()
        fd_key = cover_user.freshdesk_api_key if cover_user else None
    else:
        fd_key = current_user.freshdesk_api_key
    auth = (fd_key, 'X') if fd_key else FRESHDESK_AUTH
    body_text = payload.get('body', '')
    # If body already contains HTML tags, use as-is; otherwise convert newlines
    body_html = body_text if '<' in body_text else '<br>'.join(body_text.splitlines())
    images = payload.get('images') or []
    if images:
        files = [('body', (None, body_html)), ('private', (None, 'true'))]
        for i, img in enumerate(images):
            raw = b64lib.b64decode(img['base64'])
            mime = img.get('media_type', 'image/png')
            ext = mime.split('/')[-1]
            files.append(('attachments[]', (f'screenshot_{i+1}.{ext}', raw, mime)))
        r = requests.post(f'{FRESHDESK_BASE}/tickets/{ticket_id}/notes', auth=auth, files=files, timeout=30)
    else:
        r = requests.post(
            f'{FRESHDESK_BASE}/tickets/{ticket_id}/notes',
            auth=auth,
            json={'body': body_html, 'private': True},
            timeout=10,
        )
    if r.status_code == 429:
        raise _rate_limit_error(r)
    if r.status_code not in (200, 201):
        raise HTTPException(status_code=502, detail=f'Freshdesk returned {r.status_code}: {r.text[:200]}')
    return {'ok': True}

@router.put('/ticket/{ticket_id}/status')
async def update_ticket_status(
    ticket_id: int,
    payload: dict,
    current_user: User = Depends(get_current_user),
):
    import time as _time
    update_data = {'status': payload.get('status')}
    if payload.get('type'):
        update_data['type'] = payload.get('type')
    # Freshdesk intermittently returns 5xx when a status change lands right after
    # a reply/note write to the same ticket. Retry a few times with backoff.
    last = None
    for _attempt in range(4):
        r = requests.put(
            f'{FRESHDESK_BASE}/tickets/{ticket_id}',
            auth=FRESHDESK_AUTH,
            json=update_data,
            timeout=10,
        )
        if r.status_code == 429:
            raise _rate_limit_error(r)
        if r.status_code in (200, 201):
            return {'ok': True}
        last = r
        if 500 <= r.status_code < 600:
            _time.sleep(1.5 * (_attempt + 1))
            continue
        break
    raise HTTPException(
        status_code=502,
        detail=f'Freshdesk returned {last.status_code if last else "?"}: {last.text[:200] if last else ""}',
    )


@router.get("/open-tickets")
async def get_open_tickets(
    current_user: User = Depends(get_current_user),
):
    import re
    import html
    from concurrent.futures import ThreadPoolExecutor, as_completed

    # group_id -> display label
    # Multiple group IDs can share a label to combine them into one column
    GROUPS = {
        43000664192: "Altitude",
        43000662781: "DirtVision",
        43000663267: "Fox One",
        43000663021: "LivGolf",
        43000663122: "Monumental + MSN",
        43000663120: "Monumental + MSN",  # LNP Support
        43000666076: "SCHN + My View",
        43000665558: "Tampa TBL",
        43000663123: "VGK",              # KnightTime+ = Vegas Golden Knights
    }

    STATUS_LABELS = {
        2: "Open",
        12: "Waiting on L1",
    }
    TARGET_STATUSES = [2, 12]

    result = {name: [] for name in GROUPS.values()}
    result["Other"] = []
    seen_ids = set()
    all_tickets = []

    for status_id in TARGET_STATUSES:
        for group_id, platform in GROUPS.items():
            query = f"status:{status_id} AND group_id:{group_id}"
            page = 1
            while True:
                r = requests.get(
                    f"{FRESHDESK_BASE}/search/tickets",
                    auth=FRESHDESK_AUTH,
                    params={"query": f'"{query}"', "page": page},
                    timeout=15,
                )
                if r.status_code != 200:
                    break
                data = r.json()
                tickets = data.get("results", [])
                if not tickets:
                    break
                for t in tickets:
                    tid = t.get("id")
                    if tid in seen_ids:
                        continue
                    seen_ids.add(tid)
                    ticket_obj = {
                        "id": tid,
                        "subject": t.get("subject", ""),
                        "status": t.get("status"),
                        "status_label": STATUS_LABELS.get(t.get("status"), f"Status {t.get('status')}"),
                        "priority": t.get("priority", 1),
                        "tags": t.get("tags") or [],
                        "updated_at": t.get("updated_at"),
                        "created_at": t.get("created_at"),
                        "url": f"https://{settings.FRESHDESK_DOMAIN}/a/tickets/{tid}",
                        "possible_last_response": False,
                        "last_customer_message": "",
                    }
                    result[platform].append(ticket_obj)
                    all_tickets.append(ticket_obj)
                if len(tickets) < 30 or page >= 10:
                    break
                page += 1

    def fetch_last_customer_msg(ticket):
        try:
            cr = requests.get(
                f"{FRESHDESK_BASE}/tickets/{ticket['id']}/conversations",
                auth=FRESHDESK_AUTH,
                timeout=10,
            )
            if cr.status_code != 200:
                return
            convs = cr.json()
            if not isinstance(convs, list):
                return
            for conv in reversed(convs):
                if conv.get("incoming") and not conv.get("private"):
                    raw = conv.get("body_text") or re.sub(r'<[^>]+>', ' ', conv.get("body", ""))
                    msg = html.unescape(raw).strip()
                    msg = re.sub(r'\s+', ' ', msg)[:200]
                    ticket["possible_last_response"] = True
                    ticket["last_customer_message"] = msg
                    return
        except Exception:
            pass

    with ThreadPoolExecutor(max_workers=20) as pool:
        list(pool.map(fetch_last_customer_msg, all_tickets))

    return result


B2C_AGENTS = [
    {"name": "Adrian Fernandez", "fd_id": 43272422609},
    {"name": "Erick Ramirez",    "fd_id": 43272876537},
    {"name": "Esteban Alvarez",  "fd_id": 43272242611},
    {"name": "Gerald Calero",    "fd_id": 43264559519},
    {"name": "Jo Anne Fernando", "fd_id": 43234036343},
    {"name": "Josue Valverde",   "fd_id": 43270507065},
    {"name": "Sebastian Grant",  "fd_id": 43273665087},
    {"name": "Vernon Raude",     "fd_id": 43265202506},
    {"name": "Walter Ruiz",      "fd_id": 43271038673},
]


@router.post("/ticket/{ticket_id}/requester")
async def update_ticket_requester(
    ticket_id: int,
    payload: dict,
    current_user: User = Depends(get_current_user),
):
    """Update the ticket requester to the real end user (find or create the contact)."""
    name = (payload.get("name") or "").strip()
    email = (payload.get("email") or "").strip().lower()
    if not name or not email:
        raise HTTPException(status_code=400, detail="Name and email are required")

    def _search_contact():
        r = requests.get(
            f"{FRESHDESK_BASE}/contacts",
            auth=FRESHDESK_AUTH,
            params={"email": email},
            timeout=15,
        )
        if r.status_code == 429:
            raise _rate_limit_error(r)
        if r.status_code == 200 and isinstance(r.json(), list) and r.json():
            return r.json()[0]["id"]
        return None

    contact_id = _search_contact()

    if not contact_id:
        cr = requests.post(
            f"{FRESHDESK_BASE}/contacts",
            auth=FRESHDESK_AUTH,
            json={"name": name, "email": email},
            timeout=15,
        )
        if cr.status_code == 429:
            raise _rate_limit_error(cr)
        if cr.status_code in (200, 201):
            contact_id = cr.json().get("id")
        elif cr.status_code == 409:
            # Contact already exists (possibly agent or secondary email) - search again
            contact_id = _search_contact()
        if not contact_id:
            raise HTTPException(
                status_code=502,
                detail=f"Could not find or create the Freshdesk contact: {cr.text[:150]}",
            )

    ur = requests.put(
        f"{FRESHDESK_BASE}/tickets/{ticket_id}",
        auth=FRESHDESK_AUTH,
        json={"requester_id": contact_id},
        timeout=15,
    )
    if ur.status_code == 429:
        raise _rate_limit_error(ur)
    if ur.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"Freshdesk ticket update failed: {ur.text[:150]}",
        )
    return {"ok": True, "contact_id": contact_id}


_POOL_CACHE = {"data": None, "ts": 0.0}
_PRESENCE = {}  # user_id -> {"name": str, "ts": float} — active Full Automated admins
CLAIM_TTL_MIN = 10

def _scan_eligible_pool(max_age_hours: int = 5, force: bool = False):
    """Scan SCHN / Monumental / DirtVision for eligible tickets (Open or Waiting
    on L1) whose latest CUSTOMER message arrived within `max_age_hours`. Cached
    60s in-memory (single uvicorn worker) so concurrent admins share one scan."""
    import time as _time
    _nowts = _time.time()
    if not force and _POOL_CACHE["data"] is not None and (_nowts - _POOL_CACHE["ts"]) < 60:
        return _POOL_CACHE["data"]
    from datetime import datetime, timezone, timedelta
    from concurrent.futures import ThreadPoolExecutor
    import re
    import html

    GROUPS = {
        43000666076: "SCHN+",
        43000663122: "Monumental Sports",
        43000663120: "Monumental Sports",
        43000662781: "DirtVision",
        43000664192: "Altitude Sports",
    }
    STATUSES = [2, 15]  # Open, Waiting on L1

    # Tickets involving these domains never get an auto-response — manual only.
    BLOCKED_DOMAINS = ["@livgolf.com"]

    REFUND_KW = [
        "refund", "reembolso", "money back", "chargeback", "charge back",
        "cancel", "cancelation", "cancellation", "cancelaci", "unsubscribe",
        "cancelar", "reimburse", "dispute",
    ]

    # Marketing / non-support subject signals (fallback when Freshdesk did not
    # already classify the ticket type as spam/auto-reply).
    SPAM_SUBJECT_KW = [
        "sponsorship", "newsletter", "webinar", "press release",
        "partnership opportunity", "advertis", "guest post", "backlink",
        "ceo update", "quarterly update", "promo code", "limited time offer",
        "act now", "exclusive offer", "boost your", "grow your", "seo audit",
        "link building", "collaboration opportunity", "invoice attached",
        "wire transfer", "out of office", "automatic reply", "auto-reply",
        "delivery status notification", "undeliverable",
        # Web-design / dev / marketing agency solicitations
        "website upgrade", "website redesign", "web design", "website design",
        "wordpress", "logo design", "ui/ux", "e-commerce website",
        "we specialize in", "see our portfolio", "our portfolio",
        "digital marketing", "seo services", "mobile app development",
        "design and development company", "increase your sales",
        "rank your website", "lead generation service",
    ]

    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=max_age_hours)
    since_date = (now - timedelta(hours=max_age_hours) - timedelta(days=1)).strftime("%Y-%m-%d")

    def fd_search(query, page=1):
        for _ in range(3):
            r = requests.get(
                f"{FRESHDESK_BASE}/search/tickets", auth=FRESHDESK_AUTH,
                params={"query": f'"{query}"', "page": page}, timeout=15,
            )
            if r.status_code == 429:
                import time as _t
                _t.sleep(min(int(r.headers.get("Retry-After", "5")), 20))
                continue
            if r.status_code == 200:
                return r.json().get("results", [])
            break
        return []

    candidates = {}
    for status_id in STATUSES:
        for gid, label in GROUPS.items():
            page = 1
            while True:
                q = f"status:{status_id} AND group_id:{gid} AND updated_at:>'{since_date}'"
                results = fd_search(q, page)
                if not results:
                    break
                for t in results:
                    candidates[t["id"]] = (t, label)
                if len(results) < 30 or page >= 5:
                    break
                page += 1

    def analyze(item):
        t, label = item
        tid = t["id"]
        # One call gives us BOTH the original description and the reply thread,
        # so refund/cancel/spam wording in the body (not just the subject) is seen.
        try:
            cr = requests.get(
                f"{FRESHDESK_BASE}/tickets/{tid}?include=conversations,requester",
                auth=FRESHDESK_AUTH, timeout=10,
            )
            data = cr.json() if cr.status_code == 200 else {}
        except Exception:
            data = {}
        convs = data.get("conversations", []) if isinstance(data, dict) else []
        raw_desc = data.get("description_text") or re.sub(r"<[^>]+>", " ", data.get("description", "") or "")
        description = re.sub(r"\s+", " ", html.unescape(raw_desc)).strip()

        last_cust_dt = None
        last_msg = ""
        for conv in convs if isinstance(convs, list) else []:
            if conv.get("incoming") and not conv.get("private"):
                ts = conv.get("created_at")
                if not ts:
                    continue
                try:
                    dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                except Exception:
                    continue
                if last_cust_dt is None or dt > last_cust_dt:
                    last_cust_dt = dt
                    raw = conv.get("body_text") or re.sub(r"<[^>]+>", " ", conv.get("body", ""))
                    last_msg = re.sub(r"\s+", " ", html.unescape(raw)).strip()

        # No customer reply in the thread yet -> the ticket's own creation IS the
        # original customer message.
        if last_cust_dt is None:
            ts = t.get("created_at")
            if ts:
                try:
                    last_cust_dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                except Exception:
                    last_cust_dt = None
            last_msg = description or t.get("subject", "")

        if last_cust_dt is None or last_cust_dt < cutoff:
            return None

        # Scan subject + original description + latest reply for refund/cancel signals.
        text = (t.get("subject", "") + " " + description + " " + last_msg).lower()
        refund = any(kw in text for kw in REFUND_KW)
        # Spam detection: trust Freshdesk's own type classification first, then a
        # conservative marketing-subject keyword fallback.
        ttype = (t.get("type") or "").lower()
        subj = (t.get("subject") or "").lower()
        spam_scan = subj + " " + description.lower() + " " + last_msg.lower()
        spam = ("spam" in ttype) or ("auto reply" in ttype) or ("auto-reply" in ttype) \
            or any(k in spam_scan for k in SPAM_SUBJECT_KW)

        hrs = round((now - last_cust_dt).total_seconds() / 3600, 1)
        return {
            "id": tid,
            "subject": t.get("subject", ""),
            "platform": label,
            "group_id": t.get("group_id"),
            "status": t.get("status"),
            "type": t.get("type"),
            "created_at": t.get("created_at"),
            "last_customer_at": last_cust_dt.isoformat(),
            "hours_ago": hrs,
            "last_customer_message": last_msg[:200],
            "refund_flag": refund,
            "spam_flag": spam,
            "url": f"https://{settings.FRESHDESK_DOMAIN}/a/tickets/{tid}",
        }

    out = []
    if candidates:
        with ThreadPoolExecutor(max_workers=12) as pool:
            for res in pool.map(analyze, list(candidates.values())):
                if res:
                    out.append(res)
    out.sort(key=lambda x: x["last_customer_at"])
    _POOL_CACHE["data"] = out
    _POOL_CACHE["ts"] = _nowts
    return out


@router.get("/automated-queue")
async def get_automated_queue(max_age_hours: int = 5, current_user: User = Depends(get_current_user)):
    out = _scan_eligible_pool(max_age_hours)
    return {"tickets": out, "count": len(out), "max_age_hours": max_age_hours}


# ── Full Automated: shared claim pool (multi-admin auto-assignment) ──────────
from app.models import AutomatedClaim as _AutoClaim  # noqa: E402


def _servable(pool):
    return [t for t in pool if not t.get("spam_flag") and not t.get("refund_flag")]


@router.post("/automated/claim-next")
def automated_claim_next(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Atomically claim and return the next unassigned eligible ticket for this
    admin. Concurrent admins each receive a DIFFERENT ticket (or none if the
    pool is drained)."""
    from datetime import datetime, timedelta
    from sqlalchemy import text as _sql

    now = datetime.utcnow()
    expires = now + timedelta(minutes=CLAIM_TTL_MIN)

    # Expire stale working claims so their tickets return to the pool.
    db.execute(_sql("UPDATE automated_claims SET status='expired' "
                    "WHERE status='working' AND expires_at < :now"), {"now": now})
    db.commit()

    pool = _servable(_scan_eligible_pool(5))

    # Tickets that must not be served: actively worked, already sent, or skipped.
    blocked = set(r[0] for r in db.execute(_sql(
        "SELECT ticket_id FROM automated_claims WHERE status IN ('working','sent','skipped')"
    )).fetchall())

    for t in pool:
        if t["id"] in blocked:
            continue
        row = db.execute(_sql('''
            INSERT INTO automated_claims
                (ticket_id, claimed_by, claimed_by_name, subject, platform, url, status, claimed_at, expires_at)
            VALUES (:tid, :uid, :uname, :subj, :plat, :url, 'working', :now, :exp)
            ON CONFLICT (ticket_id) DO UPDATE
                SET claimed_by=:uid, claimed_by_name=:uname, status='working',
                    claimed_at=:now, expires_at=:exp, subject=:subj, platform=:plat, url=:url
                WHERE automated_claims.status NOT IN ('working','sent')
                   OR automated_claims.expires_at < :now
            RETURNING claimed_by
        '''), {
            "tid": t["id"], "uid": current_user.id,
            "uname": getattr(current_user, "username", None) or getattr(current_user, "email", "agent"),
            "subj": t.get("subject", "")[:250], "plat": t.get("platform", ""),
            "url": t.get("url", ""), "now": now, "exp": expires,
        }).fetchone()
        db.commit()
        if row and row[0] == current_user.id:
            return {"ticket": t}
        # Lost the race to another admin — try the next ticket.

    return {"ticket": None}


@router.post("/automated/heartbeat")
def automated_heartbeat(
    payload: dict,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    from datetime import datetime, timedelta
    from sqlalchemy import text as _sql
    tid = payload.get("ticket_id")
    if not tid:
        return {"ok": False}
    exp = datetime.utcnow() + timedelta(minutes=CLAIM_TTL_MIN)
    db.execute(_sql("UPDATE automated_claims SET expires_at=:exp "
                    "WHERE ticket_id=:tid AND claimed_by=:uid AND status='working'"),
               {"exp": exp, "tid": tid, "uid": current_user.id})
    db.commit()
    return {"ok": True}


@router.post("/automated/release")
def automated_release(
    payload: dict,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Release a claim. reason 'skip' keeps the ticket out of the pool (manual
    handling); 'stop'/'abandon' returns it to the pool for another admin."""
    from sqlalchemy import text as _sql
    tid = payload.get("ticket_id")
    reason = (payload.get("reason") or "stop").lower()
    if not tid:
        return {"ok": False}
    new_status = "skipped" if reason in ("skip", "refund", "spam") else "released"
    db.execute(_sql("UPDATE automated_claims SET status=:st "
                    "WHERE ticket_id=:tid AND claimed_by=:uid AND status='working'"),
               {"st": new_status, "tid": tid, "uid": current_user.id})
    db.commit()
    return {"ok": True, "status": new_status}


@router.post("/automated/complete")
def automated_complete(
    payload: dict,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    from sqlalchemy import text as _sql
    tid = payload.get("ticket_id")
    if not tid:
        return {"ok": False}
    db.execute(_sql("UPDATE automated_claims SET status='sent' "
                    "WHERE ticket_id=:tid AND claimed_by=:uid"),
               {"tid": tid, "uid": current_user.id})
    db.commit()
    return {"ok": True}


@router.get("/automated/status")
def automated_status(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Live panel: who is working what, how many tickets remain, and the
    refund/spam tickets flagged for manual review."""
    from datetime import datetime
    from sqlalchemy import text as _sql

    now = datetime.utcnow()
    db.execute(_sql("UPDATE automated_claims SET status='expired' "
                    "WHERE status='working' AND expires_at < :now"), {"now": now})
    db.commit()

    workers = db.execute(_sql(
        "SELECT ticket_id, claimed_by_name, subject, platform, claimed_at, claimed_by "
        "FROM automated_claims WHERE status='working' ORDER BY claimed_at"
    )).fetchall()
    active_workers = [{
        "ticket_id": w[0], "agent": w[1], "subject": w[2],
        "platform": w[3], "since": (w[4].isoformat() if hasattr(w[4], "isoformat") else w[4]) if w[4] else None,
    } for w in workers]

    blocked = set(r[0] for r in db.execute(_sql(
        "SELECT ticket_id FROM automated_claims WHERE status IN ('working','sent','skipped')"
    )).fetchall())

    pool = _scan_eligible_pool(5)
    servable = _servable(pool)
    remaining = [t for t in servable if t["id"] not in blocked]
    flagged = [{
        "id": t["id"], "subject": t.get("subject", ""), "platform": t.get("platform", ""),
        "reason": "spam" if t.get("spam_flag") else "refund", "url": t.get("url", ""),
    } for t in pool if t.get("spam_flag") or t.get("refund_flag")]

    sent_count = db.execute(_sql(
        "SELECT COUNT(*) FROM automated_claims WHERE status='sent'"
    )).scalar() or 0

    # Presence: this endpoint is polled every few seconds while an admin has Full
    # Automated running, so a recent ping means the admin is actively monitoring.
    import time as _t
    _nowts = _t.time()
    _PRESENCE[current_user.id] = {
        "name": getattr(current_user, "username", None) or getattr(current_user, "email", "agent"),
        "ts": _nowts,
    }
    for _uid in list(_PRESENCE.keys()):
        if _nowts - _PRESENCE[_uid]["ts"] > 15:
            del _PRESENCE[_uid]
    _working_by_uid = {w[5]: w[0] for w in workers}  # claimed_by -> ticket_id
    active_admins = [{
        "id": uid,
        "name": info["name"],
        "ticket_id": _working_by_uid.get(uid),
        "is_me": uid == current_user.id,
    } for uid, info in sorted(_PRESENCE.items(), key=lambda kv: kv[1]["name"] or "")]

    return {
        "active_admins": active_admins,
        "active_workers": active_workers,
        "pool_remaining": len(remaining),
        "flagged": flagged,
        "sent_count": sent_count,
        "my_id": current_user.id,
    }
