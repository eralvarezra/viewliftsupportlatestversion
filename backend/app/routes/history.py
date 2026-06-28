# backend/app/routes/history.py
from datetime import datetime, timedelta
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.auth.routes import get_current_user
from app.database import get_db
from app.models import User, ResponseHistory
from app.schemas import HistoryItem, HistoryDetail, FeedbackRequest, UserStats, AdjustCounterRequest, SetGoalRequest

router = APIRouter()


def _today_str() -> str:
    return datetime.utcnow().strftime("%Y-%m-%d")


def _today_start() -> datetime:
    return datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)


def _cleanup_old_history(user_id: int, db: Session):
    """Delete response history records older than today (UTC)."""
    db.query(ResponseHistory).filter(
        ResponseHistory.user_id == user_id,
        ResponseHistory.created_at < _today_start(),
    ).delete(synchronize_session=False)
    db.commit()


def _effective_offset(user: User) -> int:
    """Return the daily offset if it was set today, else 0."""
    if user.daily_offset_date == _today_str():
        return user.daily_offset
    return 0


@router.get("/stats", response_model=UserStats)
async def get_stats(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _cleanup_old_history(current_user.id, db)

    today_db = db.query(func.count(ResponseHistory.id)).filter(
        ResponseHistory.user_id == current_user.id,
        ResponseHistory.created_at >= _today_start(),
    ).scalar() or 0

    offset = _effective_offset(current_user)

    return UserStats(
        today_count=today_db + offset,
        daily_goal=current_user.daily_goal or 35,
    )


@router.patch("/stats/adjust", response_model=UserStats)
async def adjust_counter(
    request: AdjustCounterRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    today = _today_str()

    user = db.query(User).filter(User.id == current_user.id).first()

    if user.daily_offset_date != today:
        user.daily_offset = 0
        user.daily_offset_date = today

    user.daily_offset += request.delta

    db.commit()
    db.refresh(user)

    today_db = db.query(func.count(ResponseHistory.id)).filter(
        ResponseHistory.user_id == user.id,
        ResponseHistory.created_at >= _today_start(),
    ).scalar() or 0

    offset = _effective_offset(user)
    return UserStats(
        today_count=today_db + offset,
        daily_goal=user.daily_goal or 35,
    )


@router.get("/", response_model=List[HistoryItem])
async def list_history(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    skip: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=100),
    customer_name: Optional[str] = Query(None),
    days: Optional[int] = Query(None, ge=1),
):
    query = db.query(ResponseHistory).filter(ResponseHistory.user_id == current_user.id)

    if customer_name:
        query = query.filter(ResponseHistory.customer_name.ilike(f"%{customer_name}%"))

    if days:
        cutoff_date = datetime.utcnow() - timedelta(days=days)
        query = query.filter(ResponseHistory.created_at >= cutoff_date)

    entries = query.order_by(ResponseHistory.created_at.desc()).offset(skip).limit(limit).all()

    history_items = []
    for entry in entries:
        response_preview = entry.generated_response[:100] + "..." if len(entry.generated_response) > 100 else entry.generated_response
        problem_summary = entry.parsed_data.get("problem_summary") if entry.parsed_data and isinstance(entry.parsed_data, dict) else None
        history_items.append(HistoryItem(
            id=entry.id,
            customer_name=entry.customer_name,
            problem_summary=problem_summary,
            created_at=entry.created_at,
            feedback=entry.feedback,
            response_preview=response_preview,
        ))

    return history_items


@router.get("/{history_id}", response_model=HistoryDetail)
async def get_history_detail(
    history_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    entry = db.query(ResponseHistory).filter(
        ResponseHistory.id == history_id,
        ResponseHistory.user_id == current_user.id,
    ).first()

    if not entry:
        raise HTTPException(status_code=404, detail="History entry not found")

    return HistoryDetail(
        id=entry.id,
        customer_name=entry.customer_name,
        customer_message=entry.customer_message,
        parsed_data=entry.parsed_data,
        generated_response=entry.generated_response,
        created_at=entry.created_at,
        feedback=entry.feedback,
    )


@router.patch("/{history_id}/feedback")
async def update_feedback(
    history_id: int,
    request: FeedbackRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if request.feedback not in ("useful", "not_useful"):
        raise HTTPException(status_code=400, detail="Feedback must be 'useful' or 'not_useful'")

    entry = db.query(ResponseHistory).filter(
        ResponseHistory.id == history_id,
        ResponseHistory.user_id == current_user.id,
    ).first()

    if not entry:
        raise HTTPException(status_code=404, detail="History entry not found")

    entry.feedback = request.feedback
    db.commit()

    return {"message": "Feedback updated successfully", "feedback": request.feedback}
