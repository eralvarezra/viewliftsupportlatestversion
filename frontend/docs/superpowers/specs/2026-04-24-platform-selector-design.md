# SCHN Multi-Platform Frontend Selector — Design Spec

**Date:** 2026-04-24
**Status:** Approved

## Problem

The SCHN backend already supports three programs (SCHN id=1, LIV Golf id=2, Altitude Sports id=3) with full platform isolation across FAQs, generation, history, and insights. The frontend has no awareness of platforms — it sends no platform_id to any API call, making the multi-platform backend inaccessible.

## Goal

Add a global platform selector to the frontend so agents can switch between SCHN, LIV Golf, and Altitude Sports. All pages must filter their data by the active platform.

## Architecture

### New: src/context/PlatformContext.jsx

- Fetches /api/platforms/ once on mount (after login, requires auth token)
- Stores platforms: Platform[] and activePlatform: Platform
- Initializes activePlatform from localStorage key selectedPlatformId; defaults to first platform if not set
- setActivePlatform(p) updates state and persists p.id to localStorage
- Exports usePlatform() hook

### Modified: src/App.jsx

- Wraps all routes inside PlatformProvider

### Modified: src/components/Header.jsx

- Reads { platforms, activePlatform, setActivePlatform } from usePlatform()
- Shows a dropdown selector on the right side of the header (before dark mode toggle)
- If only one platform exists, shows the name without a dropdown
- Matches existing Tailwind styling

### Modified: src/pages/Generate.jsx

- Reads activePlatform.id from context
- POST /generate includes platform_id: activePlatform.id
- useEffect([activePlatform.id]) clears message, response, and faq_sources when platform changes

### Modified: src/pages/FAQs.jsx

- GET /faqs?platform_id=N — re-fetches when activePlatform.id changes
- POST /faqs/upload FormData includes platform_id
- List clears before re-fetch on platform change

### Modified: src/pages/History.jsx

- GET /history?platform_id=N — re-fetches when activePlatform.id changes
- GET /history/{id}?platform_id=N — detail includes platform_id
- PATCH /history/{id}/feedback?platform_id=N — feedback includes platform_id

### Modified: src/pages/Insights.jsx

- POST /insights/trends?platform_id=N — passes platform_id in query param

## Data Flow

Login -> PlatformContext mounts -> fetch /api/platforms/
      -> restore from localStorage or default to platforms[0]
      -> Header shows selector

User changes platform ->
  setActivePlatform(p) -> localStorage updated
  -> Generate clears state
  -> FAQs re-fetches
  -> History re-fetches
  -> Insights re-fetches (on next analyze click)

## Files Changed

| File | Type |
|------|------|
| src/context/PlatformContext.jsx | New |
| src/App.jsx | Modified - add PlatformProvider |
| src/components/Header.jsx | Modified - add platform dropdown |
| src/pages/Generate.jsx | Modified - pass platform_id |
| src/pages/FAQs.jsx | Modified - pass platform_id |
| src/pages/History.jsx | Modified - pass platform_id |
| src/pages/Insights.jsx | Modified - pass platform_id |

## No Backend Changes Required

The backend already supports all three platforms with full isolation. No migrations or API changes needed.

## Deployment

After updating source files, rebuild and redeploy the frontend container:
docker compose build schn-frontend && docker compose up -d schn-frontend
