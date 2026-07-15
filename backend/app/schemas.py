# backend/app/schemas.py
from datetime import datetime
from typing import Optional, List, Any
from pydantic import BaseModel, ConfigDict, EmailStr, field_validator


# Auth schemas
class LoginRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    role: str
    username: str
    is_superadmin: bool = False


class UserCreate(BaseModel):
    username: str
    password: str
    role: str = "agent"


class RegisterRequest(BaseModel):
    username: str
    email: EmailStr
    password: str


class UserStats(BaseModel):
    today_count: int
    tracked_today: int
    daily_goal: int


class SetGoalRequest(BaseModel):
    goal: int


class UserAdminItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    email: str
    role: str
    status: str  # pending, active, inactive
    created_at: datetime
    ticket_count: int
    today_count: int
    tracked_today: int
    daily_goal: int
    monthly_cost: float
    last_login: datetime | None = None


class UserResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    email: str
    role: str
    created_at: datetime
    has_api_key: bool


# Generate schemas
class ImageInput(BaseModel):
    base64: str
    media_type: str = "image/png"


class GenerateRequest(BaseModel):
    message: str
    platform_id: int
    images: Optional[List[ImageInput]] = None
    # Legacy single-image fields kept for backward compatibility
    image_base64: Optional[str] = None
    image_media_type: str = "image/png"
    agent_notes: Optional[str] = None
    override_rules: bool = False
    cms_account: Optional[dict] = None
    cms_not_found: bool = False
    cms_no_subscription: bool = False
    checked_emails: Optional[List[str]] = None
    automated: bool = False  # Full Automated bulk run — enables spam short-circuit


class ParsedData(BaseModel):
    customer_name: Optional[str] = None
    customer_email: Optional[str] = None
    account_number: Optional[str] = None
    device: Optional[str] = None
    problem_summary: Optional[str] = None
    context: Optional[str] = None
    payment_handler: Optional[str] = None
    ticket_type: Optional[str] = None  # "technical" | "billing"
    incident_dates: Optional[list] = None  # dates the customer says the problem occurred (YYYY-MM-DD)
    is_spam: bool = False  # parser flagged the message as spam/solicitation/phishing (skip generation)
    spam_reason: Optional[str] = None

    @field_validator(
        "customer_name", "customer_email", "account_number", "device",
        "problem_summary", "context", "payment_handler", "ticket_type",
        mode="before",
    )
    @classmethod
    def _coerce_list_to_str(cls, v):
        # The parser model occasionally returns a list where a string is expected.
        if isinstance(v, list):
            return ", ".join(str(x) for x in v if x is not None) or None
        return v


class FAQSource(BaseModel):
    chunk_id: int
    content_preview: str
    similarity: float


class CannedSource(BaseModel):
    title: str
    similarity: float


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
    learned_count: int = 0
    is_spam: bool = False


# Platform schemas
class PlatformResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    slug: str
    logo_url: Optional[str] = None


# FAQ schemas
class FAQDocumentResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    filename: str
    uploaded_at: datetime
    chunk_count: int
    platform_id: int


class FAQChunkResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    chunk_index: int
    content: str


# History schemas
class HistoryItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    customer_name: Optional[str]
    problem_summary: Optional[str]
    created_at: datetime
    feedback: Optional[str]
    response_preview: str


class HistoryDetail(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    customer_name: Optional[str]
    customer_message: str
    parsed_data: Optional[dict]
    generated_response: str
    created_at: datetime
    feedback: Optional[str]


class FeedbackRequest(BaseModel):
    feedback: str  # 'useful' or 'not_useful'


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
    feedback: Optional[str] = None
    review_status: Optional[str] = None


class ReviewQueueResponse(BaseModel):
    count: int
    items: List[ReviewQueueItem]


class AdjustCounterRequest(BaseModel):
    delta: int  # +1 or -1


# Insights schemas
class TrendItem(BaseModel):
    title: str
    description: str
    count: int
    ticket_ids: List[int] = []


class TrendsResponse(BaseModel):
    trends: List[TrendItem]
    total_tickets_analyzed: int
    generated_at: datetime


# Ticket Tracker schemas
class TicketLogCreate(BaseModel):
    ticket_url: str
    cover_user_id: int | None = None


class TicketLogResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    ticket_url: str
    worked_at: datetime


class ApiKeyResponse(BaseModel):
    api_key: Optional[str]
