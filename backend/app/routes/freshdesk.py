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
    return {"ok": True}

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
    body_html = '<br>'.join(body_text.splitlines())
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
    update_data = {'status': payload.get('status')}
    if payload.get('type'):
        update_data['type'] = payload.get('type')
    r = requests.put(
        f'{FRESHDESK_BASE}/tickets/{ticket_id}',
        auth=FRESHDESK_AUTH,
        json=update_data,
        timeout=10,
    )
    if r.status_code == 429:
        raise _rate_limit_error(r)
    if r.status_code not in (200, 201):
        raise HTTPException(status_code=502, detail=f'Freshdesk returned {r.status_code}: {r.text[:200]}')
    return {'ok': True}


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
