from datetime import datetime, timezone, timedelta
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.auth.routes import get_current_user
from app.database import get_db
from app.models import User, ResponseHistory, TicketLog, DailyUpdateReport

router = APIRouter()

@router.get("/usage")
def get_usage_report(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not getattr(current_user, "is_superadmin", False):
        raise HTTPException(status_code=403, detail="Not authorized")
    users = db.query(User).filter(User.status != 'inactive').order_by(User.username).all()

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    week_start = today_start - timedelta(days=today_start.weekday())
    month_start = today_start.replace(day=1)

    result = []
    for u in users:
        def resp_count(since, uid=u.id):
            return db.query(func.count(ResponseHistory.id)).filter(
                ResponseHistory.user_id == uid,
                ResponseHistory.created_at >= since
            ).scalar() or 0

        def du_count(since, uid=u.id):
            return db.query(func.count(DailyUpdateReport.id)).filter(
                DailyUpdateReport.user_id == uid,
                DailyUpdateReport.created_at >= since
            ).scalar() or 0

        def tl_count(since, uid=u.id):
            return db.query(func.count(TicketLog.id)).filter(
                TicketLog.user_id == uid,
                TicketLog.worked_at >= since
            ).scalar() or 0

        def du_cost(since, uid=u.id):
            return db.query(func.coalesce(func.sum(DailyUpdateReport.cost), 0.0)).filter(
                DailyUpdateReport.user_id == uid,
                DailyUpdateReport.created_at >= since
            ).scalar() or 0.0

        # Response cost: use monthly_cost for current month, sum from DB for other periods
        resp_cost_month = u.monthly_cost if u.monthly_cost_month == datetime.now(timezone.utc).strftime("%Y-%m") else 0.0

        result.append({
            "id": u.id,
            "username": u.username,
            "email": u.email,
            "role": u.role,
            "responses": {
                "today": resp_count(today_start),
                "week": resp_count(week_start),
                "month": resp_count(month_start),
                "total": resp_count(datetime(2000, 1, 1)),
            },
            "daily_updates": {
                "today": du_count(today_start),
                "week": du_count(week_start),
                "month": du_count(month_start),
                "total": du_count(datetime(2000, 1, 1)),
            },
            "ticket_logs": {
                "today": tl_count(today_start),
                "week": tl_count(week_start),
                "month": tl_count(month_start),
                "total": tl_count(datetime(2000, 1, 1)),
            },
            "cost": {
                "today":  round(du_cost(today_start), 4),
                "week":   round(du_cost(week_start), 4),
                "month":  round((resp_cost_month or 0.0) + du_cost(month_start), 4),
                "total":  round((resp_cost_month or 0.0) + du_cost(datetime(2000, 1, 1)), 4),
                "responses_month": round(resp_cost_month or 0.0, 4),
                "daily_updates_month": round(du_cost(month_start), 4),
            },
        })

    return result
