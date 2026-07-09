# backend/app/database.py
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker, declarative_base
from app.config import settings

if settings.DATABASE_URL.startswith("sqlite"):
    engine = create_engine(
        settings.DATABASE_URL,
        connect_args={"check_same_thread": False}
    )
else:
    engine = create_engine(
        settings.DATABASE_URL,
        pool_pre_ping=True,
        pool_size=5,
        max_overflow=10
    )

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def get_db():
    """Dependency to get database session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    """Initialize database tables."""
    Base.metadata.create_all(bind=engine)


def run_migrations():
    """Add platform_id column to existing tables if missing, then seed platforms."""
    with engine.connect() as conn:
        # Add platform_id to faq_documents if missing
        cols = [r[1] for r in conn.execute(text("PRAGMA table_info(faq_documents)")).fetchall()]
        if "platform_id" not in cols:
            conn.execute(text("ALTER TABLE faq_documents ADD COLUMN platform_id INTEGER DEFAULT 1"))

        # Add platform_id to faq_chunks if missing
        cols = [r[1] for r in conn.execute(text("PRAGMA table_info(faq_chunks)")).fetchall()]
        if "platform_id" not in cols:
            conn.execute(text("ALTER TABLE faq_chunks ADD COLUMN platform_id INTEGER DEFAULT 1"))

        # Add platform_id to response_history if missing
        cols = [r[1] for r in conn.execute(text("PRAGMA table_info(response_history)")).fetchall()]
        if "platform_id" not in cols:
            conn.execute(text("ALTER TABLE response_history ADD COLUMN platform_id INTEGER DEFAULT 1"))

        # Feedback-loop columns on response_history
        cols = [r[1] for r in conn.execute(text("PRAGMA table_info(response_history)")).fetchall()]
        if "message_embedding" not in cols:
            conn.execute(text("ALTER TABLE response_history ADD COLUMN message_embedding BLOB"))
        if "corrected_response" not in cols:
            conn.execute(text("ALTER TABLE response_history ADD COLUMN corrected_response TEXT"))
        if "review_status" not in cols:
            conn.execute(text("ALTER TABLE response_history ADD COLUMN review_status TEXT"))
        if "learned_examples" not in cols:
            conn.execute(text("ALTER TABLE response_history ADD COLUMN learned_examples TEXT"))

        # Seed platforms and ensure all expected platforms exist
        existing_slugs = {r[0] for r in conn.execute(text("SELECT slug FROM platforms")).fetchall()}
        platforms_to_seed = [
            ('SCHN', 'schn'),
            ('LIV Golf', 'livgolf'),
            ('Altitude Sports', 'altitude'),
        ]
        for name, slug in platforms_to_seed:
            if slug not in existing_slugs:
                conn.execute(text(f"INSERT INTO platforms (name, slug) VALUES ('{name}', '{slug}')"))

        # Add monthly cost tracking columns to users if missing
        cols = [r[1] for r in conn.execute(text("PRAGMA table_info(users)")).fetchall()]
        if "monthly_cost" not in cols:
            conn.execute(text("ALTER TABLE users ADD COLUMN monthly_cost REAL DEFAULT 0.0 NOT NULL"))
        if "monthly_cost_month" not in cols:
            conn.execute(text("ALTER TABLE users ADD COLUMN monthly_cost_month TEXT"))

        # Add is_global column to platforms if missing
        cols = [r[1] for r in conn.execute(text("PRAGMA table_info(platforms)")).fetchall()]
        if "is_global" not in cols:
            conn.execute(text("ALTER TABLE platforms ADD COLUMN is_global INTEGER DEFAULT 0 NOT NULL"))

        # Add api_key to users if missing
        cols = [r[1] for r in conn.execute(text("PRAGMA table_info(users)")).fetchall()]
        if "api_key" not in cols:
            # SQLite does not support ADD COLUMN ... UNIQUE; add without constraint
            conn.execute(text("ALTER TABLE users ADD COLUMN api_key TEXT"))

        # Create ticket_logs table if missing
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS ticket_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id),
                ticket_url TEXT NOT NULL,
                worked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        """))


        # Seed default app settings
        try:
            setting_rows = conn.execute(text("SELECT key FROM app_settings")).fetchall()
            existing_keys = {r[0] for r in setting_rows}
        except Exception:
            existing_keys = set()
        if "freshdesk_on_generate" not in existing_keys:
            conn.execute(text("INSERT INTO app_settings (key, value) VALUES ('freshdesk_on_generate', 'true')"))
        # Add is_superadmin column to users if missing; set user id=1 as superadmin
        cols = [r[1] for r in conn.execute(text("PRAGMA table_info(users)")).fetchall()]
        if "is_superadmin" not in cols:
            conn.execute(text("ALTER TABLE users ADD COLUMN is_superadmin INTEGER DEFAULT 0 NOT NULL"))
            conn.execute(text("UPDATE users SET is_superadmin = 1 WHERE id = 1"))
        conn.commit()
