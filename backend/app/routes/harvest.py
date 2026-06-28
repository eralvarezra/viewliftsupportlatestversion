
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
import requests as http_req
from datetime import date, timedelta
import calendar

from app.database import get_db
from app.models import User, AppSetting
from app.auth.routes import get_current_user
from app.auth.utils import encrypt_api_key, decrypt_api_key

router = APIRouter()

HARVEST_BASE = "https://api.harvestapp.com/v2"


def _get_token(user_id: int, db: Session):
    row = db.query(AppSetting).filter(AppSetting.key == f"harvest_token_{user_id}").first()
    if not row:
        return None
    try:
        return decrypt_api_key(row.value)
    except Exception:
        return row.value


@router.put("/config")
async def save_harvest_config(
    payload: dict,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    token = payload.get("harvest_token", "").strip()
    if not token:
        raise HTTPException(status_code=400, detail="harvest_token is required")
    encrypted = encrypt_api_key(token)
    row = db.query(AppSetting).filter(AppSetting.key == f"harvest_token_{current_user.id}").first()
    if row:
        row.value = encrypted
    else:
        db.add(AppSetting(key=f"harvest_token_{current_user.id}", value=encrypted))
    db.commit()
    return {"ok": True}


@router.get("/config")
async def get_harvest_config(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    token = _get_token(current_user.id, db)
    return {"configured": bool(token)}


@router.get("/report")
async def get_harvest_report(
    from_date: str = None,
    to_date: str = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    token = _get_token(current_user.id, db)
    if not token:
        raise HTTPException(status_code=400, detail="Harvest token not configured")

    headers = {
        "Authorization": f"Bearer {token}",
        "Harvest-Account-Id": "",
        "User-Agent": "SCHN Support Bot",
    }

    # Get user info
    me_r = http_req.get(f"{HARVEST_BASE}/users/me", headers=headers, timeout=10)
    if me_r.status_code == 401:
        raise HTTPException(status_code=400, detail="Invalid Harvest token")
    me = me_r.json()
    harvest_user_id = me.get("id")
    default_rate = float(me.get("default_hourly_rate") or me.get("cost_rate") or 0.0)
    user_name = f"{me.get('first_name', '')} {me.get('last_name', '')}".strip()

    # Get account id
    accounts_r = http_req.get("https://id.getharvest.com/api/v2/accounts",
        headers={"Authorization": f"Bearer {token}", "User-Agent": "SCHN Support Bot"}, timeout=10)
    accounts = accounts_r.json().get("accounts", [])
    if not accounts:
        raise HTTPException(status_code=400, detail="No Harvest accounts found")
    account_id = str(accounts[0]["id"])
    headers["Harvest-Account-Id"] = account_id

    # Default to current month if no dates given
    today = date.today()
    if not from_date:
        from_date = today.replace(day=1).isoformat()
    if not to_date:
        to_date = today.isoformat()

    fd = date.fromisoformat(from_date)
    td = date.fromisoformat(to_date)
    month_name = fd.strftime("%B %Y")

    # Capacity: business days in range * 8h
    business_days = sum(1 for i in range((td - fd).days + 1) if (fd + timedelta(i)).weekday() < 5)
    capacity_hours = business_days * 8

    # Count unique weekend days worked
    params = {"from": from_date, "to": to_date, "user_id": harvest_user_id, "per_page": 100}
    entries_r = http_req.get(f"{HARVEST_BASE}/time_entries", headers=headers, params=params, timeout=15)
    if entries_r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Harvest API error: {entries_r.status_code}")
    entries = entries_r.json().get("time_entries", [])

    # Metrics
    billable_hours = round(sum(e["hours"] for e in entries if e.get("billable")), 2)
    total_hours = round(sum(e["hours"] for e in entries), 2)
    time_off_hours = round(total_hours - billable_hours, 2)
    approved_hours = round(sum(e["hours"] for e in entries if e.get("billable") and e.get("is_locked")), 2)
    pending_hours = round(billable_hours - approved_hours, 2)

    # Weekend days with billable hours
    weekend_dates = set()
    for e in entries:
        if e.get("billable") and e.get("spent_date"):
            d = date.fromisoformat(e["spent_date"])
            if d.weekday() >= 5:
                weekend_dates.add(e["spent_date"])
    weekend_days = len(weekend_dates)
    weekend_bonus = weekend_days * 20.0

    # Monthly salary-based rate:  / full month business hours
    MONTHLY_SALARY = 900.0
    month_start = fd.replace(day=1)
    last_day = fd.replace(day=calendar.monthrange(fd.year, fd.month)[1])
    monthly_business_days = sum(1 for i in range((last_day - month_start).days + 1)
                                if (month_start + timedelta(i)).weekday() < 5)
    monthly_hours = monthly_business_days * 8
    hourly_rate = round(MONTHLY_SALARY / monthly_hours, 6) if monthly_hours else 0.0

    # Confirmed payment: only approved hours
    effective_hours = min(approved_hours, capacity_hours)
    earned = round(effective_hours * hourly_rate, 2)
    total_payment = round(earned + weekend_bonus, 2)

    # Pre-calculation: projected if pending hours get approved
    remaining_capacity = max(capacity_hours - effective_hours, 0)
    pending_effective = min(pending_hours, remaining_capacity)
    pending_earned = round(pending_effective * hourly_rate, 2)
    projected_total = round(total_payment + pending_earned, 2)

    # Project breakdown
    projects = {}
    for e in entries:
        pname = e.get("project", {}).get("name", "Unknown")
        is_time_off = not e.get("billable", True)
        if pname not in projects:
            projects[pname] = {"name": pname, "hours": 0.0, "billable": e.get("billable", False),
                               "is_time_off": is_time_off, "approved": 0.0, "pending": 0.0}
        projects[pname]["hours"] = round(projects[pname]["hours"] + e["hours"], 2)
        if e.get("billable"):
            if e.get("is_locked"):
                projects[pname]["approved"] = round(projects[pname]["approved"] + e["hours"], 2)
            else:
                projects[pname]["pending"] = round(projects[pname]["pending"] + e["hours"], 2)

    return {
        "name": user_name,
        "month": month_name,
        "from_date": from_date,
        "to_date": to_date,
        "billable_hours": billable_hours,
        "total_hours": total_hours,
        "time_off_hours": time_off_hours,
        "approved_hours": approved_hours,
        "pending_hours": pending_hours,
        "pending_billable": pending_hours,
        "capacity_hours": capacity_hours,
        "monthly_hours": monthly_hours,
        "hourly_rate": hourly_rate,
        "effective_hours": effective_hours,
        "earned": earned,
        "weekend_bonus": weekend_bonus,
        "weekend_days": weekend_days,
        "total_payment": total_payment,
        "pending_earned": pending_earned,
        "projected_total": projected_total,
        "projects": list(projects.values()),
    }


@router.get("/projects")
async def get_harvest_projects(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    token = _get_token(current_user.id, db)
    if not token:
        raise HTTPException(status_code=400, detail="Harvest token not configured")

    headers = {"Authorization": f"Bearer {token}", "User-Agent": "SCHN Support Bot", "Harvest-Account-Id": ""}
    accounts_r = http_req.get("https://id.getharvest.com/api/v2/accounts",
        headers={"Authorization": f"Bearer {token}", "User-Agent": "SCHN Support Bot"}, timeout=10)
    accounts = accounts_r.json().get("accounts", [])
    if not accounts:
        raise HTTPException(status_code=400, detail="No Harvest accounts found")
    headers["Harvest-Account-Id"] = str(accounts[0]["id"])

    r = http_req.get(f"{HARVEST_BASE}/users/me/project_assignments",
        headers=headers, params={"is_active": "true", "per_page": 100}, timeout=15)
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail="Failed to fetch projects")

    projects = []
    for a in r.json().get("project_assignments", []):
        proj = a.get("project", {})
        tasks = [t for t in a.get("task_assignments", []) if t.get("is_active", True)]
        if tasks:
            projects.append({
                "project_id": proj.get("id"),
                "project_name": proj.get("name"),
                "task_id": tasks[0].get("task", {}).get("id"),
                "task_name": tasks[0].get("task", {}).get("name"),
            })
    return {"projects": projects}


@router.post("/time-entries")
async def submit_time_entries(
    payload: dict,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    token = _get_token(current_user.id, db)
    if not token:
        raise HTTPException(status_code=400, detail="Harvest token not configured")

    headers = {"Authorization": f"Bearer {token}", "User-Agent": "SCHN Support Bot", "Harvest-Account-Id": ""}
    accounts_r = http_req.get("https://id.getharvest.com/api/v2/accounts",
        headers={"Authorization": f"Bearer {token}", "User-Agent": "SCHN Support Bot"}, timeout=10)
    accounts = accounts_r.json().get("accounts", [])
    if not accounts:
        raise HTTPException(status_code=400, detail="No Harvest accounts found")
    headers["Harvest-Account-Id"] = str(accounts[0]["id"])

    entries = payload.get("entries", [])
    if not entries:
        raise HTTPException(status_code=400, detail="No entries provided")

    submitted, errors = [], []
    for entry in entries:
        r = http_req.post(f"{HARVEST_BASE}/time_entries", headers=headers, json={
            "project_id": entry["project_id"],
            "task_id": entry["task_id"],
            "spent_date": entry["spent_date"],
            "hours": entry.get("hours", 8.0),
        }, timeout=10)
        if r.status_code in (200, 201):
            submitted.append(entry["spent_date"])
        else:
            errors.append({"date": entry["spent_date"], "error": r.text[:200]})

    return {"submitted": len(submitted), "errors": errors}


@router.get("/entries")
async def get_week_entries(
    from_date: str = None,
    to_date: str = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    token = _get_token(current_user.id, db)
    if not token:
        raise HTTPException(status_code=400, detail="Harvest token not configured")

    headers = {"Authorization": f"Bearer {token}", "User-Agent": "SCHN Support Bot", "Harvest-Account-Id": ""}
    accounts_r = http_req.get("https://id.getharvest.com/api/v2/accounts",
        headers={"Authorization": f"Bearer {token}", "User-Agent": "SCHN Support Bot"}, timeout=10)
    accounts = accounts_r.json().get("accounts", [])
    if not accounts:
        raise HTTPException(status_code=400, detail="No Harvest accounts found")
    headers["Harvest-Account-Id"] = str(accounts[0]["id"])

    me_r = http_req.get(f"{HARVEST_BASE}/users/me", headers=headers, timeout=10)
    harvest_user_id = me_r.json().get("id") if me_r.status_code == 200 else None

    params = {"per_page": 100}
    if from_date:
        params["from"] = from_date
    if to_date:
        params["to"] = to_date
    if harvest_user_id:
        params["user_id"] = harvest_user_id

    r = http_req.get(f"{HARVEST_BASE}/time_entries", headers=headers, params=params, timeout=15)
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Harvest API error: {r.status_code}")

    entries = r.json().get("time_entries", [])
    return {
        "entries": [
            {
                "id": e.get("id"),
                "spent_date": e.get("spent_date"),
                "hours": e.get("hours"),
                "project_id": e.get("project", {}).get("id"),
                "project_name": e.get("project", {}).get("name"),
                "is_locked": e.get("is_locked", False),
            }
            for e in entries
        ]
    }


@router.post("/timesheets/submit")
async def submit_week_for_approval(
    payload: dict,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    token = _get_token(current_user.id, db)
    if not token:
        raise HTTPException(status_code=400, detail="Harvest token not configured")

    week_of = payload.get("week_of")  # YYYY-MM-DD (Monday of the week)
    if not week_of:
        raise HTTPException(status_code=400, detail="week_of is required")

    base_headers = {"Authorization": f"Bearer {token}", "User-Agent": "SCHN Support Bot"}
    accounts_r = http_req.get("https://id.getharvest.com/api/v2/accounts", headers=base_headers, timeout=10)
    if accounts_r.status_code != 200:
        raise HTTPException(status_code=400, detail="Could not fetch Harvest accounts")
    accounts = accounts_r.json().get("accounts", [])
    if not accounts:
        raise HTTPException(status_code=400, detail="No Harvest accounts found")

    headers = {**base_headers, "Harvest-Account-Id": str(accounts[0]["id"]), "Content-Type": "application/json"}

    # Step 1: Find the timesheet for this week
    ts_r = http_req.get(f"{HARVEST_BASE}/timesheets", headers=headers, params={"week_of": week_of}, timeout=10)
    if ts_r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Could not fetch timesheets: {ts_r.status_code} — {ts_r.text[:200]}")

    ts_data = ts_r.json()
    timesheets = ts_data.get("timesheets", [])
    if not timesheets:
        raise HTTPException(status_code=404, detail=f"No timesheet found for week {week_of}. Log time entries first. Raw: {str(ts_data)[:300]}")

    timesheet_id = timesheets[0]["id"]
    ts_status = timesheets[0].get("status", "open")

    if ts_status in ("pending_approval", "approved"):
        return {"ok": True, "message": "Week is already submitted", "status": ts_status}

    # Step 2: Submit it
    r = http_req.post(
        f"{HARVEST_BASE}/timesheets/{timesheet_id}/submit",
        headers=headers,
        timeout=10,
    )

    if r.status_code in (200, 201):
        return {"ok": True, "message": "Week submitted for approval", "status": "pending_approval"}
    else:
        raise HTTPException(status_code=502, detail=f"Harvest {r.status_code} on submit: {r.text[:400]}")


@router.get("/timesheets/status")
async def get_week_timesheet_status(
    week_of: str = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Check if a week has already been submitted for approval."""
    token = _get_token(current_user.id, db)
    if not token:
        raise HTTPException(status_code=400, detail="Harvest token not configured")
    if not week_of:
        raise HTTPException(status_code=400, detail="week_of is required")

    base_headers = {"Authorization": f"Bearer {token}", "User-Agent": "SCHN Support Bot"}
    accounts_r = http_req.get("https://id.getharvest.com/api/v2/accounts", headers=base_headers, timeout=10)
    accounts = accounts_r.json().get("accounts", []) if accounts_r.status_code == 200 else []
    if not accounts:
        raise HTTPException(status_code=400, detail="No Harvest accounts found")

    headers = {**base_headers, "Harvest-Account-Id": str(accounts[0]["id"])}

    r = http_req.get(f"{HARVEST_BASE}/timesheets", headers=headers, params={"week_of": week_of}, timeout=10)
    if r.status_code != 200:
        return {"submitted": False, "status": "unknown"}

    data = r.json()
    timesheets = data.get("timesheets", [])
    if not timesheets:
        return {"submitted": False, "status": "open"}

    ts = timesheets[0]
    status = ts.get("status", "open")
    return {
        "submitted": status in ("pending_approval", "approved"),
        "status": status,
        "timesheet_id": ts.get("id"),
    }
