import math
import re
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

# ── Global Freshdesk rate-limit brake ────────────────────────────────────────
# When Freshdesk returns 429 anywhere, we record until when the API is
# exhausted. While active, the Full Automated bot pauses completely (no scans,
# no claims) and auto-resumes once the window passes.
_FD_RATE_LIMIT = {"until": 0.0}  # epoch seconds


def _note_rate_limit(seconds) -> None:
    import time
    try:
        seconds = int(seconds)
    except (TypeError, ValueError):
        seconds = 60
    _FD_RATE_LIMIT["until"] = max(_FD_RATE_LIMIT["until"], time.time() + max(seconds, 30))


def _rate_limit_remaining() -> int:
    import time
    return max(0, int(_FD_RATE_LIMIT["until"] - time.time()))

STATUS_MAP = {2: "Open", 3: "Pending", 4: "Resolved", 5: "Closed", 6: "Waiting on Customer", 7: "Waiting on Third Party"}
PRIORITY_MAP = {1: "Low", 2: "Medium", 3: "High", 4: "Urgent"}


# ── Payment/BEC phishing detection (Full Automated pool) ────────────────────
# Modeled on real spam that slipped through (e.g. #344825: fake "SWIFT advice"
# payment-confirmation mail with a Payment_Recelpt.pdf attachment). These are
# scams aimed at the support inbox, never real subscriber requests.
PHISHING_KW = [
    "swift advice", "swift copy", "swift message", "mt103", "mt 103",
    "payment has been successfully processed", "confirm once the funds",
    "funds have been received", "remittance advice",
    "payment confirmation & records", "bank transfer details",
    "kindly confirm receipt of payment", "wire confirmation",
    "payment slip", "bank slip", "telegraphic transfer", "beneficiary account",
]

# Attachment names typical of payment-phishing lures. "rec[a-z]{0,3}pt" also
# catches deliberate typos like "Recelpt".
_PHISHY_ATTACHMENT_RE = re.compile(
    r"(payment|swift|invoice|remittance|rec[a-z]{0,3}pt|statement)[\w_\-. ]*\.(pdf|html?|zip|iso|img)",
    re.IGNORECASE,
)


# Credential/security phishing (distinct from payment phishing above): fake
# "verify your account / update your firewall" lures aimed at the support inbox
# (#345271: "Email security alert ... update your firewall ... account at risk").
SECURITY_PHISHING_KW = [
    "email security alert", "security alert", "update your firewall",
    "email firewall", "update my email settings", "verify your account",
    "account verification", "click the button below", "confirm your account",
    "your account will be", "account will be suspended", "account has been suspended",
    "unusual activity", "suspicious activity", "validate your account",
    "reactivate your account", "your password will expire", "quarantined messages",
    "pending messages", "mailbox is full", "storage is full", "re-authenticate",
    "failed to update your", "at risk of being", "permanent hijacking", "hijacking of your",
]

# Brand tokens a spammer puts in the display name to look official. If the
# sender's display name contains one but the email domain is NOT ours, it's spoofed.
BRAND_TOKENS = [
    "monumental", "schn", "space city", "spacecity", "dirtvision", "altitude",
    "livgolf", "liv golf", "fox one", "foxone", "viewlift", "support team",
    "account verification", "email security", "it support", "help desk",
]


# Freshdesk scenario automation that marks a ticket as SPAM (Execute scenarios → SPAM).
SPAM_SCENARIO_ID = 43001058266

# Domains we own — a real customer never sends from one of these.
SUPPORT_DOMAINS = ("viewlift", "fox.com", "spacecityhn", "monumentalsports",
                   "livgolf", "dirtvision", "altitude", "freshdesk")

# Marketing / non-support subject-body signals (fallback when Freshdesk did not
# already classify the ticket type as spam/auto-reply).
SPAM_SUBJECT_KW = [
    "sponsorship", "newsletter", "webinar", "press release",
    "partnership opportunity", "advertising opportunity", "advertise with us",
    "advertise on your", "advertising services", "ad placement",
    "guest post", "backlink",
    "ceo update", "quarterly update", "promo code", "limited time offer",
    "act now", "exclusive offer", "boost your", "grow your", "seo audit",
    "link building", "collaboration opportunity", "invoice attached",
    "wire transfer", "out of office", "automatic reply", "auto-reply",
    "delivery status notification", "undeliverable",
    "website upgrade", "website redesign", "web design", "website design",
    "wordpress", "logo design", "ui/ux", "e-commerce website",
    "we specialize in", "see our portfolio", "our portfolio",
    "digital marketing", "seo services", "mobile app development",
    "design and development company", "increase your sales",
    "rank your website", "lead generation service",
    "strengthen their visibility", "we're helping businesses",
    "brief introduction with more information", "visibility where customers search",
    # B2B factory/wholesale solicitations (#345278 gym-equipment supplier)
    "direct manufacturer", "factory supply", "we specialize in", "specializing in",
    "ddp shipping", "delivered duty paid", "wholesale supplier", "bulk order",
    "we now offer", "reaching out from",
]


def _spam_verdict(data: dict, subject: str, description: str, last_msg: str,
                  attachment_names=None, has_agent_reply: bool = False):
    """Single source of truth for spam detection. Returns (is_spam, reason).

    Used by both the automated pool scan and the manual ticket-load endpoint so
    the two never disagree. Heuristics only fire on first-contact tickets;
    Freshdesk's own spam/type flags are always authoritative."""
    if not isinstance(data, dict):
        data = {}
    if bool(data.get("spam")) or bool(data.get("deleted")):
        return True, "flagged spam in Freshdesk"
    ttype = (data.get("type") or "").lower()
    if "spam" in ttype or "auto reply" in ttype or "auto-reply" in ttype:
        return True, "Freshdesk type is spam/auto-reply"

    subj = (subject or "").lower()
    scan = subj + " " + (description or "").lower() + " " + (last_msg or "").lower()
    att_names = attachment_names or []
    recipients = [str(e).lower() for e in ((data.get("to_emails") or []) + (data.get("cc_emails") or []))]
    req = data.get("requester") or {}

    if not has_agent_reply:
        if any(k in scan for k in SPAM_SUBJECT_KW):
            return True, "marketing/solicitation keywords"
        if recipients and not any(d in r_ for r_ in recipients for d in SUPPORT_DOMAINS):
            return True, "addressed to a non-support inbox (BCC blast)"
        if any(k in scan for k in SECURITY_PHISHING_KW):
            return True, "security/credential phishing"
        if _looks_like_display_name_spoof(req.get("name"), req.get("email")):
            return True, "sender display name spoofs a brand"
        if _looks_like_phishing(subject, (description or "") + " " + (last_msg or ""), att_names, has_agent_reply):
            return True, "payment/BEC phishing"
    return False, ""


def _looks_like_display_name_spoof(requester_name: str, requester_email: str) -> bool:
    """Display name impersonates a brand/support while the sender domain is not ours."""
    name = (requester_name or "").lower()
    domain = (requester_email or "").split("@")[-1].lower()
    if not name or not domain:
        return False
    if any(d in domain for d in ("viewlift", "monumentalsports", "spacecityhn",
                                 "dirtvision", "altitude", "livgolf", "fox.com", "freshdesk")):
        return False  # a real internal/support sender
    return any(tok in name for tok in BRAND_TOKENS)


def _looks_like_phishing(subject: str, text: str, attachment_names: list, has_agent_reply: bool) -> bool:
    """True if the ticket matches payment/BEC phishing patterns.

    Two independent signals:
    1. Finance-phishing phrases in subject/body (subscribers dispute charges;
       they never announce that THEY processed a payment to us).
    2. Fake reply: subject starts with "Re:" on a thread no agent ever answered,
       combined with a payment-lure attachment name.
    """
    s = (subject or "").lower()
    scan = s + " " + (text or "").lower()
    if any(k in scan for k in PHISHING_KW):
        return True
    att = " ".join((a or "") for a in attachment_names)
    fake_reply = s.startswith("re:") or s.startswith("[external] re:")
    return fake_reply and not has_agent_reply and bool(_PHISHY_ATTACHMENT_RE.search(att))


def _rate_limit_error(r) -> HTTPException:
    retry_after = r.headers.get("Retry-After")
    _note_rate_limit(retry_after or 60)
    seconds = None
    if retry_after:
        try:
            seconds = int(retry_after)
            minutes = math.ceil(seconds / 60)
            msg = f"Freshdesk rate limit reached. Try again in {minutes} minute{'s' if minutes != 1 else ''}."
        except ValueError:
            msg = f"Freshdesk rate limit reached. Try again after {retry_after}."
    else:
        msg = "Freshdesk rate limit reached, try again later."
    # Expose the authoritative wait so the frontend rate-limit widget can sync
    # its countdown to Freshdesk's real window instead of a local estimate.
    return HTTPException(status_code=429, detail=msg,
                         headers={"Retry-After": str(seconds or _rate_limit_remaining() or 300)})


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

    # Spam verdict (same logic as the automated pool) so the UI can offer to run
    # the Freshdesk SPAM scenario instead of drafting a reply to junk.
    import re as _re, html as _html
    _desc = _re.sub(r"\s+", " ", _html.unescape(t.get("description_text") or "")).strip()
    _last = ""
    _has_agent = False
    for _cv in (conversations if isinstance(conversations, list) else []):
        if not _cv.get("private") and not _cv.get("incoming"):
            _has_agent = True
        if _cv.get("incoming") and not _cv.get("private"):
            _last = _re.sub(r"\s+", " ", _html.unescape(_cv.get("body_text") or "")).strip()
    _atts = [a.get("name") or "" for a in (t.get("attachments") or []) if isinstance(a, dict)]
    _is_spam, _spam_reason = _spam_verdict(t, t.get("subject", ""), _desc, _last,
                                           attachment_names=_atts, has_agent_reply=_has_agent)

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
        "spam_detected": _is_spam,
        "spam_reason": _spam_reason,
        "season_ticket_holder": _is_season_ticket_holder(
            (t.get("subject", "") or "") + " " + _desc + " " + _last),
        "url": f"https://{settings.FRESHDESK_DOMAIN}/a/tickets/{t['id']}",
        "group_id": t.get("group_id"),
        "client_name": (t.get("custom_fields") or {}).get("cf_b2b_client_name"),
        "conversation_count": len(conversations),
        "rate_limit_remaining": int(float(rl_remaining)) if rl_remaining else None,
        "rate_limit_total": int(float(rl_total)) if rl_total else 5000,
    }


# The Freshdesk "SPAM" scenario automation runs only through Freshdesk's internal
# /api/_/ (cookie-session) endpoint; the public v2 execute_scenario 404s. So we
# replicate its exact effect via v2 instead — verified against a real execution:
#   status -> Closed(5), type -> "Auto Reply Email / Spam",
#   Client Name -> "Viewlift Internal", Platform/Support Plan -> "None", + note "Spam."
# Monumental Sports "Season Ticket Membership" handling (from client instructions):
# CC their support so they can verify, and tag the ticket so they can be tracked.
MSN_PLATFORM_ID = 4
MSN_SEASON_TICKET_CC = "appsupport@monumentalsports.com"
MSN_SEASON_TICKET_TAG = "MSN-Issue-SeasonTicketHolder"
_SEASON_TICKET_RE = re.compile(
    r"season\s*ticket|m\+\s*season|season\s*membership|ticket\s*holder|"
    r"season\s*ticket\s*member", re.IGNORECASE)


def _is_season_ticket_holder(text: str) -> bool:
    return bool(_SEASON_TICKET_RE.search(text or ""))


SPAM_TICKET_FIELDS = {
    "status": 5,
    "type": "Auto Reply Email / Spam",
    "custom_fields": {
        "cf_b2b_client_name": "Viewlift Internal",
        "cf_platform": "None",
        "cf_support_plan": "None",
    },
}


@router.post("/ticket/{ticket_id}/mark-spam")
async def mark_ticket_spam(
    ticket_id: int,
    current_user: User = Depends(get_current_user),
):
    """Mark a ticket as spam — replicates the Freshdesk 'SPAM' scenario:
    close it, set type/fields, and add a 'Spam.' private note."""
    auth = (current_user.freshdesk_api_key, "X") if current_user.freshdesk_api_key else FRESHDESK_AUTH
    r = requests.put(
        f"{FRESHDESK_BASE}/tickets/{ticket_id}",
        auth=auth, json=SPAM_TICKET_FIELDS, timeout=15,
    )
    if r.status_code == 429:
        raise _rate_limit_error(r)
    if r.status_code not in (200, 201):
        raise HTTPException(status_code=502,
                            detail=f"Freshdesk update failed ({r.status_code}): {r.text[:200]}")
    # Best-effort private note documenting the spam decision (never fails the action).
    try:
        requests.post(f"{FRESHDESK_BASE}/tickets/{ticket_id}/notes",
                      auth=auth, json={"body": "Spam.", "private": True}, timeout=10)
    except Exception:
        pass
    return {"ok": True}


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
        for _e in (payload.get("cc_emails") or []):
            if _e:
                files.append(("cc_emails[]", (None, _e)))
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
        _reply_payload = {"body": body_html}
        _cc = [e for e in (payload.get("cc_emails") or []) if e]
        if _cc:
            _reply_payload["cc_emails"] = _cc
        r = requests.post(
            f"{FRESHDESK_BASE}/tickets/{ticket_id}/reply",
            auth=auth,
            json=_reply_payload,
            timeout=10,
        )
    if r.status_code == 429:
        raise _rate_limit_error(r)
    if r.status_code not in (200, 201):
        raise HTTPException(status_code=502, detail=f"Freshdesk returned {r.status_code}: {r.text[:200]}")

    # Apply requested tags (merge with existing — Freshdesk PUT replaces the set).
    _new_tags = [tg for tg in (payload.get("tags") or []) if tg]
    if _new_tags:
        try:
            _tr = requests.get(f"{FRESHDESK_BASE}/tickets/{ticket_id}", auth=auth, timeout=10)
            _existing = _tr.json().get("tags", []) if _tr.status_code == 200 else []
            _merged = list(dict.fromkeys([*_existing, *_new_tags]))
            if set(_merged) != set(_existing):
                requests.put(f"{FRESHDESK_BASE}/tickets/{ticket_id}",
                             auth=auth, json={"tags": _merged}, timeout=10)
        except Exception:
            pass  # tagging is best-effort; never fail a sent reply

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
    # API exhausted: don't spend a single call — serve the stale cache (or
    # nothing) until the window resets.
    if _rate_limit_remaining() > 0:
        return _POOL_CACHE["data"] or []
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
                # Record the exhaustion and abort — retrying burns the window.
                _note_rate_limit(r.headers.get("Retry-After") or 60)
                return []
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
            if cr.status_code == 429:
                _note_rate_limit(cr.headers.get("Retry-After") or 60)
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
        # conservative marketing-subject keyword fallback, then payment-phishing
        # patterns (fake SWIFT/payment-confirmation mails like #344825).
        ttype = (t.get("type") or "").lower()
        subj = (t.get("subject") or "").lower()
        spam_scan = subj + " " + description.lower() + " " + last_msg.lower()
        att_names = [a.get("name") or "" for a in (data.get("attachments") or []) if isinstance(a, dict)]
        has_agent_reply = any(
            not c.get("incoming") and not c.get("private")
            for c in (convs if isinstance(convs, list) else [])
        )
        # Merge search-result to_emails into the full ticket data for the verdict.
        if not data.get("to_emails") and t.get("to_emails"):
            data["to_emails"] = t.get("to_emails")
        spam, _spam_reason = _spam_verdict(
            data, t.get("subject", ""), description, last_msg,
            attachment_names=att_names, has_agent_reply=has_agent_reply,
        )

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


# ── Live queues panel (Generate page) ────────────────────────────────────────
# All open tickets per platform, filtered ONLY by status (not resolved/closed),
# with no time cutoff. Lightweight: uses Freshdesk search only (no per-ticket
# conversation fetch), so it can list the full queue cheaply.
_QUEUE_GROUPS = {
    43000666076: "SCHN+",
    43000663122: "Monumental Sports",
    43000663120: "Monumental Sports",
    43000662781: "DirtVision",
    43000664192: "Altitude Sports",
}
# Non-terminal statuses (everything except Resolved=4 and Closed=5).
_QUEUE_STATUSES = [2, 3, 6, 7, 12, 15]
_QUEUE_STATUS_LABELS = {
    2: "Open", 3: "Pending", 6: "Waiting on Customer",
    7: "Waiting on Third Party", 12: "Waiting on L1", 15: "Waiting on L1",
}
_QUEUE_CACHE = {"data": None, "ts": 0.0}


@router.get("/queues")
async def get_queues(current_user: User = Depends(get_current_user)):
    """Open tickets grouped by platform, filtered by status only (not resolved/
    closed), no time cutoff. Cached 60s and shared across agents."""
    import time as _t
    from datetime import datetime, timezone
    now_ts = _t.time()
    if _QUEUE_CACHE["data"] is not None and (now_ts - _QUEUE_CACHE["ts"]) < 60:
        return _QUEUE_CACHE["data"]
    if _rate_limit_remaining() > 0 and _QUEUE_CACHE["data"] is not None:
        return _QUEUE_CACHE["data"]

    def _search(query, page=1):
        for _ in range(3):
            r = requests.get(f"{FRESHDESK_BASE}/search/tickets", auth=FRESHDESK_AUTH,
                             params={"query": f'"{query}"', "page": page}, timeout=15)
            if r.status_code == 429:
                _note_rate_limit(r.headers.get("Retry-After") or 60)
                return []
            if r.status_code == 200:
                return r.json().get("results", [])
            break
        return []

    import html as _html
    from datetime import timedelta
    from concurrent.futures import ThreadPoolExecutor
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=24)
    since_date = (now - timedelta(days=2)).strftime("%Y-%m-%d")
    status_q = " OR ".join(f"status:{s}" for s in _QUEUE_STATUSES)

    # 1. Collect candidate tickets (24h activity window, non-terminal statuses).
    candidates = {}  # id -> (ticket, label)
    for gid, label in _QUEUE_GROUPS.items():
        page = 1
        while True:
            results = _search(f"group_id:{gid} AND ({status_q}) AND updated_at:>'{since_date}'", page)
            if not results:
                break
            for t in results:
                if t["id"] in candidates:
                    continue
                updated = t.get("updated_at")
                if updated:
                    try:
                        if datetime.fromisoformat(updated.replace("Z", "+00:00")) < cutoff:
                            continue
                    except Exception:
                        pass
                candidates[t["id"]] = (t, label)
            if len(results) < 30 or page >= 10:
                break
            page += 1

    # 2. For each candidate, look at the thread: keep only tickets whose LAST
    #    public message is from the CUSTOMER (incoming) — i.e. waiting on us.
    def _analyze(item):
        t, label = item
        tid = t["id"]
        try:
            cr = requests.get(f"{FRESHDESK_BASE}/tickets/{tid}/conversations", auth=FRESHDESK_AUTH, timeout=10)
            if cr.status_code == 429:
                _note_rate_limit(cr.headers.get("Retry-After") or 60)
                return None
            convs = cr.json() if cr.status_code == 200 else []
        except Exception:
            return None
        last_dt, last_incoming = None, None
        for c in convs if isinstance(convs, list) else []:
            if c.get("private"):
                continue
            ts = c.get("created_at")
            if not ts:
                continue
            try:
                dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            except Exception:
                continue
            if last_dt is None or dt > last_dt:
                last_dt, last_incoming = dt, bool(c.get("incoming"))
        # No public reply yet → the ticket creation IS the customer's message.
        if last_dt is None:
            ts = t.get("created_at")
            try:
                last_dt = datetime.fromisoformat(ts.replace("Z", "+00:00")) if ts else None
            except Exception:
                last_dt = None
            last_incoming = True
        if not last_incoming or last_dt is None or last_dt < cutoff:
            return None  # last word was the agent's, or older than 24h
        hrs = round((now - last_dt).total_seconds() / 3600, 1)
        return label, {
            "id": tid,
            "subject": t.get("subject", ""),
            "status": _QUEUE_STATUS_LABELS.get(t.get("status"), str(t.get("status"))),
            "hours_since_update": hrs,
            "created_at": t.get("created_at"),
            "url": f"https://{settings.FRESHDESK_DOMAIN}/a/tickets/{tid}",
        }

    by_platform = {label: [] for label in set(_QUEUE_GROUPS.values())}
    if candidates:
        with ThreadPoolExecutor(max_workers=12) as pool:
            for res in pool.map(_analyze, list(candidates.values())):
                if res:
                    by_platform[res[0]].append(res[1])
    for lst in by_platform.values():
        lst.sort(key=lambda x: (x["hours_since_update"] is None, -(x["hours_since_update"] or 0)))
    payload = {"queues": by_platform, "rate_limited_seconds": _rate_limit_remaining()}
    _QUEUE_CACHE["data"] = payload
    _QUEUE_CACHE["ts"] = now_ts
    return payload


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

    # API exhausted → the bot pauses: no scans, no claims. The frontend shows
    # the pause and retries automatically once the window resets.
    rl = _rate_limit_remaining()
    if rl > 0:
        return {"ticket": None, "rate_limited": True, "retry_after_seconds": rl}

    now = datetime.utcnow()
    expires = now + timedelta(minutes=CLAIM_TTL_MIN)

    # Expire stale working claims so their tickets return to the pool.
    db.execute(_sql("UPDATE automated_claims SET status='expired' "
                    "WHERE status='working' AND expires_at < :now"), {"now": now})
    db.commit()

    # If this admin already holds an active claim (e.g. the page was refreshed
    # and the frontend lost its state), re-serve that SAME ticket instead of
    # leaving them stuck in monitoring while the panel shows them as working.
    own = db.execute(_sql(
        "SELECT ticket_id, subject, platform, url FROM automated_claims "
        "WHERE claimed_by = :uid AND status = 'working' AND expires_at >= :now"
    ), {"uid": current_user.id, "now": now}).fetchone()
    if own:
        # Same live spam/deleted check as fresh claims — the ticket may have
        # been marked spam while the claim sat idle.
        resumed_ok = True
        try:
            vr = requests.get(f"{FRESHDESK_BASE}/tickets/{own[0]}", auth=FRESHDESK_AUTH, timeout=8)
            if vr.status_code == 429:
                _note_rate_limit(vr.headers.get("Retry-After") or 60)
            if vr.status_code == 200 and (vr.json().get("spam") or vr.json().get("deleted")):
                db.execute(_sql("UPDATE automated_claims SET status='skipped' WHERE ticket_id=:tid"),
                           {"tid": own[0]})
                db.commit()
                resumed_ok = False
        except Exception:
            pass
        if resumed_ok:
            t = next((x for x in _scan_eligible_pool(5) if x["id"] == own[0]), None)
            if t and (t.get("spam_flag") or t.get("refund_flag")):
                # Our own heuristics flagged it after it was claimed (#345005 was
                # resumed while sitting in the manual-review list) — never resume
                # a flagged ticket; release it to manual review.
                db.execute(_sql("UPDATE automated_claims SET status='skipped' WHERE ticket_id = :tid"),
                           {"tid": own[0]})
                db.commit()
            else:
                db.execute(_sql("UPDATE automated_claims SET expires_at = :exp WHERE ticket_id = :tid"),
                           {"exp": expires, "tid": own[0]})
                db.commit()
                if t is None:
                    t = {
                        "id": own[0],
                        "subject": own[1] or "",
                        "platform": own[2] or "",
                        "url": own[3] or f"https://{settings.FRESHDESK_DOMAIN}/a/tickets/{own[0]}",
                    }
                return {"ticket": {**t, "resumed": True}}

    pool = _servable(_scan_eligible_pool(5))

    # Tickets that must not be served: actively worked, skipped, or already sent
    # WITHOUT a newer customer reply. A ticket answered via Full Automated where
    # the customer replied again is workable again (#344774 stayed blocked).
    claim_rows = db.execute(_sql(
        "SELECT ticket_id, status, claimed_at FROM automated_claims "
        "WHERE status IN ('working','sent','skipped')"
    )).fetchall()
    blocked_claims = {r[0]: (r[1], r[2]) for r in claim_rows}

    def _is_blocked(t):
        entry = blocked_claims.get(t["id"])
        if not entry:
            return False
        status_, claimed_at_ = entry
        if status_ in ("working", "skipped"):
            return True
        # status 'sent': blocked only if the customer has NOT replied since.
        try:
            sent_at = claimed_at_ if isinstance(claimed_at_, datetime) \
                else datetime.fromisoformat(str(claimed_at_))
            from datetime import timezone as _tz
            last_cust = datetime.fromisoformat(
                t["last_customer_at"].replace("Z", "+00:00")
            ).astimezone(_tz.utc).replace(tzinfo=None)
            return last_cust <= sent_at
        except Exception:
            return True  # can't compare — stay safe, keep blocked

    for t in pool:
        if _is_blocked(t):
            continue
        row = db.execute(_sql('''
            INSERT INTO automated_claims
                (ticket_id, claimed_by, claimed_by_name, subject, platform, url, status, claimed_at, expires_at)
            VALUES (:tid, :uid, :uname, :subj, :plat, :url, 'working', :now, :exp)
            ON CONFLICT (ticket_id) DO UPDATE
                SET claimed_by=:uid, claimed_by_name=:uname, status='working',
                    claimed_at=:now, expires_at=:exp, subject=:subj, platform=:plat, url=:url
                WHERE automated_claims.status NOT IN ('working')
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
            # Final live check: the pool cache is up to 60s old and a human may
            # have marked the ticket spam/deleted in the meantime (#344916 was
            # served after being marked spam). One cheap GET closes the race.
            try:
                vr = requests.get(f"{FRESHDESK_BASE}/tickets/{t['id']}", auth=FRESHDESK_AUTH, timeout=8)
                if vr.status_code == 429:
                    _note_rate_limit(vr.headers.get("Retry-After") or 60)
                if vr.status_code == 200 and (vr.json().get("spam") or vr.json().get("deleted")):
                    db.execute(_sql("UPDATE automated_claims SET status='skipped' WHERE ticket_id=:tid"),
                               {"tid": t["id"]})
                    db.commit()
                    continue  # try the next ticket
            except Exception:
                pass  # verification is best-effort; serve the ticket on network issues
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
        "rate_limited_seconds": _rate_limit_remaining(),
    }
