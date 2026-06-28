from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.auth.routes import get_current_user, require_admin
from app.database import get_db
from app.models import AppSetting

router = APIRouter()


@router.get("")
def get_settings(db: Session = Depends(get_db)):
    rows = db.query(AppSetting).all()
    return {r.key: r.value for r in rows}


@router.patch("/{key}")
def update_setting(
    key: str,
    body: dict,
    current_user=Depends(require_admin),
    db: Session = Depends(get_db),
):
    setting = db.query(AppSetting).filter(AppSetting.key == key).first()
    if not setting:
        raise HTTPException(status_code=404, detail="Setting not found")
    setting.value = str(body.get("value", ""))
    db.commit()
    return {"key": key, "value": setting.value}
