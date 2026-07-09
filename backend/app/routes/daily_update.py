import csv
import math
import io
import re
import requests
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, UploadFile, File, HTTPException
from sqlalchemy.orm import Session

from app.auth.routes import get_current_user
from app.database import get_db
from app.models import User, DailyUpdateReport
from app.services.claude_client import ClaudeClient
from app.config import settings

router = APIRouter()

_SONNET_IN  = 3.00  / 1_000_000
_SONNET_OUT = 15.00 / 1_000_000

MAX_TICKETS = 300
FRESHDESK_BASE = f"https://{settings.FRESHDESK_DOMAIN}/api/v2"
FRESHDESK_AUTH = (settings.FRESHDESK_API_KEY, "X")




def _build_history_context(db: Session, days: int = 7, max_reports: int = 10) -> str:
    """Compact summary of recent daily reports so the model can spot patterns
    across days (recurring/escalating issues). One line per report."""
    from datetime import timedelta
    cutoff = datetime.utcnow() - timedelta(days=days)
    reports = (
        db.query(DailyUpdateReport)
        .filter(DailyUpdateReport.created_at >= cutoff)
        .order_by(DailyUpdateReport.created_at.desc())
        .limit(max_reports)
        .all()
    )
    lines = []
    for r in reversed(reports):  # chronological order
        date = r.created_at.strftime("%Y-%m-%d") if r.created_at else "?"
        rj = r.result_json or {}
        groups = rj.get("groups", []) + rj.get("emerging", [])
        if groups:
            gdesc = "; ".join(
                f"{(g.get('platforms') or ['?'])[0]}: {g.get('title', '?')} ({len(g.get('ticket_ids', []))} tickets)"
                for g in groups[:12]
            )
            lines.append(f"{date} — {r.total_tickets} tickets: {gdesc}")
        else:
            lines.append(f"{date} — {r.total_tickets} tickets: no significant groups")
    return "\n".join(lines)


def _fetch_ticket(ticket_id: int, auth=None) -> dict | None:
    import time
    _auth = auth or FRESHDESK_AUTH
    for attempt in range(4):
        try:
            r = requests.get(
                f"{FRESHDESK_BASE}/tickets/{ticket_id}",
                auth=_auth,
                timeout=8,
            )
            if r.status_code == 200:
                return r.json()
            if r.status_code == 429:
                time.sleep(2 ** attempt)  # 1, 2, 4, 8s
                continue
            return None
        except Exception:
            return None
    return None


def _get_tracker_info(ticket_ids: list[int], auth=None) -> dict:
    """
    Returns {ticket_id: {"tracker_id": int, "tracker_subject": str, "tracker_status": str}}
    for tickets that are associated with a tracker (association_type == 4).
    """
    STATUS_MAP = {
        2: "Open", 3: "Pending", 4: "Resolved", 5: "Closed",
        6: "Waiting on Customer", 7: "Waiting on Third Party", 13: "Ready for Production",
    }

    tracker_cache = {}  # tracker_id -> {subject, status}
    result = {}
    _auth = auth or FRESHDESK_AUTH

    # Fetch all ticket details in parallel (max 10 workers)
    ticket_data = {}
    with ThreadPoolExecutor(max_workers=5) as executor:
        futures = {executor.submit(_fetch_ticket, tid, _auth): tid for tid in ticket_ids}
        for future in as_completed(futures):
            tid = futures[future]
            data = future.result()
            if data:
                ticket_data[tid] = data

    # Identify which have trackers (association_type == 4)
    tracker_ids_needed = set()
    for tid, data in ticket_data.items():
        if data.get("association_type") == 4:
            assoc = data.get("associated_tickets_list", [])
            if assoc:
                tracker_ids_needed.add(assoc[0])

    def _fetch_tracker_conversations(tr_id: int, auth=None) -> list:
        try:
            r = requests.get(
                f"{FRESHDESK_BASE}/tickets/{tr_id}/conversations",
                auth=auth or FRESHDESK_AUTH,
                timeout=10,
            )
            return r.json() if r.status_code == 200 else []
        except Exception:
            return []

    # Fetch tracker details + conversations in parallel
    tracker_raw = {}
    with ThreadPoolExecutor(max_workers=5) as executor:
        futures = {executor.submit(_fetch_ticket, tr_id, _auth): tr_id for tr_id in tracker_ids_needed}
        for future in as_completed(futures):
            tr_id = futures[future]
            data = future.result()
            if data:
                tracker_raw[tr_id] = data

    conv_futures = {}
    with ThreadPoolExecutor(max_workers=5) as executor:
        conv_futures = {executor.submit(_fetch_tracker_conversations, tr_id, _auth): tr_id for tr_id in tracker_raw}
        tracker_convs = {}
        for future in as_completed(conv_futures):
            tr_id = conv_futures[future]
            tracker_convs[tr_id] = future.result()

    for tr_id, data in tracker_raw.items():
        convs = tracker_convs.get(tr_id, [])
        latest_note = None
        for c in reversed(convs):
            body = c.get("body_text", "").strip()
            if not body:
                continue
            latest_note = {
                "body": body[:500],
                "is_private": c.get("private", False),
                "created_at": c.get("created_at", ""),
                "incoming": c.get("incoming", False),
            }
            break
        tracker_cache[tr_id] = {
            "subject": data.get("subject", f"Tracker #{tr_id}"),
            "status": STATUS_MAP.get(data.get("status"), f"Status {data.get('status')}"),
            "tags": data.get("tags", []),
            "url": f"https://{settings.FRESHDESK_DOMAIN}/a/tickets/{tr_id}",
            "total_linked": len(data.get("associated_tickets_list", [])),
            "all_linked_ids": data.get("associated_tickets_list", []),
            "latest_note": latest_note,
        }

    # Build result mapping
    ticket_client_map = {}
    for tid, data in ticket_data.items():
        # Extract authoritative client/platform from Freshdesk custom fields
        client_name = (data.get("custom_fields") or {}).get("cf_b2b_client_name") or ""
        if client_name:
            ticket_client_map[tid] = client_name
        if data.get("association_type") == 4:
            assoc = data.get("associated_tickets_list", [])
            if assoc and assoc[0] in tracker_cache:
                result[tid] = {"tracker_id": assoc[0], **tracker_cache[assoc[0]]}

    return result, tracker_cache, ticket_client_map


@router.post("/analyze")
async def analyze_daily_update(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not (file.filename or "").lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="File must be a .csv")

    raw = await file.read()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("latin-1")

    reader = csv.DictReader(io.StringIO(text))
    tickets = []
    for row in reader:
        if "Description" in row and row["Description"]:
            row["Description"] = row["Description"][:600]
        tickets.append(dict(row))
        if len(tickets) >= MAX_TICKETS:
            break

    if not tickets:
        raise HTTPException(status_code=400, detail="CSV is empty or has no valid rows")

    # Get ticket IDs from CSV
    csv_ticket_ids = []
    for t in tickets:
        raw_id = str(t.get("Ticket ID", "")).strip()
        if raw_id.isdigit():
            csv_ticket_ids.append(int(raw_id))

    # 1. Fetch tracker info from Freshdesk
    user_fd_auth = (current_user.freshdesk_api_key, "X") if current_user.freshdesk_api_key else FRESHDESK_AUTH

    # Pre-flight: check Freshdesk rate limit before starting expensive batch fetch
    try:
        _preflight = requests.get(
            f"{FRESHDESK_BASE}/tickets?per_page=1",
            auth=user_fd_auth,
            timeout=8,
        )
        if _preflight.status_code == 429:
            _retry_after = _preflight.headers.get("Retry-After", "")
            try:
                _wait_s = int(_retry_after)
                _minutes = math.ceil(_wait_s / 60)
                _detail = f"Freshdesk API rate limit reached. Try again in {_minutes} minute{'s' if _minutes != 1 else ''}."
            except (ValueError, TypeError):
                _detail = "Freshdesk API rate limit reached. Try again later."
            raise HTTPException(status_code=429, detail=_detail)
    except HTTPException:
        raise
    except Exception:
        pass  # network error on preflight — proceed anyway, batch will handle it

    tracker_by_ticket, tracker_details, ticket_client_map = _get_tracker_info(csv_ticket_ids, auth=user_fd_auth)

    # Override Platform field in CSV rows with authoritative cf_b2b_client_name from Freshdesk
    for t in tickets:
        raw_id = str(t.get("Ticket ID", "")).strip()
        if raw_id.isdigit():
            tid_int = int(raw_id)
            if tid_int in ticket_client_map:
                t["Platform"] = ticket_client_map[tid_int]

    # 2. Build tracker groups (tracker_id -> list of ticket_ids from CSV)
    tracker_groups = {}
    for tid, info in tracker_by_ticket.items():
        tr_id = info["tracker_id"]
        if tr_id not in tracker_groups:
            tracker_groups[tr_id] = {
                "tracker_id": tr_id,
                "subject": info["subject"],
                "status": info["status"],
                "tags": info["tags"],
                "url": info["url"],
                "ticket_ids": [],
            }
        tracker_groups[tr_id]["ticket_ids"].append(tid)

    # 3. Run Claude analysis (with recent-days context for cross-day pattern detection)
    claude = ClaudeClient(api_key=settings.ANTHROPIC_API_KEY)
    history_context = _build_history_context(db)
    result, du_tokens = claude.analyze_daily_update(tickets, history_context=history_context)

    # 4. Annotate groups with tracker info
    for group in result.get("groups", []):
        group["tracker_ids"] = list({
            tracker_by_ticket[tid]["tracker_id"]
            for tid in group.get("ticket_ids", [])
            if tid in tracker_by_ticket
        })

    csv_id_set = set(csv_ticket_ids)
    total_with_tracker = len(set(tracker_by_ticket.keys()) & csv_id_set)

    result["tracker_groups"] = list(tracker_groups.values())
    result["tracker_details"] = tracker_details
    result["total_tickets"] = len(tickets)
    result["total_with_freshdesk_tracker"] = total_with_tracker
    result["filename"] = file.filename or "upload.csv"

    # 6. Save to DB and update user monthly cost
    du_cost = du_tokens["input"] * _SONNET_IN + du_tokens["output"] * _SONNET_OUT
    report = DailyUpdateReport(
        user_id=current_user.id,
        filename=file.filename or "upload.csv",
        total_tickets=len(tickets),
        total_tracked=total_with_tracker,
        result_json=result,
        cost=du_cost,
    )
    db.add(report)
    db.commit()
    db.refresh(report)
    result["report_id"] = report.id

    return result


@router.get("/history")
async def get_daily_update_history(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    reports = (
        db.query(DailyUpdateReport)
        .order_by(DailyUpdateReport.created_at.desc())
        .limit(30)
        .all()
    )
    return [
        {
            "id": r.id,
            "filename": r.filename,
            "total_tickets": r.total_tickets,
            "total_tracked": r.total_tracked,
            "group_count": len(r.result_json.get("groups", [])) if r.result_json else 0,
            "cost": round(r.cost or 0.0, 4),
            "created_at": r.created_at.isoformat(),
        }
        for r in reports
    ]


@router.get("/history/{report_id}")
async def get_daily_update_report(
    report_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    report = db.query(DailyUpdateReport).filter(DailyUpdateReport.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    return report.result_json

@router.delete("/history/{report_id}")
async def delete_daily_update_report(
    report_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    report = db.query(DailyUpdateReport).filter(DailyUpdateReport.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    db.delete(report)
    db.commit()
    return {"ok": True}
