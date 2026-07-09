# backend/app/routes/canned_responses.py
import threading
import requests
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.auth.routes import get_current_user
from app.config import settings
from app.database import get_db, SessionLocal
from app.models import User, CannedResponse, Platform, AppSetting
from app.services.local_embeddings import LocalEmbeddingService

router = APIRouter()

FOLDER_MAP = {
    43000173959: None,
    43000245520: None,
    43000246188: "schn",
    43000245458: "altitude",
    43000245077: "dirtvision",
    43000245235: "foxone",
    43000244608: "knighttime",
    43000243862: "livgolf",
    43000244609: "monumental",
    43000246056: "tbl",
}

FRESHDESK_BASE = f"https://{settings.FRESHDESK_DOMAIN}/api/v2"
FRESHDESK_AUTH = (settings.FRESHDESK_API_KEY, "X")

_sync_lock = threading.Lock()
_sync_status = {"running": False, "synced": 0, "skipped": 0, "error": None, "done": False}


def _fetch_folder_responses(folder_id: int) -> list:
    all_items = []
    page = 1
    while True:
        r = requests.get(
            f"{FRESHDESK_BASE}/canned_response_folders/{folder_id}/responses",
            auth=FRESHDESK_AUTH,
            params={"per_page": 100, "page": page},
            timeout=30,
        )
        if r.status_code == 429:
            break
        if r.status_code != 200:
            break
        batch = r.json()
        if not batch:
            break
        all_items.extend(batch)
        if len(batch) < 100:
            break
        page += 1
    return all_items


def _run_sync():
    global _sync_status
    db = SessionLocal()
    try:
        embedding_service = LocalEmbeddingService()
        slug_to_id = {p.slug: p.id for p in db.query(Platform).all()}
        synced = 0
        skipped = 0

        for folder_id, slug in FOLDER_MAP.items():
            platform_id: Optional[int] = slug_to_id.get(slug) if slug else None
            items = _fetch_folder_responses(folder_id)
            for item in items:
                content = (item.get("content") or "").replace(" ", " ").strip()
                title = item.get("title", "").strip()
                if not content:
                    skipped += 1
                    continue

                existing = db.query(CannedResponse).filter(
                    CannedResponse.freshdesk_id == item["id"]
                ).first()

                embed_text = f"{title}\n{content}"
                embedding_bytes = embedding_service.serialize_embedding(
                    embedding_service.get_embedding(embed_text)
                )
                content_html = (item.get("content_html") or "").strip()

                if existing:
                    existing.title = title
                    existing.content = content
                    existing.content_html = content_html or None
                    existing.platform_id = platform_id
                    existing.freshdesk_folder_id = folder_id
                    existing.embedding = embedding_bytes
                    existing.synced_at = datetime.utcnow()
                else:
                    db.add(CannedResponse(
                        freshdesk_id=item["id"],
                        freshdesk_folder_id=folder_id,
                        title=title,
                        content=content,
                        content_html=content_html or None,
                        platform_id=platform_id,
                        embedding=embedding_bytes,
                    ))
                synced += 1
                _sync_status["synced"] = synced

        db.commit()
        _sync_status.update({"running": False, "synced": synced, "skipped": skipped, "done": True, "error": None})
    except Exception as e:
        _sync_status.update({"running": False, "error": str(e), "done": True})
    finally:
        db.close()
        _sync_lock.release()


@router.get("/")
def list_canned_responses(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """List all synced canned responses (FAQs page)."""
    rows = db.query(CannedResponse).order_by(CannedResponse.title.asc()).all()
    return [
        {
            "id": r.id,
            "title": r.title,
            "content": r.content,
            "platform_name": r.platform.name if r.platform else None,
            "synced_at": r.synced_at,
        }
        for r in rows
    ]


@router.post("/sync")
def sync_canned_responses(
    current_user: User = Depends(get_current_user),
):
    """Start a background sync from Freshdesk. Returns immediately."""
    if current_user.role != "admin" and not current_user.is_superadmin:
        raise HTTPException(status_code=403, detail="Admin only")

    if not _sync_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="Sync already in progress")

    global _sync_status
    _sync_status = {"running": True, "synced": 0, "skipped": 0, "error": None, "done": False}

    t = threading.Thread(target=_run_sync, daemon=True)
    t.start()

    return {"status": "started"}


@router.get("/sync/status")
def sync_status(current_user: User = Depends(get_current_user)):
    """Poll sync progress."""
    return _sync_status


@router.get("/by-title/{title}")
def get_canned_response_by_title(
    title: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    from fastapi import HTTPException
    r = db.query(CannedResponse).filter(CannedResponse.title == title).first()
    if not r:
        raise HTTPException(status_code=404, detail=f"Canned response not found: {title}")
    return {
        "id": r.id,
        "title": r.title,
        "content": r.content,
        "content_html": r.content_html,
    }
