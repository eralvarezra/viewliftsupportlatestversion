from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.auth.routes import get_current_user
from app.database import get_db
from app.models import TrackerComment, User

router = APIRouter()


@router.get("/{tracker_id}")
def get_comments(
    tracker_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    comments = (
        db.query(TrackerComment)
        .filter(TrackerComment.tracker_id == tracker_id)
        .order_by(TrackerComment.created_at.asc())
        .all()
    )
    return [
        {
            "id": c.id,
            "body": c.body,
            "created_at": c.created_at.isoformat() if c.created_at else None,
            "username": c.user.username if c.user else "unknown",
        }
        for c in comments
    ]


@router.post("/{tracker_id}")
def add_comment(
    tracker_id: int,
    body: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    text = (body.get("body") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Comment cannot be empty")
    if len(text) > 2000:
        raise HTTPException(status_code=400, detail="Comment too long (max 2000 chars)")

    comment = TrackerComment(
        tracker_id=tracker_id,
        user_id=current_user.id,
        body=text,
    )
    db.add(comment)
    db.commit()
    db.refresh(comment)
    return {
        "id": comment.id,
        "body": comment.body,
        "created_at": comment.created_at.isoformat() if comment.created_at else None,
        "username": current_user.username,
    }


@router.delete("/{tracker_id}/{comment_id}")
def delete_comment(
    tracker_id: int,
    comment_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    comment = db.query(TrackerComment).filter(
        TrackerComment.id == comment_id,
        TrackerComment.tracker_id == tracker_id,
    ).first()
    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found")
    if comment.user_id != current_user.id and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Not authorized")
    db.delete(comment)
    db.commit()
    return {"ok": True}
