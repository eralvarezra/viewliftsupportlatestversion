# backend/app/routes/insights.py
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth.routes import require_admin
from app.config import settings
from app.database import get_db
from app.models import User, ResponseHistory
from app.schemas import TrendsResponse
from app.services.claude_client import ClaudeClient

router = APIRouter()

_MAX_RECORDS_PER_USER = 100


@router.post("/trends", response_model=TrendsResponse)
async def analyze_trends(
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    users = db.query(User).filter(User.is_active == True).all()

    summaries = []
    for user in users:
        records = (
            db.query(ResponseHistory)
            .filter(ResponseHistory.user_id == user.id)
            .order_by(ResponseHistory.created_at.desc())
            .limit(_MAX_RECORDS_PER_USER)
            .all()
        )
        for record in records:
            if record.parsed_data and isinstance(record.parsed_data, dict):
                summary = record.parsed_data.get("problem_summary")
                if summary:
                    summaries.append(summary)

    claude = ClaudeClient(api_key=settings.ANTHROPIC_API_KEY)
    return claude.analyze_trends(summaries)
