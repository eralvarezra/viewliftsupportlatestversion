# backend/app/routes/generate.py
import re
from datetime import datetime
from typing import Optional, Tuple

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth.routes import get_current_user
from app.config import settings
from app.database import get_db
from app.models import User, FAQChunk, FAQDocument, ResponseHistory, Platform, CannedResponse
from app.schemas import GenerateRequest, GenerateResponse, FAQSource, CannedSource
from app.services.claude_client import ClaudeClient
from app.services.local_embeddings import LocalEmbeddingService
from app.services.zipcode_service import ZipcodeService
from app.services.canned_response_service import CannedResponseService

_HAIKU_IN          = 0.80  / 1_000_000
_HAIKU_OUT         = 4.00  / 1_000_000
_SONNET_IN         = 3.00  / 1_000_000
_SONNET_OUT        = 15.00 / 1_000_000
_SONNET_CACHE_WRITE = 3.75  / 1_000_000   # prompt cache write (25% premium)
_SONNET_CACHE_READ  = 0.30  / 1_000_000   # prompt cache read (90% discount)

router = APIRouter()

# Signals that the customer still has an active problem — prevents false "resolved" detection
_ACTIVE_PROBLEM_INDICATORS = re.compile(
    r"\b(can'?t|cannot|won'?t|doesn'?t|isn'?t|aren'?t|don'?t|didn'?t|haven'?t|hasn'?t|"
    r"unable|not working|still\s+(?:not|having|getting)|but\s+(?:i|it|the|my)|"
    r"however|except|although|please\s+(?:help|fix|email|call|text|contact)|"
    r"help\s+me|need\s+help|having\s+(?:an?\s+)?(?:issue|problem|trouble)|"
    r"issue|problem|error|trouble|broken|fails?|failing|freezes?|crash|"
    r"won'?t\s+(?:load|work|open|play|connect|accept|continue|let|allow|access|show|launch|stream|update|start)|"
    r"can'?t\s+(?:access|watch|view|stream|log\s+in|sign\s+in|get\s+in|open|load|play)|"
    r"how\s+(?:can|do)\s+(?:i|we)\s+(?:watch|access|view|get|log|sign)|"
    r"won'?t\s+let\s+(?:us|me)|app\s+(?:won'?t|doesn'?t)|not\s+(?:letting|allowing))\b",
    re.IGNORECASE,
)

_RESOLVED_PATTERNS = re.compile(
    r'\b('
    # Issue is fixed/working
    r'it(?:\'s| is) (?:working|fixed|resolved|fine|good now)|'
    r'(?:problem|issue|it) (?:is |was )?(?:resolved|fixed|solved)|'
    r'(?:works?|working) (?:now|again|fine|great|perfect)|'
    r'(?:all )?(?:good|great|fine|ok|okay) now(?!\s+the\s+|\s+but|\s+however|\s+\w+\s+(?:won|can|doesn|isn|aren|don|didn|haven|hasn))|'
    # No longer needs support
    r'no longer (?:need|require|want)s? (?:help|support|assistance|this)|'
    r'no longer (?:an? )?issue|'
    r'don\'?t? need (?:help|support|assistance|this) (?:any ?more|any ?longer)|'
    r'(?:no longer|don\'?t?) need(?:ed)? (?:help|support|assistance)|'
    r'(?:support|assistance|help) (?:is )?no longer (?:needed|required|necessary)|'
    r'(?:no longer|not) required|'
    r'cancel (?:my )?(?:request|ticket|case)|'
    r'(?:please )?(?:close|disregard|ignore) (?:this )?(?:ticket|case|request)|'
    r'(?:we|you) can close|'
    r'never ?mind|'
    r'i(?:\'ll| will) (?:figure|handle|manage|take care of) it|'
    r'(?:already |i\'ve )?(?:figured|sorted|handled|resolved|fixed) it(?: out)?|'
    r'not (?:an? )?issue (?:any ?more|any ?longer)|'
    # Gratitude + resolution signals
    r'thank(?:s| you).{0,60}(?:fixed|resolved|working|solved|no longer|figured|sorted)|'
    r'(?:fixed|resolved|solved|working|figured|sorted).{0,60}thank(?:s| you)|'
    r'thank(?:s| you)[,.]? (?:that|this|it) (?:worked|did it|fixed it|solved it)|'
    # Spanish
    r'ya (?:funciona|resolvió|quedó|está bien|no necesito|lo resolví|lo arreglé)|'
    r'(?:ya|todo) (?:está |esta )?(?:bien|funcionando|resuelto|arreglado)|'
    r'ya no (?:necesito|requiero|necesita|requiere) (?:ayuda|soporte|asistencia)|'
    r'pueden cerrar|no es necesario|ya lo (?:resolví|arreglé|solucioné)'
    r')\b',
    re.IGNORECASE,
)



def _fix_bold(text: str) -> str:
    return re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', text, flags=re.DOTALL)

def _format_canned_content(text: str) -> str:
    """Convert space-only separators in canned responses to proper newlines."""
    text = re.sub(r' {5,}', '\n\n', text)
    text = re.sub(r' {3,4}', '\n', text)
    return text.strip()


def _ensure_signatures(text: str, customer_name: str = "") -> str:
    """Guarantee both required signatures are present in every customer email."""
    if not text:
        return text
    name = (customer_name or "").strip() or "there"

    # 1. Ensure starts with Hello [Name]
    if not text.strip().lower().startswith("hello"):
        text = f"Hello {name},\n\n" + text.strip()

    # 2. Ensure "Thank you for contacting the Technical Support Team." after Hello line
    if "Thank you for contacting" not in text:
        first_nl = text.find("\n")
        if first_nl != -1:
            after_hello = text[first_nl:].lstrip("\n")
            text = text[:first_nl] + "\n\nThank you for contacting the <strong>Technical Support Team</strong>.\n\n" + after_hello
        else:
            text = text + "\n\nThank you for contacting the <strong>Technical Support Team</strong>."

    # 3. Ensure closing signature
    if "Regards" not in text:
        text = text.rstrip() + "\n\n<strong>Regards,\nThe Technical Support Team</strong>"

    return text

def _parse_response_sections(raw: str) -> Tuple[Optional[str], Optional[str], Optional[str], bool]:
    """Split Claude output into (customer_response, next_steps, bot_notes, needs_verification)."""
    raw = raw.strip()
    bot_notes: Optional[str] = None

    # Extract explicit [BOT NOTES] block first
    if "[BOT NOTES]" in raw:
        pre, after = raw.split("[BOT NOTES]", 1)
        if "[/BOT NOTES]" in after:
            notes_part, remainder = after.split("[/BOT NOTES]", 1)
            bot_notes = notes_part.strip()
            raw = (pre + remainder).strip()
        else:
            bot_notes = after.strip()
            raw = pre.strip()

    if raw.startswith("[NEEDS_VERIFICATION]"):
        remainder = raw[len("[NEEDS_VERIFICATION]"):].strip()
        if remainder.startswith("[NEXT STEPS]"):
            remainder = remainder[len("[NEXT STEPS]"):].strip()
        return None, remainder, bot_notes, True

    if "[CUSTOMER RESPONSE]" in raw:
        cr_idx = raw.index("[CUSTOMER RESPONSE]")
        pre = raw[:cr_idx].strip()
        if pre and not bot_notes:
            bot_notes = pre
        after_cr = raw[cr_idx + len("[CUSTOMER RESPONSE]"):].strip()
        # Find earliest end marker (AI sometimes invents a closing tag)
        end_markers = ["[NEXT STEPS]", "[/CUSTOMER RESPONSE]"]
        end_idx, end_len = None, 0
        for marker in end_markers:
            idx = after_cr.upper().find(marker.upper())
            if idx != -1 and (end_idx is None or idx < end_idx):
                end_idx, end_len = idx, len(marker)
        if end_idx is not None:
            customer = re.sub(r"\[/?[A-Z ]+\]", "", after_cr[:end_idx]).strip()
            remainder = after_cr[end_idx + end_len:].strip()
            ns_up = remainder.upper()
            next_steps = remainder[ns_up.index("[NEXT STEPS]") + len("[NEXT STEPS]"):].strip() if "[NEXT STEPS]" in ns_up else None
            return customer, next_steps, bot_notes, False
        return re.sub(r"\[/?[A-Z ]+\]", "", after_cr).strip(), None, bot_notes, False

    # Fallback: no [CUSTOMER RESPONSE] tag — detect email start by "Hello" at beginning of a line
    # after at least one blank line. Everything before it becomes bot_notes.
    email_match = re.search(r'(?:^|\n)\s*\n+(Hello\s+\w)', raw)
    if email_match:
        split_idx = email_match.start() if email_match.start() > 0 else email_match.start(1)
        # Find the actual "Hello" position
        hello_idx = raw.index('Hello', email_match.start())
        pre = raw[:hello_idx].strip()
        email_part = raw[hello_idx:].strip()
        if pre and not bot_notes:
            bot_notes = pre
        # Strip trailing separators from bot_notes
        if bot_notes:
            bot_notes = re.sub(r'\s*[-—]{2,}\s*$', '', bot_notes).strip()
        # Split off an internal [NEXT STEPS] block if the model appended one to
        # the email — it must NEVER reach the customer-facing reply.
        email_part, next_steps = _split_next_steps(email_part)
        return email_part, next_steps, bot_notes, False

    email_part, next_steps = _split_next_steps(raw)
    return email_part, next_steps, bot_notes, False


def _split_next_steps(text: str) -> Tuple[str, Optional[str]]:
    """Remove a trailing [NEXT STEPS] block from a customer email; return
    (customer_text, next_steps). Internal-only — never sent to the customer."""
    m = re.search(r"\[NEXT\s*STEPS\]", text or "", re.IGNORECASE)
    if not m:
        return (text or "").strip(), None
    customer = text[:m.start()].strip()
    next_steps = text[m.end():].strip()
    return customer, (next_steps or None)



def _build_agent_notes(agent_notes: str, cms_account: dict) -> str:
    """Merge agent notes with CMS account data. CMS data overrides billing verification."""
    parts = []
    if cms_account and cms_account.get("found"):
        is_subscribed = cms_account.get("is_subscribed", False)
        _sub_status = (cms_account.get("subscription_status") or "").upper()
        _handler = (cms_account.get("payment_handler") or "").upper()
        _plan_l = ((cms_account.get("plan") or "") + " " + (cms_account.get("plan_name") or "")).lower()
        _is_tve = _handler == "TVE" or _plan_l.strip().startswith("tve") or "tve-" in _plan_l
        if is_subscribed:
            sub_status_line = "SUBSCRIBER STATUS: ACTIVE — has a valid active subscription. Do NOT suggest resubscribing or imply the subscription expired. Do NOT reveal specific plan details (price, renewal date, plan name, auto-renew status) to the customer — only confirm the account is active and address their actual issue."
        elif _is_tve:
            sub_status_line = (
                "SUBSCRIBER STATUS: TVE (TV Everywhere) — this customer accesses through their "
                "TV provider (cable/satellite login), so there is NO direct billing subscription "
                "in our system, but they ARE a valid subscriber. Do NOT say they have no "
                "subscription and do NOT suggest subscribing or paying. Their access/auth issues "
                "usually involve the TV-provider login flow — troubleshoot their actual issue."
            )
        elif "CANCEL" in _sub_status:
            sub_status_line = (
                "SUBSCRIBER STATUS: CANCELLED — the account EXISTS and its subscription plan is visible "
                "below but has been CANCELLED. Do NOT say 'we could not locate an active subscription' and "
                "do NOT ask the customer which platform they used — we already have their account and billing "
                "history. If they are asking for the cancellation, CONFIRM the subscription is cancelled. If "
                "they mention an accidental charge or want a refund, acknowledge the cancellation and address "
                "the refund per policy using the billing history shown below."
            )
        elif "SUSPEND" in _sub_status:
            sub_status_line = (
                "SUBSCRIBER STATUS: SUSPENDED — the account EXISTS and has a subscription, but it is "
                "SUSPENDED (typically a failed/declined renewal payment). This suspension is very likely "
                "the customer's actual problem. Do NOT say they have no subscription and do NOT use the "
                "'no subscription' template. Explain that the subscription is suspended and guide them to "
                "update their payment method / complete the pending payment to reactivate access."
            )
        else:
            sub_status_line = "SUBSCRIBER STATUS: INACTIVE — no active subscription found."
        lines = [
            "CMS ACCOUNT DATA (automatically retrieved — treat as CMS screenshot, do NOT output [NEEDS_VERIFICATION]):",
            f"  {sub_status_line}",
            "  NOTE: 'COMPLETED' status in ViewLift means the payment cycle completed successfully — the subscription IS active, not expired.",
            "  NOTE: The 'Payment Handler' below is the REAL payment processor from CMS. If the customer claims they subscribed or cancelled through a different platform (Amazon, Apple, Roku, etc.), the CMS Payment Handler takes precedence.",
        ]
        m = {
            "Plan Name":          cms_account.get("plan_name") or cms_account.get("plan"),
            "Price":              cms_account.get("price"),
            "Status":             cms_account.get("subscription_status"),
            "Payment State":      cms_account.get("payment_state"),
            "Country":            cms_account.get("country"),
            "Receipt ID":         cms_account.get("receipt_id"),
            "Payment Unique ID":  cms_account.get("payment_unique_id"),
            "Payment Handler":    cms_account.get("payment_handler"),
            "Registered On":      cms_account.get("registered_on"),
            "End Date":           cms_account.get("end_date"),
            "Auto-Renew":         "Yes" if cms_account.get("auto_renew") else "No",
            "Last Login":         cms_account.get("last_login"),
            "Devices":            str(cms_account.get("device_count", "")),
        }
        for k, v in m.items():
            if v:
                lines.append(f"  {k}: {v}")
        lc = cms_account.get("last_charge") or {}
        if lc.get("amount"):
            charge_line = f"  Latest Charge: {lc.get('currency', 'USD')} {lc['amount']}"
            if lc.get("charge_id"):
                charge_line += f" (gateway charge {lc['charge_id']})"
            if lc.get("period_start") and lc.get("period_end"):
                charge_line += f", billing period {lc['period_start']} to {lc['period_end']}"
            lines.append(charge_line)
        if cms_account.get("first_subscribed"):
            lines.append(f"  First Subscribed: {cms_account['first_subscribed']}")
        charges = cms_account.get("charges") or []
        if charges:
            total = sum(float(c.get("amount") or 0) for c in charges)
            cur = charges[0].get("currency", "USD")
            lines.append(
                f"  Billing History from CMS - {len(charges)} charge(s), total {cur} {total:.2f}:"
            )
            for c in charges:
                lines.append(
                    f"    {c.get('date', '')} | {c.get('type', '')} {c.get('currency', '')} {c.get('amount', '')} "
                    f"| {c.get('handler', '')} | {c.get('plan', '')} | {c.get('charge_id', '')}"
                )
        qbd = cms_account.get("qoss_by_date") or {}
        if qbd:
            lines.append("  Watch Activity on the DATES THE CUSTOMER MENTIONED (QOSS, verified):")
            for d, sessions in qbd.items():
                if sessions:
                    lines.append(f"    {d}: {len(sessions)} streaming session(s) found:")
                    for q in sessions[:5]:
                        issues = []
                        if q.get("failedtostartindicator") == "Y":
                            issues.append("FAILED TO START")
                        if q.get("streamdroppedindicator") == "Y":
                            issues.append("STREAM DROPPED")
                        br = q.get("bufferingratio") or 0
                        if br > 0.05:
                            issues.append(f"buffering {round(br * 100)}%")
                        lines.append(
                            f"      {(q.get('watchdate') or '')[:16]} | {(q.get('video') or '')[:60]} | "
                            f"{q.get('devicename', '')} ({q.get('platform', '')}, {q.get('city', '')}) | "
                            f"issues: {', '.join(issues) or 'none'}"
                        )
                else:
                    lines.append(f"    {d}: NO streaming sessions found on this date - the user did not stream (or could not stream) that day.")
        qoss = cms_account.get("qoss")
        if qoss:
            lines.append(f"  Recent Watch Activity (QOSS) - last {len(qoss)} streaming sessions:")
            for q in qoss:
                lines.append(
                    f"    {q.get('date', '')} | {q.get('video', '')} | {q.get('device', '')} "
                    f"({q.get('platform', '')}, {q.get('city', '')}) | playback issues: {q.get('issues', 'none')}"
                )
        elif qoss is not None:
            lines.append("  Recent Watch Activity (QOSS): NONE - this user has not streamed any content recently.")
        parts.append("\n".join(lines))
    if agent_notes and agent_notes.strip():
        parts.append(agent_notes.strip())
    return "\n\n".join(parts) if parts else None


def _learned_examples_block(db, embedding_service, query_embedding, platform_id):
    """Top-3 rated past interactions similar to the incoming message.

    Returns (prompt_block, used) where used = [{id, similarity, corrected}] for
    tracking which examples were injected. Uses feedback='useful' responses and
    developer-corrected 'not_useful' ones (corrections ranked first). Fail-open:
    any error returns ('', []) and /generate behaves exactly as without this feature.
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
            # Verification-step outputs are internal instructions, never customer responses —
            # excluded even if someone rated them by mistake. Legacy rows may prefix the
            # marker with [BOT NOTES], so check anywhere in the text.
            if not response_text or "[NEEDS_VERIFICATION]" in response_text:
                continue
            pd = r.parsed_data if isinstance(r.parsed_data, dict) else {}
            summary = (pd.get("problem_summary") or "").strip()
            scored.append((is_corrected, sim, r.id, summary, r.customer_message, response_text))
        if not scored:
            return "", []
        scored.sort(key=lambda x: (0 if x[0] else 1, -x[1]))  # corrections first, then similarity
        parts = [
            "LEARNED EXAMPLES (responses to similar past interactions, rated by the team — "
            "follow their content, decisions and style whenever they apply to this case):"
        ]
        used = []
        for i, (is_corrected, sim, rid, summary, msg, resp) in enumerate(scored[:3], 1):
            label = "developer-corrected" if is_corrected else "rated good"
            summary_line = f"Problem: {summary}\n" if summary else ""
            parts.append(
                f"\n[Example {i} — {label}, similarity {sim:.2f}]\n"
                f"{summary_line}"
                f"Customer message: {msg[:600]}\n"
                f"Good response:\n{resp}"
            )
            used.append({"id": rid, "similarity": round(sim, 3), "corrected": is_corrected})
        return "\n".join(parts), used
    except Exception:
        return "", []


@router.post("/generate", response_model=GenerateResponse)
async def generate(
    request: GenerateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Generate a response to a customer message using Claude + FAQ context."""
    api_key = settings.ANTHROPIC_API_KEY

    claude = ClaudeClient(api_key=api_key)
    embedding_service = LocalEmbeddingService()
    zipcode_service = ZipcodeService()
    canned_response_service = CannedResponseService()

    # Step 0: Fetch platform name and cms_url
    platform = db.query(Platform).filter(Platform.id == request.platform_id).first()
    platform_name = platform.name if platform else "SCHN+"
    cms_url = platform.cms_url if platform else None

    # Normalize images: prefer new `images` list, fall back to legacy single-image fields
    images = request.images
    if not images and request.image_base64:
        images = [{"base64": request.image_base64, "media_type": request.image_media_type or "image/png"}]
    images_dicts = [{"base64": img.base64, "media_type": img.media_type} for img in images] if images else None

    # Step 1: Parse the full message (+ optional screenshots)
    parsed_data, parse_tokens = claude.parse_customer_message(
        request.message,
        images=images_dicts,
    )

    # Step 1a: Spam short-circuit. The cheap Haiku parse already read the whole
    # message; if it flagged spam, skip the expensive Sonnet generation entirely.
    if parsed_data.is_spam:
        note = (
            "This message was flagged as spam/solicitation and is not a genuine support request"
            + (f" ({parsed_data.spam_reason})" if parsed_data.spam_reason else "")
            + ". No customer-facing response was generated. Mark the ticket as spam."
        )
        return GenerateResponse(
            parsed=parsed_data,
            response=None,
            bot_notes=note,
            faq_sources=[],
            canned_sources=[],
            history_id=None,
        )

    # Step 1b: Detect "issue resolved" messages → return B2C Last Response directly
    # Only fires if NO active-problem signals exist in the original message
    check_text = f"{request.message} {parsed_data.problem_summary or ''}"
    if _RESOLVED_PATTERNS.search(check_text) and not _ACTIVE_PROBLEM_INDICATORS.search(request.message):
        last_response = db.query(CannedResponse).filter(
            CannedResponse.title == "B2C Last Response"
        ).first()
        if last_response:
            response_text = _fix_bold(last_response.content)
            response_text = _ensure_signatures(response_text, parsed_data.customer_name)
            _hist = ResponseHistory(
                user_id=current_user.id,
                customer_name=parsed_data.customer_name,
                customer_message=request.message,
                parsed_data={"ticket_type": "resolved"},
                generated_response=response_text,
                platform_id=request.platform_id,
            )
            db.add(_hist)
            db.commit()
            return GenerateResponse(
                parsed=parsed_data,
                response=response_text,
                canned_sources=[{"title": last_response.title, "similarity": 1.0}],
                history_id=_hist.id,
            )

    # Step 1c: No CMS account found at all -> return "B2C No account associated with email"
    # Skip if this canned response was already sent in the thread
    # Skip only if message is clearly a prospect inquiry (no existing account)
    _no_acct_phrase = "do not see an account associated with"
    _prospect_phrases = [
        "will there be", "will you be", "would there be", "will you offer",
        "is there a discount", "is there a promo", "any discount", "any promo",
        "annual subscription", "annual plan", "yearly plan", "yearly subscription",
        "how much does", "how much is", "what is the price", "what's the price",
        "interested in subscribing", "thinking about subscribing", "want to subscribe",
        "can i subscribe", "how do i subscribe", "how can i subscribe",
        "looking to subscribe", "looking to sign up",
    ]
    _is_prospect_inquiry = any(p in request.message.lower() for p in _prospect_phrases)
    import logging as _logging
    _logging.getLogger("uvicorn").warning(
        f"[STEP1C] cms_not_found={request.cms_not_found} ticket_type={parsed_data.ticket_type} "
        f"is_prospect={_is_prospect_inquiry} no_acct_phrase_in_msg={_no_acct_phrase in request.message.lower()}"
    )
    if request.cms_not_found and parsed_data.ticket_type == "billing" and _no_acct_phrase not in request.message.lower() and not _is_prospect_inquiry and not bool(request.agent_notes and request.agent_notes.strip()):
        no_acct = db.query(CannedResponse).filter(
            CannedResponse.title == "B2C No account associated with email"
        ).first()
        if no_acct:
            no_acct_text = _format_canned_content(no_acct.content)
            acct_email = (request.cms_account or {}).get("email") or (parsed_data.customer_email or "")
            # Name every email we checked so the customer can give us the registered one
            _checked = [e for e in (request.checked_emails or []) if e]
            if _checked:
                _uniq = list(dict.fromkeys(e.lower() for e in _checked))
                _list = " and ".join(_uniq)
                _plural = "es" if len(_uniq) > 1 else ""
                no_acct_text = no_acct_text.replace(
                    "the email address or phone number you provided",
                    f"the email address{_plural} you provided ({_list})",
                )
            no_acct_text = no_acct_text.replace("{{ticket.requester.email}}", acct_email)
            no_acct_text = _fix_bold(no_acct_text)
            no_acct_text = _ensure_signatures(no_acct_text, parsed_data.customer_name)
            _hist = ResponseHistory(
                user_id=current_user.id,
                customer_name=parsed_data.customer_name,
                customer_message=request.message,
                parsed_data=parsed_data.model_dump(),
                generated_response=no_acct_text,
                platform_id=request.platform_id,
            )
            db.add(_hist)
            db.commit()
            return GenerateResponse(
                parsed=parsed_data,
                response=no_acct_text,
                canned_sources=[{"title": no_acct.title, "similarity": 1.0}],
                history_id=_hist.id,
            )

    # Step 1d: CMS account found but no active subscription -> return "B2C No Subscription"
    # Skip if this canned response was already sent for the SAME email in the thread
    _no_sub_match = re.search(
        r'unable to locate an active subscription associated with the email address\s+([\w._%+\-]+@[\w.\-]+\.[a-zA-Z]{2,})',
        request.message, re.IGNORECASE
    )
    _no_sub_sent_email = _no_sub_match.group(1).lower() if _no_sub_match else None
    _current_cms_email = ((request.cms_account or {}).get("email") or "").lower()
    _no_sub_already_sent = bool(_no_sub_sent_email and _current_cms_email and _no_sub_sent_email == _current_cms_email)
    _early_has_agent_notes = bool(request.agent_notes and request.agent_notes.strip())
    # SUSPENDED is not "no subscription": the account exists and the suspension
    # (usually a failed payment) IS the customer's problem — let the full flow
    # handle it with the SUSPENDED context instead of the canned template.
    _cms_suspended = "SUSPEND" in (((request.cms_account or {}).get("subscription_status")) or "").upper()
    # TVE (TV Everywhere) subscribers access via their TV provider — no direct
    # billing sub in CMS, but they ARE subscribed. Never send "No Subscription".
    _cms_acct = request.cms_account or {}
    _cms_tve = ((_cms_acct.get("payment_handler") or "").upper() == "TVE"
                or ((_cms_acct.get("plan") or "").lower().strip().startswith("tve")))
    # Account FOUND with a real subscription plan/billing history (even cancelled
    # or expired) is not "no subscription" — the "No Subscription" template asks
    # the customer to identify their platform, which is wrong when we already see
    # their account. Let the full flow answer with the cancellation/refund context.
    _cms_has_history = bool(_cms_acct.get("found") and (
        _cms_acct.get("plan") or _cms_acct.get("plan_name") or _cms_acct.get("charges")))
    # "B2C No Subscription" is a FIRST-CONTACT template only: in an ongoing
    # thread the missing subscription is usually known/expected context (e.g. a
    # refund we processed, a season-ticket comp account being set up — #344960),
    # so the full flow must answer the actual question instead.
    _is_first_contact = "[Agent Reply]" not in request.message and "[Customer Reply]" not in request.message
    if request.cms_no_subscription and _is_first_contact and not _cms_suspended and not _cms_tve and not _cms_has_history and parsed_data.ticket_type == "billing" and not _no_sub_already_sent and not _early_has_agent_notes:
        no_sub = db.query(CannedResponse).filter(
            CannedResponse.title == "B2C No Subscription"
        ).first()
        if no_sub:
            no_sub_text = _format_canned_content(no_sub.content)
            acct_email = (request.cms_account or {}).get("email") or (parsed_data.customer_email or "")
            no_sub_text = no_sub_text.replace("{{ticket.requester.email}}", acct_email)
            no_sub_text = _fix_bold(no_sub_text)
            no_sub_text = _ensure_signatures(no_sub_text, parsed_data.customer_name)
            _hist = ResponseHistory(
                user_id=current_user.id,
                customer_name=parsed_data.customer_name,
                customer_message=request.message,
                parsed_data=parsed_data.model_dump(),
                generated_response=no_sub_text,
                platform_id=request.platform_id,
            )
            db.add(_hist)
            db.commit()
            return GenerateResponse(
                parsed=parsed_data,
                response=no_sub_text,
                canned_sources=[{"title": no_sub.title, "similarity": 1.0}],
                history_id=_hist.id,
            )

    # Determine which platform's FAQ chunks to search
    B2C_PLATFORM_ID = 9
    faq_platform_id = (
        B2C_PLATFORM_ID
        if parsed_data.ticket_type == "billing"
        else request.platform_id
    )

    # Step 2: Embed problem_summary + context for better recall
    problem_summary = parsed_data.problem_summary or request.message
    search_query = f"{problem_summary} {parsed_data.context}" if parsed_data.context else problem_summary
    query_embedding = embedding_service.get_embedding(search_query)

    # Step 3: Get FAQ chunks for the appropriate platform (B2C for billing tickets, request platform otherwise)
    faq_doc_ids = [
        row.id for row in
        db.query(FAQDocument.id).filter(
            FAQDocument.document_type == "faq",
            FAQDocument.platform_id == faq_platform_id,
        ).all()
    ]
    chunks = (
        db.query(FAQChunk)
        .filter(FAQChunk.embedding.isnot(None))
        .filter(FAQChunk.document_id.in_(faq_doc_ids))
        .all()
    ) if faq_doc_ids else []

    chunk_data = [(c.id, c.content, c.embedding) for c in chunks]

    # Step 4: Find top-8 similar FAQ chunks
    similar_chunks = embedding_service.find_similar_chunks(
        query_embedding=query_embedding,
        chunks_with_embeddings=chunk_data,
        top_k=8,
        min_similarity=0.3,
    )

    # Step 5: Build FAQ context
    faq_context = ""
    faq_sources = []
    if similar_chunks:
        parts = []
        for chunk_id, content, similarity in similar_chunks:
            parts.append(f"[Relevance: {similarity:.2f}]\n{content}")
            preview = content[:200] + "..." if len(content) > 200 else content
            faq_sources.append(FAQSource(
                chunk_id=chunk_id,
                content_preview=preview,
                similarity=round(similarity, 3),
            ))
        faq_context = "\n\n---\n\n".join(parts)

    # Step 5b: ZIP code exact lookup — search both raw message and parsed context
    zip_search_text = request.message
    if parsed_data.context:
        zip_search_text = request.message + " " + parsed_data.context
    zipcode_context = zipcode_service.get_coverage_context(zip_search_text, db)

    # Step 5c: Platform location rules (always injected — not semantic search)
    location_rules_block = ""
    if platform and platform.location_rules:
        location_rules_block = "LOCATION RULES (always apply these):\n" + platform.location_rules.strip()

    if location_rules_block or zipcode_context:
        prefix_parts = []
        if location_rules_block:
            prefix_parts.append(location_rules_block)
        if zipcode_context:
            prefix_parts.append(zipcode_context)
        faq_context = ("\n\n".join(prefix_parts) + "\n\n" + faq_context).strip()

    # Step 5d: Canned response semantic lookup (platform-specific + B2C General)
    canned_matches = canned_response_service.find_relevant(
        query_embedding=query_embedding,
        platform_id=request.platform_id,
        db=db,
    )
    _BILLING_ONLY_CANNED = {"B2C No account associated with email", "B2C No Subscription"}
    _has_agent_notes = bool(request.agent_notes and request.agent_notes.strip())
    import logging as _lg; _lg.getLogger("uvicorn.error").warning(
        f"[DBG] agent_notes={repr(request.agent_notes)[:80]} has_notes={_has_agent_notes} canned={len(canned_matches)}")
    if canned_matches:
        # Step 5d-shortcut: high-similarity canned response on technical ticket -> return directly
        top_title, top_content, top_score = canned_matches[0]
        if (top_score >= 0.88 and parsed_data.ticket_type not in ("billing",)
                and top_title not in _BILLING_ONLY_CANNED and not _has_agent_notes):
            top_content = _format_canned_content(top_content)
            top_content = _fix_bold(top_content)
            top_content = _ensure_signatures(top_content, parsed_data.customer_name)
            _hist = ResponseHistory(
                user_id=current_user.id,
                customer_name=parsed_data.customer_name,
                customer_message=request.message,
                parsed_data=parsed_data.model_dump(),
                generated_response=top_content,
                platform_id=request.platform_id,
            )
            db.add(_hist)
            db.commit()
            return GenerateResponse(
                parsed=parsed_data,
                response=top_content,
                canned_sources=[{"title": top_title, "similarity": round(top_score, 3)}],
                history_id=_hist.id,
            )

    # When CMS data is auto-loaded, tell the AI not to request manual verification
    _cms_found = bool(request.cms_account and request.cms_account.get("found"))
    if _cms_found:
        cms_bypass = (
            "CMS ALREADY VERIFIED: Account data has been automatically retrieved and is available "
            "in the agent instructions above. Do NOT output [NEEDS_VERIFICATION] and do NOT ask "
            "for a CMS screenshot — treat this as BILLING CASE B (CMS data already provided)."
        )
        faq_context = (cms_bypass + "\n\n" + faq_context).strip()

    canned_sources = []
    if canned_matches:
        has_agent_notes = _has_agent_notes
        for title, content, score in canned_matches:
            canned_sources.append({"title": title, "similarity": round(score, 3)})
        # When agent notes exist, exclude canned template and inject a hard override
        # so the billing/technical prompt does not fall back to its default template.
        if has_agent_notes:
            override_instruction = (
                "CRITICAL — AGENT OVERRIDE ACTIVE:\n"
                "Do NOT use any standard billing/technical troubleshooting template.\n"
                "Do NOT ask for verification details, payment info, or next steps.\n"
                "Write a professional customer-facing email that conveys ONLY what the agent\n"
                "specified in the PRIORITY 0 override instructions. Keep greeting and signature."
            )
            faq_context = (override_instruction + "\n\n" + faq_context).strip()
        else:
            canned_block = "CANNED RESPONSES (use these verbatim when applicable — highest priority):\n"
            for title, content, score in canned_matches:
                canned_block += f"\n[{title}]\n{content}\n"
            faq_context = (canned_block + "\n\n" + faq_context).strip()

    # Monumental Sports "Season Ticket Membership" policy (client instruction).
    _MSN_PLATFORM_ID = 4
    _season_kw = re.compile(r"season\s*ticket|m\+\s*season|season\s*membership|ticket\s*holder", re.IGNORECASE)
    if request.platform_id == _MSN_PLATFORM_ID and _season_kw.search(request.message or ""):
        season_block = (
            "MONUMENTAL SEASON TICKET MEMBERSHIP (apply when the customer is a season ticket "
            "holder asking about their M+ access):\n"
            "- These members get M+ access bundled with their season ticket membership; access is "
            "provisioned by the client from a list — support cannot manually add them.\n"
            "- Reassure the member their access is being set up and, if it is not yet active, that the "
            "client is verifying the membership list. Do NOT tell them to subscribe or pay.\n"
            "- The reply is being CC'd to appsupport@monumentalsports.com so the client can verify.\n"
            "- For escalations regarding season ticket membership, the internal contact is Rajnish Kumar."
        )
        faq_context = (season_block + "\n\n" + faq_context).strip()

    # Learned examples from rated past interactions (feedback loop)
    learned_block, learned_used = _learned_examples_block(db, embedding_service, query_embedding, request.platform_id)
    if learned_block:
        faq_context = (learned_block + "\n\n" + faq_context).strip()

    # account_number is excluded from billing context to prevent the model from
    # using it to infer payment handler (e.g. "apple-xxx" prefix is a CMS artifact, not Apple billing)
    parsed_dict = {
        "customer_name": parsed_data.customer_name,
        "customer_email": parsed_data.customer_email,
        "device": parsed_data.device,
        "problem_summary": parsed_data.problem_summary,
        "context": parsed_data.context,
        "ticket_type": parsed_data.ticket_type,
    }
    if parsed_data.ticket_type != "billing":
        parsed_dict["account_number"] = parsed_data.account_number

    # payment_handler comes EXCLUSIVELY from CMS — never from the customer's message.
    # Without CMS data the field is omitted entirely so the AI cannot assume a processor.
    _cms_ph = ((request.cms_account or {}).get("payment_handler") or "").strip()
    if _cms_ph:
        parsed_dict["payment_handler"] = f"{_cms_ph} (verified from CMS)"

    # QOSS for the specific dates the customer mentioned (verifies claims like
    # "couldn't watch the game on July 3" against real streaming activity)
    _incident_dates = [d for d in (parsed_data.incident_dates or []) if isinstance(d, str) and len(d) == 10]
    _cms_uid = (request.cms_account or {}).get("user_id")
    _cms_site = (request.cms_account or {}).get("site")
    if _cms_found and _incident_dates and _cms_uid and _cms_site:
        try:
            from app.routes.cms import fetch_qos_for_dates
            request.cms_account["qoss_by_date"] = fetch_qos_for_dates(_cms_uid, _incident_dates, db, site=_cms_site)
        except Exception:
            pass

    raw_response, gen_tokens = claude.generate_response(
        parsed_dict,
        faq_context,
        original_message=request.message,
        images=images_dicts,
        platform_name=platform_name,
        cms_url=cms_url,
        agent_notes=_build_agent_notes(request.agent_notes, request.cms_account),
        override_rules=bool(request.agent_notes and request.agent_notes.strip()) or request.override_rules,
    )
    customer_response, next_steps, bot_notes, needs_verification = _parse_response_sections(raw_response)
    if customer_response:
        # Strip trailing separator lines (---, ___, ***, ===) the model adds before [NEXT STEPS]
        customer_response = re.sub(r'(\n[ \t]*[-_*=]{3,}[ \t]*)+\s*$', '', customer_response).strip()
        customer_response = _fix_bold(customer_response)
        customer_response = _ensure_signatures(customer_response, parsed_data.customer_name)
    elif not needs_verification:
        customer_response = _fix_bold(raw_response)
        customer_response = _ensure_signatures(customer_response, parsed_data.customer_name)

    # Final safety net: an internal [NEXT STEPS] block must never reach the
    # customer. If any path left it in, split it out into next_steps.
    if customer_response and re.search(r"\[NEXT\s*STEPS\]", customer_response, re.IGNORECASE):
        customer_response, _leaked_ns = _split_next_steps(customer_response)
        if _leaked_ns and not next_steps:
            next_steps = _leaked_ns
        customer_response = _ensure_signatures(customer_response.strip(), parsed_data.customer_name)

    # A verification-only output ([NEEDS_VERIFICATION], no customer response) is an internal
    # step, not a response — don't record it in history. The final response after CMS
    # verification gets saved on its own /generate call.
    _hist = None
    if customer_response is not None:
        # Step 7: Enforce 100-record cap per user per platform (circular buffer — delete oldest if full)
        # Rated entries (feedback set) are the bot's learning corpus — excluded from the cap.
        history_count = db.query(ResponseHistory).filter(
            ResponseHistory.user_id == current_user.id,
            ResponseHistory.platform_id == request.platform_id,
            ResponseHistory.feedback.is_(None),
        ).count()
        if history_count >= 100:
            oldest = (
                db.query(ResponseHistory)
                .filter(
                    ResponseHistory.user_id == current_user.id,
                    ResponseHistory.platform_id == request.platform_id,
                    ResponseHistory.feedback.is_(None),
                )
                .order_by(ResponseHistory.created_at.asc())
                .first()
            )
            if oldest:
                db.delete(oldest)

        _hist = ResponseHistory(
            user_id=current_user.id,
            customer_name=parsed_data.customer_name,
            customer_message=request.message,
            parsed_data=parsed_dict,
            generated_response=customer_response,
            platform_id=request.platform_id,
            learned_examples=learned_used or None,
        )
        db.add(_hist)
    haiku_cost = parse_tokens["input"] * _HAIKU_IN + parse_tokens["output"] * _HAIKU_OUT
    sonnet_cost = (
        gen_tokens["input"] * _SONNET_IN
        + gen_tokens["output"] * _SONNET_OUT
        + gen_tokens.get("cache_creation", 0) * _SONNET_CACHE_WRITE
        + gen_tokens.get("cache_read", 0) * _SONNET_CACHE_READ
    )
    total_cost = haiku_cost + sonnet_cost

    user = db.query(User).filter(User.id == current_user.id).first()
    current_month = datetime.utcnow().strftime("%Y-%m")
    if user.monthly_cost_month != current_month:
        user.monthly_cost = 0.0
        user.monthly_cost_month = current_month
    user.monthly_cost = (user.monthly_cost or 0.0) + total_cost
    user.ticket_total = (user.ticket_total or 0) + 1
    db.commit()

    return GenerateResponse(
        parsed=parsed_data,
        response=customer_response,
        next_steps=next_steps,
        bot_notes=bot_notes,
        needs_verification=needs_verification,
        faq_sources=faq_sources,
        canned_sources=canned_sources,
        cache_hit=gen_tokens.get("cache_read", 0) > 0,
        history_id=_hist.id if _hist else None,
        learned_count=len(learned_used),
    )
