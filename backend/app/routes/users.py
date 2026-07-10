# backend/app/routes/users.py
from datetime import datetime
from typing import List
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.auth.routes import require_admin, get_current_user
from app.database import get_db
from app.models import User, ResponseHistory, TicketLog
from app.schemas import UserAdminItem, SetGoalRequest

router = APIRouter()


def _today_start() -> datetime:
    from datetime import timezone, timedelta
    tz_cr = timezone(timedelta(hours=-6))
    now_cr = datetime.now(tz_cr).replace(hour=0, minute=0, second=0, microsecond=0)
    return now_cr.astimezone(timezone.utc).replace(tzinfo=None)


@router.get("/", response_model=List[UserAdminItem])
async def list_users(
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    users = db.query(User).order_by(User.created_at.desc()).all()

    total_counts = dict(
        db.query(ResponseHistory.user_id, func.count(ResponseHistory.id))
        .group_by(ResponseHistory.user_id)
        .all()
    )

    today_counts = dict(
        db.query(ResponseHistory.user_id, func.count(ResponseHistory.id))
        .filter(ResponseHistory.created_at >= _today_start())
        .group_by(ResponseHistory.user_id)
        .all()
    )

    tracked_today_counts = dict(
        db.query(TicketLog.user_id, func.count(TicketLog.id))
        .filter(TicketLog.worked_at >= _today_start())
        .group_by(TicketLog.user_id)
        .all()
    )

    result = []
    for u in users:
        raw_offset = u.daily_offset or 0
        today_date = datetime.utcnow().strftime("%Y-%m-%d")
        offset = raw_offset if u.daily_offset_date == today_date else 0
        result.append(UserAdminItem(
            id=u.id,
            username=u.username,
            email=u.email,
            role=u.role,
            status=u.status or "active",
            created_at=u.created_at,
            ticket_count=total_counts.get(u.id, 0),
            today_count=today_counts.get(u.id, 0) + offset,
            tracked_today=tracked_today_counts.get(u.id, 0),
            daily_goal=u.daily_goal or 35,
            monthly_cost=u.monthly_cost or 0.0,
            last_login=u.last_login,
        ))
    return result


@router.patch("/{user_id}/status")
async def set_user_status(
    user_id: int,
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot change your own status")

    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    current_status = user.status or "active"
    if current_status == "pending":
        user.status = "active"
        user.is_active = True
    elif current_status == "active":
        user.status = "inactive"
        user.is_active = False
    else:
        user.status = "active"
        user.is_active = True

    db.commit()
    return {"id": user.id, "username": user.username, "status": user.status}


@router.patch("/{user_id}/goal")
async def set_user_goal(
    user_id: int,
    request: SetGoalRequest,
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    if request.goal < 1:
        raise HTTPException(status_code=400, detail="Goal must be at least 1")

    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    user.daily_goal = request.goal
    db.commit()
    return {"id": user.id, "username": user.username, "daily_goal": user.daily_goal}


@router.delete("/{user_id}")
async def delete_user(
    user_id: int,
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot delete your own account")

    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    if user.role == "admin":
        raise HTTPException(status_code=400, detail="Cannot delete another admin")

    # Remove all dependent rows first — their user_id columns are NOT NULL, so
    # SQLAlchemy's default null-out on delete violates the constraint (500s).
    from app.models import DailyUpdateReport, TrackerComment, FAQDocument
    db.query(ResponseHistory).filter(ResponseHistory.user_id == user_id).delete()
    db.query(TicketLog).filter(TicketLog.user_id == user_id).delete()
    db.query(DailyUpdateReport).filter(DailyUpdateReport.user_id == user_id).delete()
    db.query(TrackerComment).filter(TrackerComment.user_id == user_id).delete()
    # uploaded_by is nullable — keep the documents, just detach the uploader
    db.query(FAQDocument).filter(FAQDocument.uploaded_by == user_id).update({"uploaded_by": None})
    db.delete(user)
    db.commit()
    return {"message": f"User {user.username} deleted"}

@router.get("/me")
def get_my_profile(current_user: User = Depends(get_current_user)):
    return {
        "id": current_user.id,
        "username": current_user.username,
        "email": current_user.email,
        "role": current_user.role,
        "freshdesk_api_key": current_user.freshdesk_api_key or "",
        "is_superadmin": bool(getattr(current_user, "is_superadmin", False)),
    }

@router.put("/me/freshdesk-key")
def update_freshdesk_key(
    body: dict,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    key = body.get("freshdesk_api_key", "").strip()
    user = db.query(User).filter(User.id == current_user.id).first()
    user.freshdesk_api_key = key or None
    db.commit()
    return {"ok": True, "freshdesk_api_key": user.freshdesk_api_key or ""}


@router.get("/me/api-key")
def get_my_api_key(
    current_user: User = Depends(get_current_user),
):
    return {"api_key": current_user.api_key or ""}


@router.post("/me/api-key")
def generate_my_api_key(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    import secrets
    user = db.query(User).filter(User.id == current_user.id).first()
    user.api_key = secrets.token_hex(32)
    db.commit()
    return {"api_key": user.api_key}



@router.patch("/{user_id}/role")
async def toggle_user_role(
    user_id: int,
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot change your own role")

    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    if getattr(user, "is_superadmin", False):
        raise HTTPException(status_code=400, detail="Cannot change the superadmin role")

    user.role = "admin" if user.role != "admin" else "agent"
    db.commit()
    return {"id": user.id, "username": user.username, "role": user.role}


@router.put("/me/username")
def update_username(
    body: dict,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    new_username = (body.get("username") or "").strip()
    if not new_username:
        raise HTTPException(status_code=400, detail="Username cannot be empty")
    if len(new_username) < 3:
        raise HTTPException(status_code=400, detail="Username must be at least 3 characters")
    if len(new_username) > 40:
        raise HTTPException(status_code=400, detail="Username must be 40 characters or less")
    existing = db.query(User).filter(User.username == new_username).first()
    if existing and existing.id != current_user.id:
        raise HTTPException(status_code=409, detail="Username already taken")
    user = db.query(User).filter(User.id == current_user.id).first()
    user.username = new_username
    db.commit()
    return {"username": user.username}


@router.get("/{user_id}/tickets")
async def get_user_ticket_logs(
    user_id: int,
    date: str = None,
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    from datetime import timedelta
    from datetime import timedelta as _td
    CR_OFFSET = _td(hours=6)
    if date:
        try:
            day_start = datetime.fromisoformat(date) + CR_OFFSET
        except ValueError:
            day_start = _today_start()
    else:
        day_start = _today_start()
    day_end = day_start + _td(days=1)

    logs = (
        db.query(TicketLog)
        .filter(
            TicketLog.user_id == user_id,
            TicketLog.worked_at >= day_start,
            TicketLog.worked_at < day_end,
        )
        .order_by(TicketLog.worked_at.desc())
        .all()
    )

    return [
        {
            "id": log.id,
            "ticket_id": log.ticket_url.rstrip("/").split("/")[-1],
            "ticket_url": log.ticket_url,
            "worked_at": log.worked_at.isoformat() + "Z",
        }
        for log in logs
    ]

