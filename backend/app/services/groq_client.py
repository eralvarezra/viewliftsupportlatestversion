# backend/app/services/groq_client.py
"""Groq client for SCHN+ Support Assistant."""
import json
from typing import Optional, Dict, Any

from groq import Groq

from app.config import settings
from app.utils.prompts import (
    SCHN_RESPONSE_RULES,
    PARSE_CUSTOMER_MESSAGE_PROMPT,
    GENERATE_RESPONSE_PROMPT,
)
from app.schemas import ParsedData


class GroqClient:
    """Client for interacting with Groq API."""

    MODEL = "llama-3.3-70b-versatile"

    def __init__(self, api_key: Optional[str] = None):
        """Initialize the Groq client.

        Args:
            api_key: Groq API key. If not provided, uses settings.GROQ_API_KEY.
        """
        self.api_key = api_key or settings.GROQ_API_KEY
        self.client = Groq(api_key=self.api_key)

    def parse_customer_message(self, message: str) -> ParsedData:
        """Parse a customer message and extract structured data.

        The message may contain:
        - Latest customer message
        - Previous email thread/context
        - Private account notes from support system

        Args:
            message: The full message content (may include thread and account info).

        Returns:
            ParsedData containing extracted information.
        """
        prompt = PARSE_CUSTOMER_MESSAGE_PROMPT.format(message=message)

        response = self.client.chat.completions.create(
            model=self.MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
            response_format={"type": "json_object"},
        )

        content = response.choices[0].message.content
        parsed_dict = json.loads(content)

        # Ensure all expected fields are present
        return ParsedData(
            customer_name=parsed_dict.get("customer_name"),
            customer_email=parsed_dict.get("customer_email"),
            account_number=parsed_dict.get("account_number"),
            device=parsed_dict.get("device"),
            problem_summary=parsed_dict.get("problem_summary"),
            context=parsed_dict.get("context"),
        )

    def generate_response(
        self,
        parsed_data: Dict[str, Any],
        faq_context: str,
        original_message: str,
        rules: str = SCHN_RESPONSE_RULES,
    ) -> str:
        """Generate a response to the customer.

        Args:
            parsed_data: Parsed customer data from parse_customer_message.
            faq_context: Relevant FAQ context from the knowledge base.
            original_message: The original full message (may contain thread and account info).
            rules: Response rules to follow.

        Returns:
            Generated response text.
        """
        prompt = GENERATE_RESPONSE_PROMPT.format(
            parsed_data=json.dumps(parsed_data, indent=2),
            faq_context=faq_context if faq_context else "No relevant FAQ context available.",
            original_message=original_message,
        )

        response = self.client.chat.completions.create(
            model=self.MODEL,
            messages=[
                {"role": "system", "content": rules},
                {"role": "user", "content": prompt},
            ],
            temperature=0.3,
        )

        return response.choices[0].message.content