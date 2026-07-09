# backend/app/models.py
from datetime import datetime
from sqlalchemy.sql import func
from sqlalchemy import Column, Integer, String, Text, DateTime, JSON, LargeBinary, ForeignKey, Boolean, Float
from sqlalchemy.orm import relationship
from app.database import Base


class Platform(Base):
    __tablename__ = "platforms"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    slug = Column(String, unique=True, nullable=False, index=True)
    logo_url = Column(String, nullable=True)
    cms_url = Column(String, nullable=True)
    is_global = Column(Boolean, default=False, nullable=False, server_default="0")
    location_rules = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    faq_documents = relationship("FAQDocument", back_populates="platform")
    responses = relationship("ResponseHistory", back_populates="platform")


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, index=True, nullable=False)
    email = Column(String, unique=True, index=True, nullable=False)
    password_hash = Column(String, nullable=False)
    role = Column(String, default="agent")  # 'agent' or 'admin'
    groq_api_key = Column(String, nullable=True)
    is_active = Column(Boolean, default=True, nullable=False)
    status = Column(String, default="active", nullable=False)  # pending, active, inactive
    created_at = Column(DateTime, default=datetime.utcnow)
    last_login = Column(DateTime, nullable=True)
    ticket_total = Column(Integer, default=0, nullable=False)
    daily_offset = Column(Integer, default=0, nullable=False)
    daily_offset_date = Column(String, nullable=True)  # YYYY-MM-DD
    daily_goal = Column(Integer, default=35, nullable=False)
    monthly_cost = Column(Float, default=0.0, nullable=False, server_default="0.0")
    monthly_cost_month = Column(String(7), nullable=True)  # YYYY-MM
    api_key = Column(String, unique=True, nullable=True)
    freshdesk_api_key = Column(String, nullable=True)
    is_superadmin = Column(Boolean, default=False, nullable=False, server_default='0')
    ticket_logs = relationship("TicketLog", back_populates="user")
    daily_update_reports = relationship("DailyUpdateReport", back_populates="user")

    responses = relationship("ResponseHistory", back_populates="user")


class FAQDocument(Base):
    __tablename__ = "faq_documents"

    id = Column(Integer, primary_key=True, index=True)
    filename = Column(String, nullable=False)
    uploaded_at = Column(DateTime, default=datetime.utcnow)
    uploaded_by = Column(Integer, ForeignKey("users.id"), index=True)
    chunk_count = Column(Integer, default=0)
    document_type = Column(String, default="faq")  # 'faq' or 'zipcode'
    platform_id = Column(Integer, ForeignKey("platforms.id"), nullable=False, server_default="1")

    chunks = relationship("FAQChunk", back_populates="document", cascade="all, delete-orphan")
    platform = relationship("Platform", back_populates="faq_documents")


class FAQChunk(Base):
    __tablename__ = "faq_chunks"

    id = Column(Integer, primary_key=True, index=True)
    document_id = Column(Integer, ForeignKey("faq_documents.id"), nullable=False, index=True)
    content = Column(Text, nullable=False)
    embedding = Column(LargeBinary, nullable=True)
    chunk_metadata = Column(JSON, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    platform_id = Column(Integer, ForeignKey("platforms.id"), nullable=False, server_default="1")

    document = relationship("FAQDocument", back_populates="chunks")


class ResponseHistory(Base):
    __tablename__ = "response_history"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    customer_name = Column(String, nullable=True)
    customer_message = Column(Text, nullable=False)
    parsed_data = Column(JSON, nullable=True)
    generated_response = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    feedback = Column(String, nullable=True)  # 'useful', 'not_useful', null
    message_embedding = Column(LargeBinary, nullable=True)  # embedding of rated message (lazy: set on rating)
    corrected_response = Column(Text, nullable=True)  # developer's correction from review queue
    review_status = Column(String, nullable=True)  # for not_useful: 'pending' | 'corrected' | 'dismissed'
    learned_examples = Column(JSON, nullable=True)  # [{id, similarity, corrected}] examples injected into this generation
    platform_id = Column(Integer, ForeignKey("platforms.id"), nullable=False, server_default="1")

    user = relationship("User", back_populates="responses")
    platform = relationship("Platform", back_populates="responses")


class TicketLog(Base):
    __tablename__ = "ticket_logs"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    ticket_url = Column(String, nullable=False)
    worked_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    user = relationship("User", back_populates="ticket_logs")

class DailyUpdateReport(Base):
    __tablename__ = "daily_update_reports"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    filename = Column(String, nullable=True)
    total_tickets = Column(Integer, default=0)
    total_tracked = Column(Integer, default=0)
    result_json = Column(JSON, nullable=False)
    cost = Column(Float, default=0.0, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    user = relationship("User", back_populates="daily_update_reports")


class AppSetting(Base):
    __tablename__ = "app_settings"
    key = Column(String, primary_key=True)
    value = Column(String, nullable=False)


class TrackerComment(Base):
    __tablename__ = "tracker_comments"

    id = Column(Integer, primary_key=True, index=True)
    tracker_id = Column(Integer, nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    body = Column(Text, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    user = relationship("User")


class CannedResponse(Base):
    __tablename__ = "canned_responses"

    id = Column(Integer, primary_key=True, index=True)
    freshdesk_id = Column(Integer, unique=True, nullable=False, index=True)
    freshdesk_folder_id = Column(Integer, nullable=False)
    title = Column(String, nullable=False)
    content = Column(Text, nullable=False)
    platform_id = Column(Integer, ForeignKey("platforms.id"), nullable=True)  # NULL = all platforms
    content_html = Column(Text, nullable=True)
    embedding = Column(LargeBinary, nullable=True)
    synced_at = Column(DateTime, default=datetime.utcnow)

    platform = relationship("Platform")


class AutomatedClaim(Base):
    __tablename__ = "automated_claims"

    id = Column(Integer, primary_key=True, index=True)
    ticket_id = Column(Integer, unique=True, index=True, nullable=False)
    claimed_by = Column(Integer, nullable=True)
    claimed_by_name = Column(String, nullable=True)
    subject = Column(String, nullable=True)
    platform = Column(String, nullable=True)
    url = Column(String, nullable=True)
    status = Column(String, default="working")  # working|sent|skipped|released|expired
    claimed_at = Column(DateTime, default=datetime.utcnow)
    expires_at = Column(DateTime, nullable=True)
