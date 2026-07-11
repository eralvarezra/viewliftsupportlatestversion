# backend/app/routes/cms.py
import json
import base64
import logging
import os
import requests as http_requests
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from pydantic import BaseModel

from app.auth.routes import require_admin, get_current_user
from app.auth.utils import encrypt_api_key, decrypt_api_key
from app.database import get_db
from app.models import AppSetting, User

logger = logging.getLogger(__name__)

router = APIRouter()

SCHN_XAPIKEY      = "ebd65e9d-e9ab-4aaf-a78c-0d14b74cf1be"
SCHN_CLIENT_ID    = "3635b621-15b8-46c6-b20f-923e10be7ec4"
SCHN_SITE         = "schn"
ALTITUD_XAPIKEY   = "69f0e740-7ef2-418b-a9de-c3aded2461fc"
ALTITUD_SITE      = "altitude"
DIRTVISION_XAPIKEY = "FGtQFMG1Fd7DpPUfzoQ5U8FIQo51xT8d9tkbECKE"
DIRTVISION_SITE   = "dirtvision"
MSN_XAPIKEY       = "eDDgMPynXA8W2YeB5b0qe9KtnsuKP96W8aBWQCEF"
MSN_SITE          = "monumentalsportsnetwork"
CMS_GRAPHQL     = "https://cms.api.viewlift.com/management/graphql"
CMS_INVOKE      = "https://cms.api.viewlift.com/v3.0/invoke"
CMS_LOGIN_URL   = "https://cms.api.viewlift.com/v3.0/user/auth/login"
CMS_OTP_VERIFY  = "https://cms.api.viewlift.com/v3.0/user/auth/otp/verify"
QOS_URL         = "https://reporting-prod.viewlift.com/appcms/v1/qos_stream_level_data"
TOKEN_KEY       = "cms_schn_token"
DEVICE_ID       = "browser-427558fc-49f6-44fb-9bfc-96fedb7e5a97"
TIMEOUT         = 10

_CMS_CONFIGS = {
    "schn":       {"xapikey": SCHN_XAPIKEY,       "site": SCHN_SITE,       "client_id": SCHN_CLIENT_ID},
    "altitude":   {"xapikey": ALTITUD_XAPIKEY,    "site": ALTITUD_SITE,    "client_id": None},
    "dirtvision": {"xapikey": DIRTVISION_XAPIKEY, "site": DIRTVISION_SITE, "client_id": None},
    "monumental":  {"xapikey": MSN_XAPIKEY,        "site": MSN_SITE,        "client_id": None},
}

def _cfg(site: str) -> dict:
    return _CMS_CONFIGS.get(site, _CMS_CONFIGS["schn"])


class CMSTokenRequest(BaseModel):
    token: str

class CMSOtpRequest(BaseModel):
    otp: str

class CMSCredentialsRequest(BaseModel):
    username: str
    password: str


# ── helpers ──────────────────────────────────────────────────────────────────

def _decode_expiry(token: str) -> Optional[str]:
    try:
        part = token.split(".")[1]
        part += "=" * (4 - len(part) % 4)
        data = json.loads(base64.b64decode(part))
        return datetime.utcfromtimestamp(data["exp"]).isoformat()
    except Exception:
        return None


def _save_token_to_db(db: Session, token: str, site: str = "schn") -> str:
    expires_at = _decode_expiry(token)
    token_key = f"cms_{site}_token"
    value = json.dumps({"token": token, "expires_at": expires_at})
    row = db.query(AppSetting).filter(AppSetting.key == token_key).first()
    if row:
        row.value = value
    else:
        db.add(AppSetting(key=token_key, value=value))
    db.commit()
    return expires_at


def _get_user_credentials(user_id: int, db: Session, site: str = "schn") -> Optional[tuple[str, str]]:
    """Return (username, password) for a user, or None if not set."""
    cred_key = f"cms_creds_{user_id}" if site == "schn" else f"cms_creds_{site}_{user_id}"
    row = db.query(AppSetting).filter(AppSetting.key == cred_key).first()
    if not row:
        u = os.getenv(f"CMS_{site.upper()}_USERNAME") or (os.getenv("CMS_USERNAME") if site == "schn" else None)
        p = os.getenv(f"CMS_{site.upper()}_PASSWORD") or (os.getenv("CMS_PASSWORD") if site == "schn" else None)
        return (u, p) if u and p else None
    try:
        data = json.loads(row.value)
        return data["username"], decrypt_api_key(data["password_enc"])
    except Exception:
        return None


def _find_any_stored_creds(db: Session, site: str) -> Optional[tuple[str, str]]:
    """Find any admin credentials stored in DB for a site (used for auto-refresh)."""
    if site == "schn":
        # Legacy keys: cms_creds_{user_id} — exclude other sites' keys
        other_prefixes = tuple(f"cms_creds_{s}_" for s in _CMS_CONFIGS if s != "schn")
        rows = db.query(AppSetting).filter(AppSetting.key.like("cms_creds_%")).all()
        rows = [r for r in rows if not r.key.startswith(other_prefixes)]
    else:
        rows = db.query(AppSetting).filter(AppSetting.key.like(f"cms_creds_{site}_%")).all()
    for row in rows:
        try:
            data = json.loads(row.value)
            if "username" in data and "password_enc" in data:
                return data["username"], decrypt_api_key(data["password_enc"])
        except Exception:
            continue
    return None


def _login_step1(db: Session, user_id: Optional[int] = None, site: str = "schn") -> dict:
    """Initiate CMS login for a user. Returns token directly or needs_otp."""
    if user_id:
        creds = _get_user_credentials(user_id, db, site=site)
    else:
        # 1. env vars, 2. any admin credentials stored in DB
        u = os.getenv(f"CMS_{site.upper()}_USERNAME") or (os.getenv("CMS_USERNAME") if site == "schn" else None)
        p = os.getenv(f"CMS_{site.upper()}_PASSWORD") or (os.getenv("CMS_PASSWORD") if site == "schn" else None)
        creds = (u, p) if u and p else _find_any_stored_creds(db, site)

    if not creds:
        return {"ok": False, "message": "No CMS credentials configured. Set them in Settings."}

    username, password = creds
    try:
        # x-api-key scopes the login to THIS site — without it the CMS issues a
        # token for the account's default site (monumental tokens were coming
        # back scoped to 'chsn', breaking all Monumental lookups with 401s).
        r = http_requests.post(CMS_LOGIN_URL, json={
            "username": username,
            "password": password,
            "deviceId": DEVICE_ID,
        }, headers={"x-api-key": _cfg(site)["xapikey"]}, timeout=TIMEOUT)
        data = r.json()
        if not data.get("success"):
            return {"ok": False, "message": data.get("message", "Login failed — check your CMS credentials")}

        if data.get("isTwoFactorOnLogin"):
            session_key = f"cms_{site}_otp_session_{user_id}" if user_id else f"cms_{site}_otp_session"
            session_value = json.dumps({
                "session_username": data.get("username"),
                "device_id": DEVICE_ID,
                "created_at": datetime.utcnow().isoformat(),
            })
            row = db.query(AppSetting).filter(AppSetting.key == session_key).first()
            if row:
                row.value = session_value
            else:
                db.add(AppSetting(key=session_key, value=session_value))
            db.commit()
            return {
                "ok": True,
                "needs_otp": True,
                "obscure_mobile": data.get("obscureMobileNumber", ""),
            }

        new_token = data.get("accessToken")
        if not new_token:
            return {"ok": False, "message": "No accessToken in response"}
        expires_at = _save_token_to_db(db, new_token, site=site)
        logger.info("CMS token refreshed by user %s for site %s, expires at %s", user_id, site, expires_at)
        return {"ok": True, "token": new_token, "expires_at": expires_at}
    except Exception as e:
        logger.error("CMS login error: %s", e)
        return {"ok": False, "message": str(e)}


def _login_step2_otp(otp: str, db: Session, user_id: Optional[int] = None, site: str = "schn") -> dict:
    """Complete OTP verification."""
    session_key = f"cms_{site}_otp_session_{user_id}" if user_id else f"cms_{site}_otp_session"
    row = db.query(AppSetting).filter(AppSetting.key == session_key).first()
    if not row:
        return {"ok": False, "message": "No OTP session found — start refresh first"}
    try:
        session = json.loads(row.value)
        r = http_requests.post(CMS_OTP_VERIFY, json={
            "username": session["session_username"],
            "otp": otp.strip(),
            "isLogin": True,
            "deviceId": session["device_id"],
        }, headers={"x-api-key": _cfg(site)["xapikey"]}, timeout=TIMEOUT)
        data = r.json()
        if not data.get("success"):
            return {"ok": False, "message": data.get("message", "OTP verification failed")}
        new_token = data.get("accessToken")
        if not new_token:
            return {"ok": False, "message": "No accessToken after OTP verify"}
        expires_at = _save_token_to_db(db, new_token, site=site)
        db.delete(row)
        db.commit()
        logger.info("CMS token refreshed via OTP by user %s for site %s, expires at %s", user_id, site, expires_at)
        return {"ok": True, "token": new_token, "expires_at": expires_at}
    except Exception as e:
        logger.error("CMS OTP verify error: %s", e)
        return {"ok": False, "message": str(e)}


def _get_stored_token(db: Session, site: str = "schn") -> Optional[str]:
    token_key = f"cms_{site}_token"
    row = db.query(AppSetting).filter(AppSetting.key == token_key).first()
    if not row:
        result = _login_step1(db, site=site)
        return result.get("token") if result.get("ok") and not result.get("needs_otp") else None
    try:
        data = json.loads(row.value)
        exp = data.get("expires_at")
        if exp and datetime.fromisoformat(exp) < datetime.utcnow():
            logger.info("CMS token expired for site %s, attempting auto-refresh", site)
            result = _login_step1(db, site=site)
            return result.get("token") if result.get("ok") and not result.get("needs_otp") else None
        return data.get("token")
    except Exception:
        return None


# ── routes ────────────────────────────────────────────────────────────────────

@router.get("/credentials/status")
def credentials_status(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
    site: str = Query("schn"),
):
    cred_key = f"cms_creds_{current_user.id}" if site == "schn" else f"cms_creds_{site}_{current_user.id}"
    row = db.query(AppSetting).filter(AppSetting.key == cred_key).first()
    if row:
        try:
            data = json.loads(row.value)
            return {"configured": True, "username": data.get("username", "")}
        except Exception:
            pass
    env_u = os.getenv(f"CMS_{site.upper()}_USERNAME") or (os.getenv("CMS_USERNAME") if site == "schn" else None)
    if env_u:
        return {"configured": True, "username": env_u, "from_env": True}
    return {"configured": False}


@router.post("/credentials")
def save_credentials(
    req: CMSCredentialsRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
    site: str = Query("schn"),
):
    key = f"cms_creds_{current_user.id}" if site == "schn" else f"cms_creds_{site}_{current_user.id}"
    value = json.dumps({
        "username": req.username.strip(),
        "password_enc": encrypt_api_key(req.password),
    })
    row = db.query(AppSetting).filter(AppSetting.key == key).first()
    if row:
        row.value = value
    else:
        db.add(AppSetting(key=key, value=value))
    db.commit()
    return {"ok": True, "username": req.username.strip()}


@router.delete("/credentials")
def delete_credentials(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
    site: str = Query("schn"),
):
    cred_key = f"cms_creds_{current_user.id}" if site == "schn" else f"cms_creds_{site}_{current_user.id}"
    row = db.query(AppSetting).filter(AppSetting.key == cred_key).first()
    if row:
        db.delete(row)
        db.commit()
    return {"ok": True}


@router.post("/token")
def save_token(
    req: CMSTokenRequest,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
    site: str = Query("schn"),
):
    expires_at = _save_token_to_db(db, req.token, site=site)
    return {"ok": True, "expires_at": expires_at}


@router.post("/token/refresh")
def refresh_token(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
    site: str = Query("schn"),
):
    result = _login_step1(db, user_id=current_user.id, site=site)
    if not result["ok"]:
        return {"ok": False, "message": result["message"]}
    if result.get("needs_otp"):
        return {
            "ok": True,
            "needs_otp": True,
            "obscure_mobile": result.get("obscure_mobile", ""),
            "message": f"OTP sent to number ending in {result.get('obscure_mobile', '???')}",
        }
    return {"ok": True, "expires_at": result.get("expires_at"), "message": "Token refreshed successfully"}


@router.post("/token/verify-otp")
def verify_otp(
    req: CMSOtpRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
    site: str = Query("schn"),
):
    result = _login_step2_otp(req.otp, db, user_id=current_user.id, site=site)
    if not result["ok"]:
        raise HTTPException(status_code=400, detail=result["message"])
    return {"ok": True, "expires_at": result.get("expires_at"), "message": "Token refreshed successfully"}


@router.get("/token/status")
def token_status(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
    site: str = Query("schn"),
):
    token_key = f"cms_{site}_token"
    row = db.query(AppSetting).filter(AppSetting.key == token_key).first()
    creds = _get_user_credentials(current_user.id, db, site=site) if (current_user.role == "admin" or getattr(current_user, "is_superadmin", False)) else None
    auto_refresh = bool(creds)
    if not row:
        return {"status": "not_set", "auto_refresh": auto_refresh}
    try:
        data = json.loads(row.value)
        exp = data.get("expires_at")
        if not exp:
            return {"status": "unknown", "auto_refresh": auto_refresh}
        exp_dt = datetime.fromisoformat(exp)
        now = datetime.utcnow()
        if exp_dt > now:
            mins = int((exp_dt - now).total_seconds() / 60)
            return {"status": "valid", "expires_at": exp, "minutes_remaining": mins, "auto_refresh": auto_refresh}
        return {"status": "expired", "expires_at": exp, "auto_refresh": auto_refresh}
    except Exception:
        return {"status": "unknown", "auto_refresh": auto_refresh}


@router.get("/token/test")
def test_token(
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
    site: str = Query("schn"),
):
    token = _get_stored_token(db, site=site)
    if not token:
        return {"ok": False, "message": "No valid token stored"}
    cfg = _cfg(site)
    try:
        r = http_requests.post(CMS_GRAPHQL, json={
            "operationName": "UserList",
            "query": "query UserList($req: UserListRequest) { userList(req: $req) { users { id username } } }",
            "variables": {"req": {"site": cfg["site"], "keyword": "test@test.com", "limit": 1}},
        }, headers={"Content-Type": "application/json", "Xapikey": cfg["xapikey"], "Authorization": token}, timeout=TIMEOUT)
        if r.status_code == 401:
            return {"ok": False, "message": "Token rejected by CMS (HTTP 401)"}
        if r.status_code != 200:
            return {"ok": False, "message": f"CMS returned HTTP {r.status_code}"}
        body = r.json()
        if "errors" in body:
            return {"ok": False, "message": "CMS error: " + "; ".join(e.get("message", "") for e in body["errors"])}
        return {"ok": True, "message": "Token is valid"}
    except Exception as e:
        return {"ok": False, "message": f"Request failed: {e}"}


@router.get("/lookup")
def cms_lookup(
    email: str,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
    site: str = Query("schn"),
):
    token = _get_stored_token(db, site=site)
    if not token:
        return {"found": False, "email": email, "token_error": True}
    data = fetch_cms_data(email, db, include_qos=True, site=site)
    if not data:
        return {"found": False, "email": email}
    acct = data.get("account", {})
    sub_info = acct.get("subscription", {}).get("subscriptionInfo", {})
    plan_amount = sub_info.get("planAmount") or sub_info.get("amount") or ""
    currency = sub_info.get("currency", "USD").upper()
    price_str = f"{currency} {plan_amount}" if plan_amount else ""

    return {
        "found": True,
        "site": site,
        "user_id": data.get("user_id"),
        "email": acct.get("email") or email,
        "name": acct.get("name", ""),
        "is_active": acct.get("isActive"),
        "is_subscribed": acct.get("isSubscribed"),
        "plan": sub_info.get("identifier", ""),
        "plan_name": sub_info.get("planName") or sub_info.get("identifier", ""),
        "price": price_str,
        "subscription_status": sub_info.get("subscriptionStatus", ""),
        "payment_handler": sub_info.get("paymentHandler", ""),
        "payment_state": sub_info.get("paymentState", ""),
        "receipt_id": sub_info.get("receiptId") or sub_info.get("chargeId") or sub_info.get("transactionId") or "",
        "payment_unique_id": sub_info.get("customerId") or sub_info.get("paymentUniqueId") or "",
        "transaction_id": sub_info.get("transactionId") or "",
        "country": acct.get("country", ""),
        "registered_on": (sub_info.get("subscriptionStartDate") or acct.get("registeredOn") or "")[:10],
        "end_date": (sub_info.get("subscriptionEndDate") or "")[:10],
        "auto_renew": sub_info.get("autoRenewStatus", False),
        "last_login": (acct.get("lastLoginDate") or "")[:10],
        "first_subscribed": (sub_info.get("addedDate") or "")[:10],
        "last_charge": {
            "amount": sub_info.get("totalAmount") or sub_info.get("planAmount") or "",
            "currency": currency,
            "charge_id": sub_info.get("gatewayChargeId") or "",
            "period_start": (sub_info.get("subscriptionStartDate") or "")[:10],
            "period_end": (sub_info.get("subscriptionEndDate") or "")[:10],
        },
        "charges": [
            {
                "date": (c.get("initiatedAt") or c.get("addedDate") or "")[:10],
                "type": c.get("transactiontype", ""),
                "amount": c.get("totalAmount") or c.get("preTaxAmount") or "",
                "currency": c.get("currencyCode", "USD"),
                "handler": c.get("paymentHandler", ""),
                "plan": (c.get("planTitle") or c.get("identifier") or "")[:40],
                "charge_id": c.get("gatewayChargeId") or c.get("id") or "",
            }
            for c in (data.get("billing") or [])[:24]
        ],
        "qoss": [
            {
                "date": (q.get("watchdate") or "")[:16],
                "video": (q.get("video") or "")[:80],
                "platform": q.get("platform", ""),
                "device": q.get("devicename", ""),
                "city": q.get("city", ""),
                "issues": ", ".join(filter(None, [
                    "failed to start" if q.get("failedtostartindicator") == "Y" else "",
                    "stream dropped" if q.get("streamdroppedindicator") == "Y" else "",
                    "buffering {}%".format(round((q.get("bufferingratio") or 0) * 100))
                    if (q.get("bufferingratio") or 0) > 0.05 else "",
                ])) or "none",
            }
            for q in (data.get("qos") or [])[:5]
        ],
        "device_count": len(data.get("devices", [])),
        "devices": [
            {
                "name": d.get("deviceName") or d.get("platform", "Unknown"),
                "platform": d.get("platform", ""),
                "city": (d.get("location") or {}).get("cityname", ""),
                "last_watched": (d.get("lastWatched") or "")[:10],
            }
            for d in data.get("devices", [])[:10]
        ],
    }


# ── data fetch (called from generate.py) ──────────────────────────────────────

def fetch_cms_data(email: str, db: Session, include_qos: bool = True, user_id: Optional[str] = None, site: str = "schn") -> Optional[dict]:
    token = _get_stored_token(db, site=site)
    if not token:
        return None

    cfg = _cfg(site)
    xapikey = cfg["xapikey"]
    site_slug = cfg["site"]
    client_id = cfg["client_id"]

    cms_headers = {"Content-Type": "application/json", "Xapikey": xapikey, "Authorization": token}

    if not user_id:
        if not email:
            return None
        try:
            r = http_requests.post(CMS_INVOKE, json={
                "url": "/v2/admin/identity/user-search", "method": "POST", "role": "Customer Support",
                "auth": {"site": site_slug, "isServerToken": True},
                "query": {"site": site_slug, "totalCount": True},
                "body": {"searchTerm": email.lower(), "offset": 0, "limit": 5, "type": "email"},
            }, headers=cms_headers, timeout=TIMEOUT)
            users = r.json().get("users", [])
            match = next((u for u in users if (u.get("identity", {}).get("email") or "").lower() == email.lower()), None)
            if not match:
                return None
            user_id = match["id"]
        except Exception:
            return None

    def _identity():
        return http_requests.post(CMS_INVOKE, json={
            "url": "identity/user", "method": "GET", "role": "Customer Support",
            "auth": {"site": site_slug, "userId": user_id}, "body": {},
            "query": {"site": site_slug, "userId": user_id},
        }, headers=cms_headers, timeout=TIMEOUT).json()

    def _devices():
        return http_requests.post(CMS_INVOKE, json={
            "url": "v2/user/device", "method": "GET", "role": "Customer Support",
            "auth": {"site": site_slug, "userId": user_id}, "body": {},
            "query": {"site": site_slug, "userId": user_id, "limit": 100},
        }, headers=cms_headers, timeout=TIMEOUT).json()

    def _billing():
        r = http_requests.post(CMS_INVOKE, json={
            "url": "/v3/billing/history", "method": "GET", "role": "Customer Support",
            "auth": {"site": site_slug, "userId": user_id}, "body": {},
            "query": {"site": site_slug, "limit": 50, "offset": 0, "purchaseType": "SUBSCRIPTION"},
        }, headers=cms_headers, timeout=TIMEOUT)
        data = r.json()
        return data.get("records", []) if isinstance(data, dict) else []

    def _qos():
        qos_headers = {"Content-Type": "application/json", "xapikey": xapikey, "authorization": token}
        today = datetime.utcnow().strftime("%Y-%m-%d")
        resp = http_requests.post(QOS_URL, json={
            "filters": {"clientId": client_id, "userId": user_id, "watchDate": today,
                        "numRecords": "15", "skipRecords": 0, "sortKey": "DESC", "inclusive": "N"},
        }, headers=qos_headers, timeout=TIMEOUT)
        data = resp.json()
        return data if isinstance(data, list) else []

    tasks = {"identity": _identity, "devices": _devices, "billing": _billing}
    if include_qos and client_id:
        tasks["qos"] = _qos

    results = {}
    with ThreadPoolExecutor(max_workers=3) as ex:
        futures = {name: ex.submit(fn) for name, fn in tasks.items()}
        for name, fut in futures.items():
            try:
                results[name] = fut.result(timeout=TIMEOUT + 1)
            except Exception:
                results[name] = {} if name != "qos" else []

    return {
        "user_id": user_id,
        "email": email,
        "account": results.get("identity", {}),
        "devices": results.get("devices", {}).get("records", []),
        "qos": results.get("qos", []),
        "billing": results.get("billing") or [],
    }


def format_cms_context(data: dict) -> str:
    lines = ["=== SCHN+ CMS ACCOUNT DATA ==="]
    acct = data.get("account", {})
    sub_info = acct.get("subscription", {}).get("subscriptionInfo", {})

    lines.append(f"Name: {acct.get('name', '')}")
    lines.append(f"Email: {acct.get('email') or data.get('email', '')}")
    lines.append(f"Account Active: {'Yes' if acct.get('isActive') else 'No' if acct.get('isActive') is not None else 'Unknown'}")
    lines.append(f"Subscribed: {'Yes' if acct.get('isSubscribed') else 'No' if acct.get('isSubscribed') is not None else 'Unknown'}")
    city, country = acct.get("city", ""), acct.get("country", "")
    if city or country:
        lines.append(f"Location: {city}, {country}")
    lines.append(f"Last Login: {(acct.get('lastLoginDate') or '')[:10] or 'N/A'}")
    registered = (acct.get("registeredOn") or "")[:10]
    if registered:
        lines.append(f"Registered: {registered} via {acct.get('registerdVia', '')}")

    if sub_info:
        lines.append(f"\
Subscription Plan: {sub_info.get('identifier', '')} (${sub_info.get('planAmount', '')}/month)")
        lines.append(f"Subscription Status: {sub_info.get('subscriptionStatus', '')}")
        pay_state = sub_info.get("paymentState", "")
        if pay_state:
            lines.append(f"Payment State: {pay_state}")
        start = (sub_info.get("subscriptionStartDate") or "")[:10]
        end = (sub_info.get("subscriptionEndDate") or "")[:10]
        if start and end:
            lines.append(f"Period: {start} → {end}")
        last4 = sub_info.get("last4", "")
        lines.append(f"Payment Handler: {sub_info.get('paymentHandler', '')}" + (f" ending ****{last4}" if last4 else ""))
        lines.append(f"Auto-Renew: {'On' if sub_info.get('autoRenewStatus') else 'Off'}")

    devices = data.get("devices", [])
    if devices:
        lines.append(f"\
Registered Devices ({len(devices)} total):")
        for i, d in enumerate(devices[:10], 1):
            platform = d.get("platform", "")
            dname = d.get("deviceName", platform)
            dcity = d.get("location", {}).get("cityname", "")
            last_w = d.get("lastWatched", "")
            lw_str = f" | Last Watched: {last_w[:10]}" if last_w else ""
            lines.append(f"  {i}. {dname} ({platform}) — {dcity}{lw_str}")

    qos = data.get("qos", [])
    if qos:
        lines.append(f"\
Recent Streaming Sessions ({len(qos)} records):")
        for q in qos[:8]:
            dur = q.get("duration") or 0
            dur_str = f"{dur // 60}m {dur % 60}s" if dur else "0s"
            res = q.get("avgresolution", "")
            lines.append(
                f"  [{(q.get('watchdate') or '')[:16]}] {q.get('video', '')} | {q.get('platform', '')} | "
                f"{dur_str} | TTFB:{q.get('ttfb', '')}ms | Res:{res}p | Buf:{q.get('bufferingratio', '')} | "
                f"Failed:{q.get('failedtostartindicator', 'N')} | Dropped:{q.get('streamdroppedindicator', 'N')}"
            )

    lines.append("=== END CMS DATA ===")
    return "\n".join(lines)


def fetch_qos_for_dates(user_id: str, dates: list, db: Session, site: str = "schn") -> dict:
    """QOS streaming sessions for the specific dates a customer mentioned.

    Returns {date: [session, ...]}; empty list means no activity that day.
    """
    from datetime import timedelta

    token = _get_stored_token(db, site=site)
    cfg = _cfg(site)
    if not token or not cfg.get("client_id"):
        return {}
    qos_headers = {"Content-Type": "application/json", "xapikey": cfg["xapikey"], "authorization": token}
    out = {}
    for d in dates[:5]:
        try:
            nxt = (datetime.fromisoformat(d) + timedelta(days=1)).strftime("%Y-%m-%d")
            resp = http_requests.post(QOS_URL, json={
                "filters": {"clientId": cfg["client_id"], "userId": user_id, "watchDate": nxt,
                            "numRecords": "50", "skipRecords": 0, "sortKey": "DESC", "inclusive": "N"},
            }, headers=qos_headers, timeout=TIMEOUT)
            data = resp.json()
            out[d] = [q for q in data if (q.get("watchdate") or "").startswith(d)] if isinstance(data, list) else []
        except Exception:
            out[d] = []
    return out
