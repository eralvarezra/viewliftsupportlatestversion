# backend/app/auth/routes.py
from datetime import datetime, timedelta
from fastapi import APIRouter, HTTPException, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from app.schemas import LoginRequest, TokenResponse, RegisterRequest, UserResponse
from app.auth.utils import authenticate_user, create_access_token, decode_token, get_password_hash
from app.models import User
from app.database import SessionLocal

router = APIRouter()
security = HTTPBearer(auto_error=False)


def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)) -> User:
    """Dependency to get current authenticated user."""
    if credentials is None:
        raise HTTPException(status_code=401, detail="Not authenticated")

    token = credentials.credentials
    payload = decode_token(token)
    if not payload:
        raise HTTPException(status_code=401, detail="Invalid token")

    username = payload.get("sub")
    if not username:
        raise HTTPException(status_code=401, detail="Invalid token")

    db = SessionLocal()
    try:
        user = db.query(User).filter(User.username == username).first()
        if not user:
            raise HTTPException(status_code=401, detail="User not found")
        user_status = user.status or ("active" if user.is_active else "inactive")
        if user_status == "pending":
            raise HTTPException(status_code=403, detail="Account pending approval. Contact your administrator.")
        if user_status == "inactive" or not user.is_active:
            raise HTTPException(status_code=403, detail="Account is deactivated. Contact your administrator.")
        return user
    finally:
        db.close()


def require_admin(current_user: User = Depends(get_current_user)) -> User:
    """Dependency to require admin role."""
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return current_user


@router.post("/login", response_model=TokenResponse)
async def login(request: LoginRequest):
    """Login endpoint."""
    user = authenticate_user(request.username, request.password)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    user_status = user.status or ("active" if user.is_active else "inactive")
    if user_status == "pending":
        raise HTTPException(status_code=403, detail="Account pending approval. Contact your administrator.")
    if user_status == "inactive" or not user.is_active:
        raise HTTPException(status_code=403, detail="Account is deactivated. Contact your administrator.")

    db = SessionLocal()
    try:
        db_user = db.query(User).filter(User.id == user.id).first()
        if db_user:
            db_user.last_login = datetime.utcnow()
            db.commit()
    finally:
        db.close()

    access_token = create_access_token(
        data={"sub": user.username, "role": user.role}
    )

    return TokenResponse(
        access_token=access_token,
        role=user.role,
        username=user.username,
        is_superadmin=bool(getattr(user, 'is_superadmin', False))
    )


@router.post("/logout")
async def logout(current_user: User = Depends(get_current_user)):
    """Logout endpoint (client-side token removal)."""
    return {"message": "Logged out successfully"}


@router.post("/register", response_model=TokenResponse)
async def register(request: RegisterRequest):
    """Register a new agent user with Groq API key."""
    db = SessionLocal()
    try:
        # Check for duplicate username
        existing_user = db.query(User).filter(User.username == request.username).first()
        if existing_user:
            raise HTTPException(status_code=400, detail="Username already registered")

        # Check for duplicate email
        existing_email = db.query(User).filter(User.email == request.email).first()
        if existing_email:
            raise HTTPException(status_code=400, detail="Email already registered")

        # Create new user with role 'agent' — uses global Anthropic API key
        new_user = User(
            username=request.username,
            email=request.email,
            password_hash=get_password_hash(request.password),
            role="agent",
            status="pending",
            is_active=False,
        )
        db.add(new_user)
        db.commit()

        return TokenResponse(
            access_token="pending",
            role="pending",
            username=""
        )
    finally:
        db.close()