# backend/app/main.py
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.config import settings
from app.database import init_db, run_migrations
from app.auth.routes import router as auth_router
from app.routes.generate import router as generate_router
from app.routes.faqs import router as faqs_router
from app.routes.history import router as history_router
from app.routes.users import router as users_router
from app.routes.insights import router as insights_router
from app.routes.platforms import router as platforms_router
from app.routes.ticket_tracker import router as ticket_tracker_router
from app.routes.harvest import router as harvest_router
from app.routes.daily_update import router as daily_update_router
from app.routes.reports import router as reports_router

app = FastAPI(
    title="SCHN+ Support Assistant",
    description="Internal API for generating customer support responses",
    version="1.0.0",
    redirect_slashes=False  # Disable trailing slash redirects
)

# CORS for frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Configure properly for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(auth_router, prefix="/api/auth", tags=["auth"])
app.include_router(generate_router, prefix="/api", tags=["generate"])
app.include_router(faqs_router, prefix="/api/faqs", tags=["faqs"])
app.include_router(history_router, prefix="/api/history", tags=["history"])
app.include_router(users_router, prefix="/api/users", tags=["users"])
app.include_router(insights_router, prefix="/api/insights", tags=["insights"])
app.include_router(platforms_router, prefix="/api/platforms", tags=["platforms"])
app.include_router(ticket_tracker_router, prefix="/api/ticket-tracker", tags=["ticket-tracker"])
app.include_router(daily_update_router, prefix="/api/daily-update", tags=["daily-update"])
app.include_router(reports_router, prefix="/api/reports", tags=["reports"])


@app.on_event("startup")
async def startup_event():
    init_db()
    run_migrations()
    from app.auth.utils import create_admin_user
    create_admin_user()


@app.get("/health")
async def health_check():
    return {"status": "healthy"}
from app.routes.freshdesk import router as freshdesk_router
app.include_router(freshdesk_router, prefix="/api/freshdesk", tags=["freshdesk"])
from app.routes.settings import router as settings_router
app.include_router(settings_router, prefix="/api/settings", tags=["settings"])

from app.routes.tracker_comments import router as tracker_comments_router
app.include_router(tracker_comments_router, prefix="/api/tracker-comments", tags=["tracker-comments"])

from app.routes.canned_responses import router as canned_responses_router
from app.routes.cms import router as cms_router
app.include_router(canned_responses_router, prefix="/api/canned-responses", tags=["canned-responses"])
app.include_router(cms_router, prefix="/api/cms", tags=["cms"])
app.include_router(harvest_router, prefix="/api/harvest", tags=["harvest"])

