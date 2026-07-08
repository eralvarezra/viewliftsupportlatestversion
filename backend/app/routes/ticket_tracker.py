from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import User, TicketLog
from app.auth.routes import get_current_user
from app.schemas import TicketLogCreate, TicketLogResponse

router = APIRouter()
security = HTTPBearer(auto_error=False)

FRESHDESK_URL_PREFIX = "https://viewlift.freshdesk.com/a/tickets/"


def get_user_by_api_key(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: Session = Depends(get_db),
) -> User:
    if credentials is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = db.query(User).filter(User.api_key == credentials.credentials).first()
    if not user:
        raise HTTPException(status_code=401, detail="Invalid API key")
    return user


@router.post("/", response_model=TicketLogResponse)
async def log_ticket(
    body: TicketLogCreate,
    user: User = Depends(get_user_by_api_key),
    db: Session = Depends(get_db),
):
    if not body.ticket_url.startswith(FRESHDESK_URL_PREFIX):
        raise HTTPException(status_code=400, detail="Invalid ticket URL")

    log = TicketLog(
        user_id=user.id,
        ticket_url=body.ticket_url,
        worked_at=datetime.utcnow(),
    )
    db.add(log)
    db.commit()
    db.refresh(log)
    return log


@router.get("/stats")
async def get_ticket_stats(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    from datetime import timedelta
    tz_cr = timezone(timedelta(hours=-6))
    today_start = datetime.now(tz_cr).replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc).replace(tzinfo=None)
    today_count = (
        db.query(func.count(TicketLog.id))
        .filter(TicketLog.user_id == current_user.id, TicketLog.worked_at >= today_start)
        .scalar()
    )
    return {"today_count": today_count, "daily_goal": current_user.daily_goal}


@router.get("/", response_model=list[TicketLogResponse])
async def get_ticket_logs(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    logs = (
        db.query(TicketLog)
        .filter(TicketLog.user_id == current_user.id)
        .order_by(TicketLog.worked_at.desc())
        .all()
    )
    return logs


@router.delete("/{log_id}", status_code=204)
async def delete_ticket_log(
    log_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    log = db.query(TicketLog).filter(TicketLog.id == log_id, TicketLog.user_id == current_user.id).first()
    if not log:
        raise HTTPException(status_code=404, detail="Log not found")
    db.delete(log)
    db.commit()


@router.post("/log-reply")
async def log_reply_ticket(
    body: TicketLogCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    '''Log a ticket to today tracker when a bot reply is sent (JWT auth).'''
    if not body.ticket_url.startswith(FRESHDESK_URL_PREFIX):
        raise HTTPException(status_code=400, detail='Invalid ticket URL')
    log_user_id = current_user.id
    if body.cover_user_id and current_user.role == "admin":
        from app.models import User as UserModel
        covered = db.query(UserModel).filter(UserModel.id == body.cover_user_id).first()
        if covered:
            log_user_id = covered.id
    from datetime import timedelta
    dedup_window = datetime.utcnow() - timedelta(seconds=30)
    existing = (
        db.query(TicketLog)
        .filter(
            TicketLog.user_id == log_user_id,
            TicketLog.ticket_url == body.ticket_url,
            TicketLog.worked_at >= dedup_window,
        )
        .first()
    )
    if existing:
        return existing
    log = TicketLog(
        user_id=log_user_id,
        ticket_url=body.ticket_url,
        worked_at=datetime.utcnow(),
    )
    db.add(log)
    db.commit()
    db.refresh(log)
    return log
