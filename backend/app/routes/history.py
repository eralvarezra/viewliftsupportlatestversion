# backend/app/routes/history.py
from datetime import datetime, timedelta
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.auth.routes import get_current_user
from app.database import get_db
from app.models import User, ResponseHistory
from app.schemas import (
    HistoryItem, HistoryDetail, FeedbackRequest, UserStats, AdjustCounterRequest, SetGoalRequest,
    CorrectRequest, ReviewQueueItem, ReviewQueueResponse,
)

router = APIRouter()


def _today_str() -> str:
    return datetime.utcnow().strftime("%Y-%m-%d")


def _today_start() -> datetime:
    return datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)


def _cleanup_old_history(user_id: int, db: Session):
    """Delete response history records older than today (UTC).

    Rated entries (feedback set) are the bot's learning corpus — never pruned."""
    db.query(ResponseHistory).filter(
        ResponseHistory.user_id == user_id,
        ResponseHistory.created_at < _today_start(),
        ResponseHistory.feedback.is_(None),
    ).delete(synchronize_session=False)
    db.commit()


def _feedback_embedding_text(entry: ResponseHistory) -> str:
    """Same semantics as /generate's search query: problem_summary + context, falling back to raw message."""
    pd = entry.parsed_data if isinstance(entry.parsed_data, dict) else {}
    ps = (pd.get("problem_summary") or "").strip()
    ctx = (pd.get("context") or "").strip()
    return f"{ps} {ctx}".strip() if ps else entry.customer_message


def _require_superadmin(user: User) -> None:
    if not getattr(user, "is_superadmin", False):
        raise HTTPException(status_code=403, detail="Superadmin only")


def _ensure_embedding(entry: ResponseHistory) -> None:
    """Compute+store the message embedding. Fail-open: rating must never fail because of this."""
    if entry.message_embedding is not None:
        return
    try:
        from app.services.local_embeddings import LocalEmbeddingService
        svc = LocalEmbeddingService()
        entry.message_embedding = svc.serialize_embedding(svc.get_embedding(_feedback_embedding_text(entry)))
    except Exception:
        pass


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


@router.get("/review-queue", response_model=ReviewQueueResponse)
async def get_review_queue(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Bad responses pending developer review (superadmin, all users)."""
    _require_superadmin(current_user)
    entries = (
        db.query(ResponseHistory)
        .filter(ResponseHistory.feedback == "not_useful", ResponseHistory.review_status == "pending")
        .order_by(ResponseHistory.created_at.desc())
        .limit(200)
        .all()
    )
    items = [
        ReviewQueueItem(
            id=e.id,
            customer_name=e.customer_name,
            customer_message=e.customer_message,
            generated_response=e.generated_response,
            created_at=e.created_at,
            platform_name=e.platform.name if e.platform else None,
            agent_username=e.user.username if e.user else None,
        )
        for e in entries
    ]
    return ReviewQueueResponse(count=len(items), items=items)


@router.get("/recent-responses", response_model=ReviewQueueResponse)
async def get_recent_responses(
    limit: int = Query(50, le=200),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Recent generated responses across all agents, with rating state (superadmin)."""
    _require_superadmin(current_user)
    entries = (
        db.query(ResponseHistory)
        # Legacy verification-step rows aren't customer responses — hide them
        .filter(~ResponseHistory.generated_response.like("[NEEDS_VERIFICATION]%"))
        .order_by(ResponseHistory.created_at.desc())
        .limit(limit)
        .all()
    )
    items = [
        ReviewQueueItem(
            id=e.id,
            customer_name=e.customer_name,
            customer_message=e.customer_message,
            generated_response=e.generated_response,
            created_at=e.created_at,
            platform_name=e.platform.name if e.platform else None,
            agent_username=e.user.username if e.user else None,
            feedback=e.feedback,
            review_status=e.review_status,
        )
        for e in entries
    ]
    return ReviewQueueResponse(count=len(items), items=items)


@router.post("/{history_id}/correct")
async def correct_response(
    history_id: int,
    request: CorrectRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Save the developer's corrected response; the pair becomes a learned example."""
    _require_superadmin(current_user)
    corrected = (request.corrected_response or "").strip()
    if not corrected:
        raise HTTPException(status_code=400, detail="Corrected response cannot be empty")
    entry = db.query(ResponseHistory).filter(ResponseHistory.id == history_id).first()
    if not entry:
        raise HTTPException(status_code=404, detail="History entry not found")
    entry.corrected_response = corrected
    entry.review_status = "corrected"
    entry.feedback = "not_useful"
    _ensure_embedding(entry)
    db.commit()
    return {"message": "Correction saved"}


@router.post("/{history_id}/dismiss")
async def dismiss_response(
    history_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Mark a bad response as not worth learning from."""
    _require_superadmin(current_user)
    entry = db.query(ResponseHistory).filter(ResponseHistory.id == history_id).first()
    if not entry:
        raise HTTPException(status_code=404, detail="History entry not found")
    entry.review_status = "dismissed"
    db.commit()
    return {"message": "Dismissed"}


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

    # Agents can only rate their own responses; superadmin can rate anyone's (Review Queue history)
    query = db.query(ResponseHistory).filter(ResponseHistory.id == history_id)
    if not getattr(current_user, "is_superadmin", False):
        query = query.filter(ResponseHistory.user_id == current_user.id)
    entry = query.first()

    if not entry:
        raise HTTPException(status_code=404, detail="History entry not found")

    entry.feedback = request.feedback
    if request.feedback == "not_useful":
        if entry.review_status not in ("corrected", "dismissed"):
            entry.review_status = "pending"
    else:
        entry.review_status = None
    _ensure_embedding(entry)
    db.commit()

    return {"message": "Feedback updated successfully", "feedback": request.feedback}
