# backend/app/auth/utils.py
import base64
from datetime import datetime, timedelta
from typing import Optional
from jose import JWTError, jwt
from passlib.context import CryptContext
from cryptography.fernet import Fernet
from app.config import settings
from app.database import SessionLocal
from app.models import User

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def get_encryption_key() -> bytes:
    """Return a base64-encoded 32-byte key from settings.ENCRYPTION_KEY."""
    key_bytes = settings.ENCRYPTION_KEY.encode('utf-8')[:32]
    key_bytes = key_bytes.ljust(32, b'0')
    return base64.urlsafe_b64encode(key_bytes)


def encrypt_api_key(api_key: str) -> str:
    """Encrypt an API key using Fernet encryption."""
    key = get_encryption_key()
    f = Fernet(key)
    encrypted = f.encrypt(api_key.encode())
    return encrypted.decode()


def decrypt_api_key(encrypted_key: str) -> str:
    """Decrypt an encrypted API key using Fernet encryption."""
    key = get_encryption_key()
    f = Fernet(key)
    decrypted = f.decrypt(encrypted_key.encode())
    return decrypted.decode()


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify a password against a hash."""
    return pwd_context.verify(plain_password, hashed_password)


def get_password_hash(password: str) -> str:
    """Hash a password."""
    return pwd_context.hash(password)


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    """Create a JWT access token."""
    to_encode = data.copy()
    now = datetime.utcnow()
    if expires_delta:
        expire = now + expires_delta
    else:
        expire = now + timedelta(hours=24)
    to_encode.update({"exp": expire, "iat": now})
    encoded_jwt = jwt.encode(to_encode, settings.JWT_SECRET, algorithm="HS256")
    return encoded_jwt


def decode_token(token: str) -> Optional[dict]:
    """Decode and validate a JWT token."""
    try:
        payload = jwt.decode(token, settings.JWT_SECRET, algorithms=["HS256"])
        return payload
    except JWTError:
        return None


def create_admin_user():
    """Create default admin user if not exists. Also ensure superadmin flag is set."""
    db = SessionLocal()
    try:
        # Check by username first, then by email (handles renamed admin)
        admin = db.query(User).filter(User.username == "admin").first()
        if not admin:
            admin = db.query(User).filter(User.email == "admin@schn.local").first()
        if not admin:
            admin = User(
                username="admin",
                email="admin@schn.local",
                password_hash=get_password_hash(settings.ADMIN_PASSWORD),
                role="admin",
                is_superadmin=True,
                groq_api_key=None
            )
            db.add(admin)
            db.commit()
        elif not getattr(admin, "is_superadmin", False):
            # Ensure the original admin has superadmin flag set
            admin.is_superadmin = True
            db.commit()
    finally:
        db.close()


def authenticate_user(username: str, password: str) -> Optional[User]:
    """Authenticate a user by username and password."""
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.username == username).first()
        if not user:
            return None
        if not verify_password(password, user.password_hash):
            return None
        return user
    finally:
        db.close()