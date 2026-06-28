from typing import List
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Platform
from app.schemas import PlatformResponse

router = APIRouter()


@router.get("/", response_model=List[PlatformResponse])
async def list_platforms(
    include_global: bool = False,
    db: Session = Depends(get_db),
):
    """List platforms. Pass ?include_global=true to include B2C and other global platforms."""
    query = db.query(Platform)
    if not include_global:
        query = query.filter(Platform.is_global == False)
    return query.order_by(Platform.id).all()
