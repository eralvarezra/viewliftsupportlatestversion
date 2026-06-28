# Platform Selector — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a global platform selector to the SCHN frontend so agents can switch between SCHN, LIV Golf, and Altitude Sports, with all pages filtering their data by the active platform.

**Architecture:** A React context (`PlatformContext`) fetches platforms from `/api/platforms/` and exposes `activePlatform` + `setActivePlatform`. The active platform is persisted in `localStorage`. The Header shows a dropdown to switch platforms. Every page reads `activePlatform.id` from context and passes it to all API calls.

**Tech Stack:** React, Vite, Tailwind CSS, axios (`client` from `src/api/client.js`)

---

## File Map

| Action | Path |
|--------|------|
| Create | `src/context/PlatformContext.jsx` |
| Modify | `src/App.jsx` |
| Modify | `src/components/Header.jsx` |
| Modify | `src/pages/Generate.jsx` |
| Modify | `src/pages/FAQs.jsx` |
| Modify | `src/pages/History.jsx` |
| Modify | `src/pages/Insights.jsx` |

All files are inside `/root/frontend/` on the server.

---

### Task 1: Create PlatformContext

**Files:**
- Create: `src/context/PlatformContext.jsx`

- [ ] **Step 1: Create the context file**

Create `/root/frontend/src/context/PlatformContext.jsx`:

```jsx
import { createContext, useContext, useEffect, useState } from 'react'
import client from '../api/client'

const PlatformContext = createContext(null)

export function PlatformProvider({ children }) {
  const [platforms, setPlatforms] = useState([])
  const [activePlatform, setActivePlatformState] = useState(null)

  useEffect(() => {
    client.get('/platforms/').then((res) => {
      const list = res.data
      setPlatforms(list)
      if (!list.length) return

      const savedId = parseInt(localStorage.getItem('selectedPlatformId'), 10)
      const saved = list.find((p) => p.id === savedId)
      setActivePlatformState(saved || list[0])
    }).catch(() => {
      // token not ready yet — pages will re-trigger on auth
    })
  }, [])

  const setActivePlatform = (platform) => {
    localStorage.setItem('selectedPlatformId', platform.id)
    setActivePlatformState(platform)
  }

  return (
    <PlatformContext.Provider value={{ platforms, activePlatform, setActivePlatform }}>
      {children}
    </PlatformContext.Provider>
  )
}

export function usePlatform() {
  return useContext(PlatformContext)
}
```

- [ ] **Step 2: Verify the file exists**

```bash
ls /root/frontend/src/context/PlatformContext.jsx
```

Expected: file path printed with no error.

- [ ] **Step 3: Commit**

```bash
cd /root/frontend
git add src/context/PlatformContext.jsx
git commit -m "feat: add PlatformContext with localStorage persistence"
```

---

### Task 2: Wrap App in PlatformProvider

**Files:**
- Modify: `src/App.jsx`

- [ ] **Step 1: Update App.jsx**

Replace the full contents of `/root/frontend/src/App.jsx` with:

```jsx
import { Routes, Route, Navigate } from 'react-router-dom'
import { useEffect } from 'react'
import Login from './pages/Login'
import Register from './pages/Register'
import Generate from './pages/Generate'
import FAQs from './pages/FAQs'
import History from './pages/History'
import Users from './pages/Users'
import Insights from './pages/Insights'
import ProtectedRoute from './components/ProtectedRoute'
import { PlatformProvider } from './context/PlatformContext'

function App() {
  useEffect(() => {
    const saved = localStorage.getItem('darkMode')
    if (saved && JSON.parse(saved)) {
      document.documentElement.classList.add('dark')
    }
  }, [])

  return (
    <PlatformProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route
          path="/generate"
          element={
            <ProtectedRoute>
              <Generate />
            </ProtectedRoute>
          }
        />
        <Route
          path="/faqs"
          element={
            <ProtectedRoute>
              <FAQs />
            </ProtectedRoute>
          }
        />
        <Route
          path="/history"
          element={
            <ProtectedRoute>
              <History />
            </ProtectedRoute>
          }
        />
        <Route
          path="/users"
          element={
            <ProtectedRoute>
              <Users />
            </ProtectedRoute>
          }
        />
        <Route
          path="/insights"
          element={
            <ProtectedRoute>
              <Insights />
            </ProtectedRoute>
          }
        />
        <Route path="/" element={<Navigate to="/login" replace />} />
      </Routes>
    </PlatformProvider>
  )
}

export default App
```

- [ ] **Step 2: Commit**

```bash
cd /root/frontend
git add src/App.jsx
git commit -m "feat: wrap app in PlatformProvider"
```

---

### Task 3: Add Platform Selector to Header

**Files:**
- Modify: `src/components/Header.jsx`

- [ ] **Step 1: Update Header.jsx**

Replace the full contents of `/root/frontend/src/components/Header.jsx` with:

```jsx
import { useEffect, useState, useCallback, useRef } from 'react'
import { NavLink, useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { useDarkMode } from '../hooks/useDarkMode'
import { usePlatform } from '../context/PlatformContext'
import client from '../api/client'
import toast from 'react-hot-toast'

export default function Header() {
  const { user, isAdmin, logout } = useAuth()
  const { dark, toggle } = useDarkMode()
  const { platforms, activePlatform, setActivePlatform } = usePlatform()
  const navigate = useNavigate()
  const location = useLocation()
  const [stats, setStats] = useState({ today_count: 0, daily_goal: 35 })
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const dropdownRef = useRef(null)

  const fetchStats = useCallback(async () => {
    try {
      const res = await client.get('/history/stats')
      setStats(res.data)
    } catch {
      // silently ignore
    }
  }, [])

  const adjustCounter = async (delta) => {
    try {
      const res = await client.patch('/history/stats/adjust', { delta })
      setStats(res.data)
    } catch {
      toast.error('Failed to adjust counter')
    }
  }

  useEffect(() => { fetchStats() }, [fetchStats, location.pathname])

  useEffect(() => {
    const interval = setInterval(fetchStats, 60000)
    return () => clearInterval(interval)
  }, [fetchStats])

  useEffect(() => {
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const handleLogout = () => {
    logout()
    toast.success('Logged out successfully')
    navigate('/login')
  }

  const navLinkClass = ({ isActive }) =>
    `px-4 py-2 rounded-md text-sm font-medium transition-colors ${
      isActive
        ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300'
        : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-white'
    }`

  return (
    <header className="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-200 dark:border-gray-700 transition-colors">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          <div className="flex items-center space-x-8">
            <h1 className="text-xl font-bold text-gray-800 dark:text-white">
              SCHN Support Assistant
            </h1>
            <nav className="flex items-center space-x-2">
              <NavLink to="/generate" className={navLinkClass}>Generate</NavLink>
              <NavLink to="/history" className={navLinkClass}>History</NavLink>
              {isAdmin && <NavLink to="/faqs" className={navLinkClass}>FAQs</NavLink>}
              {isAdmin && <NavLink to="/users" className={navLinkClass}>Users</NavLink>}
              {isAdmin && <NavLink to="/insights" className={navLinkClass}>Insights</NavLink>}
            </nav>
          </div>

          <div className="flex items-center space-x-4">
            {/* Platform selector */}
            {activePlatform && platforms.length > 1 && (
              <div className="relative" ref={dropdownRef}>
                <button
                  onClick={() => setDropdownOpen((o) => !o)}
                  className="flex items-center space-x-2 px-3 py-1.5 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors"
                >
                  <span>{activePlatform.name}</span>
                  <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {dropdownOpen && (
                  <div className="absolute right-0 mt-1 w-40 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50">
                    {platforms.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => { setActivePlatform(p); setDropdownOpen(false) }}
                        className={`w-full text-left px-4 py-2 text-sm first:rounded-t-lg last:rounded-b-lg transition-colors ${
                          p.id === activePlatform.id
                            ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 font-medium'
                            : 'text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700'
                        }`}
                      >
                        {p.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {activePlatform && platforms.length === 1 && (
              <span className="px-3 py-1.5 text-sm font-medium text-gray-500 dark:text-gray-400">
                {activePlatform.name}
              </span>
            )}

            {/* Ticket counter */}
            <div className="flex items-center space-x-2 px-3 py-1.5 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg">
              <button
                onClick={() => adjustCounter(-1)}
                className="w-6 h-6 flex items-center justify-center rounded text-gray-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 dark:hover:text-red-400 transition-colors text-lg font-bold leading-none"
                title="Remove 1 ticket"
              >
                −
              </button>
              <div className="flex items-center space-x-3">
                <div className="text-center">
                  <div className="text-xs text-gray-400 leading-none">Today</div>
                  <div className="text-lg font-bold text-blue-600 dark:text-blue-400 leading-tight">{stats.today_count}</div>
                </div>
                <div className="w-px h-8 bg-gray-200 dark:bg-gray-600" />
                <div className="text-center">
                  <div className="text-xs text-gray-400 leading-none">Goal</div>
                  <div className="text-lg font-bold text-gray-700 dark:text-gray-200 leading-tight">{stats.daily_goal}</div>
                </div>
              </div>
              <button
                onClick={() => adjustCounter(1)}
                className="w-6 h-6 flex items-center justify-center rounded text-gray-500 hover:text-green-600 hover:bg-green-50 dark:hover:bg-green-900/30 dark:hover:text-green-400 transition-colors text-lg font-bold leading-none"
                title="Add 1 ticket"
              >
                +
              </button>
            </div>

            {/* Dark mode toggle */}
            <button
              onClick={toggle}
              className="p-2 rounded-md text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-700 transition-colors"
              title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {dark ? (
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" clipRule="evenodd" />
                </svg>
              ) : (
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
                </svg>
              )}
            </button>

            <div className="flex items-center space-x-2">
              <span className="text-sm text-gray-500 dark:text-gray-400">{user?.username}</span>
              <span className="px-2 py-1 text-xs font-medium rounded-full bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300 capitalize">
                {user?.role || 'unknown'}
              </span>
            </div>
            <button
              onClick={handleLogout}
              className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-300 dark:hover:text-white dark:hover:bg-gray-700 rounded-md transition-colors"
            >
              Logout
            </button>
          </div>
        </div>
      </div>
    </header>
  )
}
```

- [ ] **Step 2: Commit**

```bash
cd /root/frontend
git add src/components/Header.jsx
git commit -m "feat: add platform selector dropdown to header"
```

---

### Task 4: Update Generate.jsx

**Files:**
- Modify: `src/pages/Generate.jsx`

- [ ] **Step 1: Add usePlatform import**

After the last existing import line in `src/pages/Generate.jsx`, add:

```jsx
import { usePlatform } from '../context/PlatformContext'
```

- [ ] **Step 2: Destructure activePlatform inside the component**

After `const [dragOver, setDragOver] = useState(false)`, add:

```jsx
const { activePlatform } = usePlatform()
```

- [ ] **Step 3: Clear state on platform change**

After the `usePlatform` line, add:

```jsx
useEffect(() => {
  setCustomerMessage('')
  setScreenshot(null)
  setParsedInfo(null)
  setGeneratedResponse('')
  setFaqSources([])
}, [activePlatform?.id])
```

- [ ] **Step 4: Pass platform_id in handleAnalyzeAndGenerate**

Find the `client.post('/generate', {` call inside `handleAnalyzeAndGenerate` and add `platform_id`:

```jsx
const response = await client.post('/generate', {
  message: customerMessage,
  platform_id: activePlatform.id,
  image_base64: screenshot?.base64 || null,
  image_media_type: screenshot?.mediaType || 'image/png',
})
```

- [ ] **Step 5: Pass platform_id in handleRegenerate**

Find the `client.post('/generate', {` call inside `handleRegenerate` and add `platform_id`:

```jsx
const response = await client.post('/generate', {
  message: customerMessage,
  platform_id: activePlatform.id,
  image_base64: screenshot?.base64 || null,
  image_media_type: screenshot?.mediaType || 'image/png',
})
```

- [ ] **Step 6: Guard Analyze button**

Find the `disabled` prop on the "Analyze and Generate" button and add `|| !activePlatform`:

```jsx
disabled={isLoading || !customerMessage.trim() || !activePlatform}
```

- [ ] **Step 7: Commit**

```bash
cd /root/frontend
git add src/pages/Generate.jsx
git commit -m "feat: pass platform_id to generate endpoint"
```

---

### Task 5: Update FAQs.jsx

**Files:**
- Modify: `src/pages/FAQs.jsx`

- [ ] **Step 1: Add usePlatform import**

After the last existing import in `src/pages/FAQs.jsx`, add:

```jsx
import { usePlatform } from '../context/PlatformContext'
```

- [ ] **Step 2: Destructure activePlatform**

After `const { isAdmin } = useAuth()`, add:

```jsx
const { activePlatform } = usePlatform()
```

- [ ] **Step 3: Pass platform_id to list fetch**

Find `client.get('/faqs')` inside `fetchFaqs` and replace with:

```jsx
const response = await client.get('/faqs', { params: { platform_id: activePlatform.id } })
```

- [ ] **Step 4: Re-fetch on platform change**

Find the `useEffect(() => { fetchFaqs() }, [])` and replace with:

```jsx
useEffect(() => {
  if (activePlatform) fetchFaqs()
}, [activePlatform?.id]) // eslint-disable-line react-hooks/exhaustive-deps
```

- [ ] **Step 5: Pass platform_id in upload**

Find `formData.append('file', file)` and add after it:

```jsx
formData.append('platform_id', activePlatform.id)
```

- [ ] **Step 6: Commit**

```bash
cd /root/frontend
git add src/pages/FAQs.jsx
git commit -m "feat: pass platform_id to faqs list and upload"
```

---

### Task 6: Update History.jsx

**Files:**
- Modify: `src/pages/History.jsx`

- [ ] **Step 1: Add usePlatform import**

After the last existing import in `src/pages/History.jsx`, add:

```jsx
import { usePlatform } from '../context/PlatformContext'
```

- [ ] **Step 2: Destructure activePlatform**

After the last `useState` declaration inside the component, add:

```jsx
const { activePlatform } = usePlatform()
```

- [ ] **Step 3: Add platform_id to fetchHistory params**

Inside `fetchHistory`, find the `const params = {` block and add `platform_id`:

```jsx
const params = {
  skip: reset ? 0 : skip,
  limit,
  platform_id: activePlatform?.id,
}
```

- [ ] **Step 4: Reset on platform change**

Add a new `useEffect` after the existing ones (before the return):

```jsx
useEffect(() => {
  if (activePlatform) fetchHistory(true)
}, [activePlatform?.id]) // eslint-disable-line react-hooks/exhaustive-deps
```

- [ ] **Step 5: Add platform_id to detail fetch**

Find the `client.get` that loads a single entry (something like `client.get(\`/history/${id}\`)`) and add params:

```jsx
const res = await client.get(`/history/${entry.id}`, { params: { platform_id: activePlatform?.id } })
```

- [ ] **Step 6: Add platform_id to feedback patch**

Find the `client.patch` for feedback and add params as third argument:

```jsx
await client.patch(
  `/history/${selectedEntry.id}/feedback`,
  { feedback },
  { params: { platform_id: activePlatform?.id } }
)
```

- [ ] **Step 7: Commit**

```bash
cd /root/frontend
git add src/pages/History.jsx
git commit -m "feat: pass platform_id to all history endpoints"
```

---

### Task 7: Update Insights.jsx

**Files:**
- Modify: `src/pages/Insights.jsx`

- [ ] **Step 1: Add usePlatform import**

After the last existing import in `src/pages/Insights.jsx`, add:

```jsx
import { usePlatform } from '../context/PlatformContext'
```

- [ ] **Step 2: Destructure activePlatform**

At the top of the `Insights` component body, add:

```jsx
const { activePlatform } = usePlatform()
```

- [ ] **Step 3: Pass platform_id to trends endpoint**

Replace `client.post('/insights/trends')` with:

```jsx
const res = await client.post('/insights/trends', null, { params: { platform_id: activePlatform?.id } })
```

- [ ] **Step 4: Commit**

```bash
cd /root/frontend
git add src/pages/Insights.jsx
git commit -m "feat: pass platform_id to insights trends endpoint"
```

---

### Task 8: Build and Deploy

- [ ] **Step 1: Build frontend image**

```bash
cd /root
docker compose build schn-frontend
```

Expected: build completes with no errors.

- [ ] **Step 2: Restart frontend container**

```bash
docker compose up -d schn-frontend
```

Expected: `Container schn-frontend-1 Started`

- [ ] **Step 3: Verify container is running**

```bash
docker ps | grep schn-frontend
```

Expected: `schn-frontend-1` shows `Up` status.

- [ ] **Step 4: Smoke test in browser**

Verify:
1. Platform dropdown appears in header showing SCHN / LIV Golf / Altitude Sports
2. Switching to "Altitude Sports" clears the Generate page
3. FAQs page lists only documents for the selected platform
4. History page shows only history for the selected platform
5. Refreshing the page restores the previously selected platform (localStorage)
