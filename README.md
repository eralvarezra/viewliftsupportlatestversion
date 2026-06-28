# SCHN+ Support Assistant

Internal webapp for generating customer support email responses using AI.

## Quick Start

1. Copy `.env.example` to `.env` and fill in your values
2. Run `docker-compose up --build`
3. Open http://localhost:3000
4. Login with `admin` / `<ADMIN_PASSWORD>`

## Development

### Backend
```bash
cd backend
python -m venv venv
source venv/bin/activate  # or `venv\Scripts\activate` on Windows
pip install -r requirements.txt
uvicorn app.main:app --reload
```

### Frontend
```bash
cd frontend
npm install
npm run dev
```

## API Documentation

Open http://localhost:8000/docs when backend is running.