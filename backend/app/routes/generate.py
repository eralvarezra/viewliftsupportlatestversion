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

_RESOLVED_PATTERNS = re.compile(
    r'\b('
    # Issue is fixed/working
    r'it(?:\'s| is) (?:working|fixed|resolved|fine|good now)|'
    r'(?:problem|issue|it) (?:is |was )?(?:resolved|fixed|solved)|'
    r'(?:works?|working) (?:now|again|fine|great|perfect)|'
    r'(?:all )?(?:good|great|fine|ok|okay) now|'
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
        return email_part, None, bot_notes, False

    return raw, None, bot_notes, False



def _build_agent_notes(agent_notes: str, cms_account: dict) -> str:
    """Merge agent notes with CMS account data. CMS data overrides billing verification."""
    parts = []
    if cms_account and cms_account.get("found"):
        lines = ["CMS ACCOUNT DATA (automatically retrieved — treat as CMS screenshot, do NOT output [NEEDS_VERIFICATION]):"]
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
        parts.append("\n".join(lines))
    if agent_notes and agent_notes.strip():
        parts.append(agent_notes.strip())
    return "\n\n".join(parts) if parts else None


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

    # Step 1b: Detect "issue resolved" messages → return B2C Last Response directly
    check_text = f"{request.message} {parsed_data.problem_summary or ''}"
    if _RESOLVED_PATTERNS.search(check_text):
        last_response = db.query(CannedResponse).filter(
            CannedResponse.title == "B2C Last Response"
        ).first()
        if last_response:
            response_text = _fix_bold(last_response.content)
            response_text = _ensure_signatures(response_text, parsed_data.customer_name)
            db.add(ResponseHistory(
                user_id=current_user.id,
                customer_name=parsed_data.customer_name,
                customer_message=request.message,
                parsed_data={"ticket_type": "resolved"},
                generated_response=response_text,
                platform_id=request.platform_id,
            ))
            db.commit()
            return GenerateResponse(
                parsed=parsed_data,
                response=response_text,
                canned_sources=[{"title": last_response.title, "similarity": 1.0}],
            )

    # Step 1c: No CMS account found at all -> return "B2C No account associated with email"
    # Skip if this canned response was already sent in the thread
    # Also skip if the customer is just asking about subscriptions (no existing account implied)
    _no_acct_phrase = "do not see an account associated with"
    _acct_ownership_phrases = [
        "my account", "my subscription", "i subscribed", "i signed up",
        "i was charged", "my payment", "my email", "i have an account",
        "cancel my", "my plan", "renew my", "my renewal", "my purchase",
        "i purchased", "i bought", "my order", "my billing", "charged me",
        "charge on my", "deducted", "debit", "i paid",
    ]
    _implies_existing_account = any(p in request.message.lower() for p in _acct_ownership_phrases)
    if request.cms_not_found and parsed_data.ticket_type == "billing" and _no_acct_phrase not in request.message.lower() and _implies_existing_account:
        no_acct = db.query(CannedResponse).filter(
            CannedResponse.title == "B2C No account associated with email"
        ).first()
        if no_acct:
            no_acct_text = _format_canned_content(no_acct.content)
            acct_email = (request.cms_account or {}).get("email") or (parsed_data.customer_email or "")
            no_acct_text = no_acct_text.replace("{{ticket.requester.email}}", acct_email)
            no_acct_text = _fix_bold(no_acct_text)
            no_acct_text = _ensure_signatures(no_acct_text, parsed_data.customer_name)
            db.add(ResponseHistory(
                user_id=current_user.id,
                customer_name=parsed_data.customer_name,
                customer_message=request.message,
                parsed_data=parsed_data.model_dump(),
                generated_response=no_acct_text,
                platform_id=request.platform_id,
            ))
            db.commit()
            return GenerateResponse(
                parsed=parsed_data,
                response=no_acct_text,
                canned_sources=[{"title": no_acct.title, "similarity": 1.0}],
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
    if request.cms_no_subscription and parsed_data.ticket_type == "billing" and not _no_sub_already_sent:
        no_sub = db.query(CannedResponse).filter(
            CannedResponse.title == "B2C No Subscription"
        ).first()
        if no_sub:
            no_sub_text = _format_canned_content(no_sub.content)
            acct_email = (request.cms_account or {}).get("email") or (parsed_data.customer_email or "")
            no_sub_text = no_sub_text.replace("{{ticket.requester.email}}", acct_email)
            no_sub_text = _fix_bold(no_sub_text)
            no_sub_text = _ensure_signatures(no_sub_text, parsed_data.customer_name)
            db.add(ResponseHistory(
                user_id=current_user.id,
                customer_name=parsed_data.customer_name,
                customer_message=request.message,
                parsed_data=parsed_data.model_dump(),
                generated_response=no_sub_text,
                platform_id=request.platform_id,
            ))
            db.commit()
            return GenerateResponse(
                parsed=parsed_data,
                response=no_sub_text,
                canned_sources=[{"title": no_sub.title, "similarity": 1.0}],
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
    if canned_matches:
        # Step 5d-shortcut: high-similarity canned response on technical ticket -> return directly
        top_title, top_content, top_score = canned_matches[0]
        if top_score >= 0.88 and parsed_data.ticket_type not in ("billing",) and top_title not in _BILLING_ONLY_CANNED:
            top_content = _format_canned_content(top_content)
            top_content = _fix_bold(top_content)
            top_content = _ensure_signatures(top_content, parsed_data.customer_name)
            db.add(ResponseHistory(
                user_id=current_user.id,
                customer_name=parsed_data.customer_name,
                customer_message=request.message,
                parsed_data=parsed_data.model_dump(),
                generated_response=top_content,
                platform_id=request.platform_id,
            ))
            db.commit()
            return GenerateResponse(
                parsed=parsed_data,
                response=top_content,
                canned_sources=[{"title": top_title, "similarity": round(top_score, 3)}],
            )

    canned_sources = []
    if canned_matches:
        canned_block = "CANNED RESPONSES (use these verbatim when applicable — highest priority):\n"
        for title, content, score in canned_matches:
            canned_block += f"\n[{title}]\n{content}\n"
            canned_sources.append({"title": title, "similarity": round(score, 3)})
        faq_context = (canned_block + "\n\n" + faq_context).strip()

    # account_number is excluded from billing context to prevent the model from
    # using it to infer payment handler (e.g. "apple-xxx" prefix is a CMS artifact, not Apple billing)
    parsed_dict = {
        "customer_name": parsed_data.customer_name,
        "customer_email": parsed_data.customer_email,
        "device": parsed_data.device,
        "problem_summary": parsed_data.problem_summary,
        "context": parsed_data.context,
        "ticket_type": parsed_data.ticket_type,
        "payment_handler": parsed_data.payment_handler,
    }
    if parsed_data.ticket_type != "billing":
        parsed_dict["account_number"] = parsed_data.account_number

    raw_response, gen_tokens = claude.generate_response(
        parsed_dict,
        faq_context,
        original_message=request.message,
        images=images_dicts,
        platform_name=platform_name,
        cms_url=cms_url,
        agent_notes=_build_agent_notes(request.agent_notes, request.cms_account),
        override_rules=bool(request.cms_account) or request.override_rules,
    )
    customer_response, next_steps, bot_notes, needs_verification = _parse_response_sections(raw_response)
    if customer_response:
        customer_response = _fix_bold(customer_response)
        customer_response = _ensure_signatures(customer_response, parsed_data.customer_name)
    elif not needs_verification:
        customer_response = _fix_bold(raw_response)
        customer_response = _ensure_signatures(customer_response, parsed_data.customer_name)

    # Step 7: Enforce 100-record cap per user per platform (circular buffer — delete oldest if full)
    history_count = db.query(ResponseHistory).filter(
        ResponseHistory.user_id == current_user.id,
        ResponseHistory.platform_id == request.platform_id,
    ).count()
    if history_count >= 100:
        oldest = (
            db.query(ResponseHistory)
            .filter(
                ResponseHistory.user_id == current_user.id,
                ResponseHistory.platform_id == request.platform_id,
            )
            .order_by(ResponseHistory.created_at.asc())
            .first()
        )
        if oldest:
            db.delete(oldest)

    db.add(ResponseHistory(
        user_id=current_user.id,
        customer_name=parsed_data.customer_name,
        customer_message=request.message,
        parsed_data=parsed_dict,
        generated_response=customer_response or raw_response,
        platform_id=request.platform_id,
    ))
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
    )
