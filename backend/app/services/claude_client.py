# backend/app/services/claude_client.py
"""Anthropic Claude client for SCHN+ Support Assistant."""
import json
import re
from datetime import datetime, timezone
from typing import Optional, Dict, Any, List

import anthropic

from app.config import settings
from app.utils.prompts import (
    SCHN_RESPONSE_RULES,
    PARSE_CUSTOMER_MESSAGE_PROMPT,
    GENERATE_TECHNICAL_PROMPT,
    GENERATE_BILLING_PROMPT,
    THIRD_PARTY_REDIRECT_PROMPT,
    ANALYZE_TRENDS_PROMPT,
)
from app.schemas import ParsedData, TrendItem, TrendsResponse


def _image_block(image_base64: str, media_type: str = "image/png") -> dict:
    return {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": media_type,
            "data": image_base64,
        },
    }


class ClaudeClient:
    PARSE_MODEL = "claude-haiku-4-5-20251001"
    GENERATE_MODEL = "claude-sonnet-4-6"

    def __init__(self, api_key: Optional[str] = None):
        self.client = anthropic.Anthropic(
            api_key=api_key or settings.ANTHROPIC_API_KEY
        )

    def parse_customer_message(
        self,
        message: str,
        images: Optional[List[dict]] = None,
    ) -> ParsedData:
        prompt = PARSE_CUSTOMER_MESSAGE_PROMPT.format(message=message)

        content: List[dict] = []
        if images:
            for img in images:
                content.append(_image_block(img["base64"], img.get("media_type", "image/png")))
            content.append({
                "type": "text",
                "text": (
                    f"The agent has attached {len(images)} screenshot(s) showing the error or issue the customer is experiencing. "
                    "Use the visual information in the image(s) to supplement the text below when filling in the JSON fields, "
                    "especially problem_summary and context.\n\n" + prompt
                ),
            })
        else:
            content.append({"type": "text", "text": prompt})

        response = self.client.messages.create(
            model=self.PARSE_MODEL,
            max_tokens=1024,
            temperature=0.1,
            messages=[{"role": "user", "content": content}],
        )

        raw = response.content[0].text.strip()
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
        raw = raw.strip()

        parsed_dict = json.loads(raw)
        tokens = {"input": response.usage.input_tokens, "output": response.usage.output_tokens}
        return ParsedData(
            customer_name=parsed_dict.get("customer_name"),
            customer_email=parsed_dict.get("customer_email"),
            account_number=parsed_dict.get("account_number"),
            device=parsed_dict.get("device"),
            problem_summary=parsed_dict.get("problem_summary"),
            context=parsed_dict.get("context"),
            payment_handler=parsed_dict.get("payment_handler"),
            ticket_type=parsed_dict.get("ticket_type"),
        ), tokens

    _THIRD_PARTY_STEPS: Dict[str, str] = {
        "Google Play": (
            "1. Open the Google Play Store app on your device.\n"
            "2. Tap your profile icon in the top right corner.\n"
            "3. Tap \"Payments & subscriptions.\"\n"
            "4. Tap \"Subscriptions.\"\n"
            "5. Locate your subscription and tap \"Report a problem.\"\n"
            "If you cannot find this option within the app, visit play.google.com/store/account/subscriptions "
            "from a web browser and follow the same steps. For additional help, you can also contact Google Play "
            "support at support.google.com/googleplay."
        ),
        "Apple": (
            "1. Go to Settings on your device.\n"
            "2. Tap your name at the top.\n"
            "3. Tap \"Subscriptions.\"\n"
            "4. Find the subscription and follow the instructions to request a refund.\n"
            "You can also visit reportaproblem.apple.com to submit a refund request directly."
        ),
        "Roku": (
            "1. Visit roku.com/account and sign in.\n"
            "2. Navigate to your subscription and follow the steps to manage billing or request a refund."
        ),
        "Amazon": (
            "1. Sign in to your Amazon account.\n"
            "2. Go to Memberships & Subscriptions.\n"
            "3. Find your subscription and follow the instructions to manage billing or request a refund."
        ),
    }

    def generate_third_party_redirect(
        self,
        customer_name: Optional[str],
        problem_summary: Optional[str],
        third_party_handler: str,
        platform_name: str = "SCHN+",
    ) -> str:
        steps = self._THIRD_PARTY_STEPS.get(
            third_party_handler,
            f"Contact {third_party_handler} support directly to request a refund.",
        )
        prompt = THIRD_PARTY_REDIRECT_PROMPT.format(
            platform_name=platform_name,
            customer_name=customer_name or "there",
            problem_summary=problem_summary or "refund request",
            third_party_handler=third_party_handler,
            steps=steps,
        )
        response = self.client.messages.create(
            model=self.GENERATE_MODEL,
            max_tokens=1024,
            temperature=0.3,
            messages=[{"role": "user", "content": prompt}],
        )
        return response.content[0].text

    def generate_response(
        self,
        parsed_data: Dict[str, Any],
        faq_context: str,
        original_message: str,
        images: Optional[List[dict]] = None,
        rules: str = SCHN_RESPONSE_RULES,
        platform_name: str = "SCHN+",
        cms_url: Optional[str] = None,
        agent_notes: Optional[str] = None,
        override_rules: bool = False,
    ) -> str:
        cms_line = "\nCMS FOR THIS PLATFORM: " + cms_url if cms_url else ""
        platform_identity = (
            "PLATFORM IDENTITY (ABSOLUTE PRIORITY — overrides everything below):\n"
            "- You are responding on behalf of: " + platform_name + "\n"
            "- The app name is: " + platform_name + "\n"
            "- NEVER mention SCHN+, SCHN, or any other platform name in your response\n"
            "- NEVER mix instructions, branding, or app names from any other platform\n"
            "- If the FAQ context references a different app name, ignore that name and use "
            + platform_name + " only" + cms_line + "\n\n"
        )
        notes = (agent_notes or "").strip()

        ticket_type = parsed_data.get("ticket_type")
        if notes and override_rules:
            # When manual agent notes exist (override_rules=True), use a focused prompt that
            # puts the agent instruction FIRST. CMS-only data (no manual notes) uses the
            # normal billing/technical prompt so FAQ context and canned responses are used.
            customer_name = parsed_data.get("customer_name") or "Customer"
            first_name = customer_name.split()[0] if customer_name else "Customer"
            faq_section = (
                "\nREFERENCE INFORMATION (use only if directly relevant to instructions above):\n"
                + faq_context
            ) if faq_context else ""
            prompt = (
                f"Write a professional customer service email for {platform_name}.\n\n"
                f"Customer name: {customer_name}\n\n"
                "AGENT INSTRUCTION — what to communicate (follow exactly, nothing else):\n"
                + notes
                + faq_section
                + "\n\nOutput in this exact format:\n"
                "[CUSTOMER RESPONSE]\n"
                f"Hello {first_name},\n\n"
                "[body following AGENT INSTRUCTION only — no verification steps, no troubleshooting]\n\n"
                "Regards,\n"
                "The Technical Support Team\n"
                "[NEXT STEPS]\n"
                "[1-2 agent-facing next steps if applicable, else: None]"
            )
        elif notes:
            # CMS data present but no manual agent notes — use a CMS-aware prompt that
            # bypasses the BILLING CASE A/B screenshot gatekeeping entirely.
            customer_name = parsed_data.get("customer_name") or "Customer"
            first_name = customer_name.split()[0] if customer_name else "Customer"
            prompt = (
                f"Write a professional customer service email for {platform_name}.\n\n"
                f"VERIFIED ACCOUNT DATA (automatically retrieved from CMS — do NOT request verification or screenshots):\n"
                + notes
                + f"\n\nCUSTOMER MESSAGE:\n{original_message}\n\n"
                f"TICKET DATA:\n{json.dumps(parsed_data, indent=2)}\n\n"
                f"FAQ & CANNED RESPONSES (use when applicable):\n"
                + (faq_context if faq_context else "No relevant FAQ context available.")
                + "\n\nWrite a complete, helpful response addressing the customer's issue. "
                "Use the verified account data and FAQ context above. "
                "Do NOT output [NEEDS_VERIFICATION]. Do NOT ask for a CMS screenshot.\n\n"
                "Output in this exact format:\n"
                "[CUSTOMER RESPONSE]\n"
                f"Hello {first_name},\n\n"
                "[body]\n\n"
                "Regards,\n"
                "The Technical Support Team\n"
                "[NEXT STEPS]\n"
                "[1-2 agent-facing next steps, or None]"
            )
        else:
            prompt_template = GENERATE_TECHNICAL_PROMPT if ticket_type == "technical" else GENERATE_BILLING_PROMPT
            prompt = prompt_template.format(
                parsed_data=json.dumps(parsed_data, indent=2),
                faq_context=faq_context if faq_context else "No relevant FAQ context available.",
                original_message=original_message,
                cms_url=cms_url or "Not available",
            )

        non_cached_text = platform_identity

        # Split system into two blocks: large constant rules block (cached) + small variable block.

        system_blocks = [
            {"type": "text", "text": rules, "cache_control": {"type": "ephemeral"}},
            {"type": "text", "text": non_cached_text},
        ]

        content: List[dict] = []
        if images:
            for img in images:
                content.append(_image_block(img["base64"], img.get("media_type", "image/png")))
            content.append({
                "type": "text",
                "text": (
                    f"The agent has attached {len(images)} screenshot(s). "
                    "Use what is visible in the image(s) as additional context to generate a more accurate response. "
                    "Treat the images as supplementary — the FAQ and parsed data are the primary source.\n\n" + prompt
                ),
            })
        else:
            content.append({"type": "text", "text": prompt})

        response = self.client.messages.create(
            model=self.GENERATE_MODEL,
            max_tokens=2048,
            temperature=0.3,
            system=system_blocks,
            messages=[{"role": "user", "content": content}],
        )

        usage = response.usage
        tokens = {
            "input": usage.input_tokens,
            "output": usage.output_tokens,
            "cache_creation": getattr(usage, "cache_creation_input_tokens", 0) or 0,
            "cache_read": getattr(usage, "cache_read_input_tokens", 0) or 0,
        }
        return response.content[0].text, tokens

    def analyze_trends(self, summaries_with_ids: List[tuple]) -> TrendsResponse:
        filtered = [(rid, s.strip()) for rid, s in summaries_with_ids if s and s.strip()]
        if not filtered:
            return TrendsResponse(
                trends=[],
                total_tickets_analyzed=0,
                generated_at=datetime.now(timezone.utc),
            )

        lines = [f"ID={rid}: {s}" for rid, s in filtered]
        prompt = ANALYZE_TRENDS_PROMPT.format(summaries="\n".join(lines))

        response = self.client.messages.create(
            model=self.PARSE_MODEL,  # Haiku — cost efficient
            max_tokens=1024,
            temperature=0.1,
            messages=[{"role": "user", "content": prompt}],
        )

        raw = response.content[0].text.strip()
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.DOTALL).strip()

        try:
            items = json.loads(raw)
            if not isinstance(items, list):
                raise ValueError(f"Expected JSON array, got {type(items).__name__}")
        except (json.JSONDecodeError, ValueError) as exc:
            raise RuntimeError(f"analyze_trends: failed to parse Claude response: {exc}") from exc
        trends = [
            TrendItem(
                title=item["title"],
                description=item["description"],
                count=item["count"],
                ticket_ids=item.get("ticket_ids", []),
            )
            for item in items
        ]

        return TrendsResponse(
            trends=trends,
            total_tickets_analyzed=len(filtered),
            generated_at=datetime.now(timezone.utc),
        )

    def analyze_daily_update(self, tickets: list, history_context: str = "") -> dict:
        """Analyze a list of Freshdesk ticket dicts from CSV and group by problem.

        history_context: compact summary of recent daily reports so the model can
        spot recurring/escalating patterns across days (deeper analysis, especially
        on low-volume days)."""
        import json as _json

        # Build compact ticket list and a lookup of ticket_id -> platform for enforcement
        lines = []
        ticket_platform_map: dict[int, str] = {}
        ticket_tags_map: dict[int, list] = {}
        for t in tickets:
            tid = t.get("Ticket ID", t.get("ticket_id", "?"))
            subject = t.get("Subject", "")
            desc = t.get("Description", "")[:400]
            tags_raw = t.get("Tags", "")
            product = t.get("Product", "")
            client = t.get("Client Name", t.get("Full name", ""))
            platform = t.get("Platform", "")
            status = t.get("Status", "")
            lines.append(
                f"ID={tid} | Platform={platform} | Client={client} | Status={status} | "
                f"Tags=[{tags_raw}] | Product={product} | Subject={subject} | Desc={desc}"
            )
            try:
                tid_int = int(tid)
                ticket_platform_map[tid_int] = platform
                ticket_tags_map[tid_int] = [tg.strip() for tg in tags_raw.split(",") if tg.strip()]
            except (ValueError, TypeError):
                pass

        tickets_text = "\n".join(lines)

        history_block = (
            f"\nRECENT DAILY REPORTS (context from previous days — use it to judge whether "
            f"today's issues are new, recurring, or escalating; do NOT copy its tickets into today's groups):\n"
            f"{history_context}\n" if history_context.strip() else ""
        )

        prompt = f"""You are a senior support analyst writing the daily ticket analysis for company leadership. Group today's tickets by problem type AND provide real analysis — leadership explicitly asked for deeper dives, root-cause thinking, and cross-day pattern detection, especially on low-volume days.
{history_block}
TICKET DATA (use ONLY what is explicitly stated here — do NOT invent any information):
{tickets_text}

INSTRUCTIONS:
- Group tickets by BOTH Platform AND problem type — each group must contain tickets from EXACTLY ONE Platform value only
- The Platform field (e.g. "SCHN+", "Altitude B2C", "LIV Golf") is the product/service — it is NOT the customer name
- NEVER mix tickets with different Platform values in the same group — this is the most important rule
- If the same problem affects multiple platforms, create a completely separate group for each platform
- ONLY include groups with 3 or more tickets — ignore smaller groups completely
- Spam tickets must be ignored entirely
- IMPORTANT — refunds and cancellations are ROUTINE on these platforms: do NOT create a group or alert for "Refund Requests" or "Subscription Cancellation" just because several arrived. Only group them when multiple customers state the SAME concrete reason or failure (e.g. "no cancel option on Roku", "charged after cancelling", reaction to a price change, a specific error) — and in that case the title/description must name that concrete shared reason, not the generic category. Routine cancel/refund requests with no shared cause are baseline volume: mention them only inside the platform's deep_dive as normal volume, never as a trend.
- For each group extract strictly from the data above:
  * title: use standardized category names — choose the closest match from: "Login / Account Access Issues", "Billing / Payment Issues", "Refund Requests", "Subscription Cancellation", "Video Playback / Buffering", "Content / Streaming Access", "App Crashes / Technical Issues", "General App Inquiries". Only create a custom title if none of these fit. EXCEPTION: refund/cancellation groups (allowed only with a concrete shared reason, per the rule below) must ALWAYS use a custom title naming that reason — e.g. "Cancellation option missing on Roku", "Charged after cancelling" — never the generic category name
  * description: 1-2 sentences describing the pattern
  * ticket_ids: list of Ticket ID numbers (integers) for tickets in this group — ALL must share the same Platform value
  * clients: list of unique client/contact names (from "Client=" field)
  * tags: combined unique tags from all tickets in this group (from "Tags=[...]" field, split by comma)
  * devices: device names ONLY if explicitly mentioned in Subject or Desc (e.g. iOS, Android, Roku, FireTV, Web, Samsung TV) — empty list if none mentioned
  * platforms: list containing the single Platform value shared by all tickets in this group — empty list [] if Platform is blank for all tickets, never use "None" as a value
  * trend: volume indicator — "high" if 3 or more tickets, "medium" if exactly 2, "low" if 1

ANALYSIS SECTIONS (this is what leadership reads — never leave them shallow):
- "emerging": clusters of only 1-2 tickets that hint at a possible NEW issue worth watching (same fields as groups). Only real signals — do not force one if nothing stands out. On low-volume days these matter most. The refund/cancellation rule applies here too: a lone routine cancel/refund request is never an emerging signal; one with a concrete stated failure or reason is.
- "deep_dives": one entry per Platform that has ANY tickets today:
  * platform: the Platform value
  * assessment: 3-5 sentences of real analysis — what is happening on this platform today, the most likely root cause(s), and whether it is new, recurring, or escalating compared with the RECENT DAILY REPORTS above. If the pattern suggests something larger is going on (product bug, billing flow problem, store/platform change), say so explicitly. If today is quiet, analyze WHY it might be quiet and what the recent-days pattern shows.
  * recommendation: 1-2 concrete next actions for the support/product team
- "analyst_summary": 3-4 sentences for leadership: overall state of the day, the single biggest risk, and what to watch tomorrow. On low-volume days go DEEPER (use the recent-days context), never shorter.

STRICT RULES:
- Every ticket_id in a group must have the same Platform value — verify before outputting
- Only include devices, tags, clients, platforms that appear in the raw data above
- Do not add tags, devices, or names that are not present
- ticket_ids must be integers
- tags must be individual tag strings, not comma-separated
- trend must be exactly "high", "medium", or "low"
- assessments must be grounded in the ticket data and recent-reports context — no invented facts

Return ONLY valid JSON, no markdown, no explanation:
{{
  "groups": [
    {{
      "title": "...",
      "description": "...",
      "ticket_ids": [12345, 12346],
      "clients": ["Name 1", "Name 2"],
      "tags": ["tag1", "tag2"],
      "devices": ["iOS", "Android"],
      "platforms": ["SCHN+"],
      "trend": "high"
    }}
  ],
  "emerging": [
    {{
      "title": "...",
      "description": "...",
      "ticket_ids": [12347],
      "clients": ["Name"],
      "tags": ["tag"],
      "devices": [],
      "platforms": ["FOX One B2C"],
      "trend": "low"
    }}
  ],
  "deep_dives": [
    {{
      "platform": "SCHN+",
      "assessment": "...",
      "recommendation": "..."
    }}
  ],
  "analyst_summary": "..."
}}"""

        response = self.client.messages.create(
            model=self.GENERATE_MODEL,
            max_tokens=16000,
            temperature=0,
            messages=[{"role": "user", "content": prompt}],
        )

        raw = response.content[0].text.strip()
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.DOTALL).strip()

        tokens = {"input": response.usage.input_tokens, "output": response.usage.output_tokens}
        try:
            data = _json.loads(raw)
            if "groups" not in data:
                raise ValueError("Missing 'groups' key")

            # Enforce platform isolation: split any group that contains tickets from multiple platforms
            clean_groups = []
            for group in data["groups"]:
                tids = [tid for tid in group.get("ticket_ids", []) if isinstance(tid, int)]
                if not tids:
                    continue
                # Bucket by platform
                by_platform: dict[str, list] = {}
                for tid in tids:
                    plat = ticket_platform_map.get(tid, "")
                    by_platform.setdefault(plat, []).append(tid)
                if len(by_platform) <= 1:
                    # Populate platforms from ticket map even if no split needed
                    fixed = dict(group)
                    if not fixed.get("platforms"):
                        plat = list(by_platform.keys())[0] if by_platform else ""
                        fixed["platforms"] = [plat] if plat else []
                    clean_groups.append(fixed)
                else:
                    # Split into one group per platform
                    for plat, plat_tids in by_platform.items():
                        if len(plat_tids) < 3:
                            continue  # keep min-3 rule after split
                        split_tags = list({tg for tid in plat_tids for tg in ticket_tags_map.get(tid, [])})
                        clean_groups.append({
                            **group,
                            "ticket_ids": plat_tids,
                            "platforms": [plat] if plat else [],
                            "tags": split_tags,
                            "trend": "high" if len(plat_tids) >= 3 else "medium" if len(plat_tids) == 2 else "low",
                        })
            data["groups"] = clean_groups
            data.setdefault("emerging", [])
            data.setdefault("deep_dives", [])
            data.setdefault("analyst_summary", "")
            return data, tokens
        except (json.JSONDecodeError, ValueError) as exc:
            raise RuntimeError(f"analyze_daily_update: failed to parse Claude response: {exc}") from exc
