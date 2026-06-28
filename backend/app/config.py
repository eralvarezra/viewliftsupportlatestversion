# backend/app/config.py
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        extra="ignore",
    )

    GROQ_API_KEY: str = ""
    ANTHROPIC_API_KEY: str = ""
    ENCRYPTION_KEY: str  # For encrypting user API keys
    JWT_SECRET: str
    ADMIN_PASSWORD: str = "admin123"

    DATABASE_URL: str  # Supabase PostgreSQL connection URL
    FRESHDESK_API_KEY: str = "_TDqN38_v7VaWOrsygmR"
    FRESHDESK_DOMAIN: str = "viewlift.freshdesk.com"


settings = Settings()