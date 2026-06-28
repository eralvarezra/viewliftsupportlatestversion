import re
from typing import Optional, Dict
from sqlalchemy.orm import Session
from app.models import FAQChunk, FAQDocument


class ZipcodeService:
    """Exact ZIP code lookup against the SCHN+ coverage database."""

    ZIP_PATTERN = re.compile(r'\b(\d{5})\b')

    def extract_zip_from_text(self, text: str) -> Optional[str]:
        """Extract the first 5-digit ZIP code found in text."""
        match = self.ZIP_PATTERN.search(text)
        return match.group(1) if match else None

    def lookup(self, zip_code: str, db: Session) -> Optional[Dict]:
        """Look up a ZIP code with exact match in the coverage database.

        Returns coverage info dict if found, None if not in service area.
        """
        # Find the zipcode document
        zipcode_doc = (
            db.query(FAQDocument)
            .filter(FAQDocument.document_type == 'zipcode')
            .first()
        )
        if not zipcode_doc:
            return None

        # Exact match search — ZIP codes are stored as "Zip Code: 77001.0 | City: ..."
        # Match both "77001" and "77001.0" formats
        chunks = (
            db.query(FAQChunk)
            .filter(FAQChunk.document_id == zipcode_doc.id)
            .filter(FAQChunk.content.like(f'%Zip Code: {zip_code}%'))
            .first()
        )

        if not chunks:
            # Try float format (77001.0)
            chunks = (
                db.query(FAQChunk)
                .filter(FAQChunk.document_id == zipcode_doc.id)
                .filter(FAQChunk.content.like(f'%Zip Code: {zip_code}.0%'))
                .first()
            )

        if chunks:
            return self._parse_chunk(chunks.content, zip_code)
        return None

    def _parse_chunk(self, content: str, zip_code: str) -> Dict:
        """Parse a ZIP code chunk into a structured dict."""
        info = {'zip_code': zip_code, 'in_service_area': True}
        for part in content.split('|'):
            part = part.strip()
            if ':' in part:
                key, _, value = part.partition(':')
                info[key.strip().lower().replace(' ', '_')] = value.strip().rstrip('.0') if value.strip().endswith('.0') else value.strip()
        return info

    def get_coverage_context(self, text: str, db: Session) -> str:
        """Extract ZIP from text and return a coverage context string for the AI prompt."""
        zip_code = self.extract_zip_from_text(text)
        if not zip_code:
            return ""

        result = self.lookup(zip_code, db)
        if result:
            city = result.get('city', '')
            state = result.get('state', '')
            return (
                f"ZIP CODE COVERAGE CHECK: ZIP {zip_code} ({city}, {state}) "
                f"IS in the SCHN+ service area. The customer can use the service."
            )
        else:
            return (
                f"ZIP CODE COVERAGE CHECK: ZIP {zip_code} is NOT in the SCHN+ service area. "
                f"Inform the customer that SCHN+ is not available at their location."
            )
