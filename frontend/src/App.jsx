import { Routes, Route, Navigate } from 'react-router-dom'
import { useEffect } from 'react'
import Login from './pages/Login'
import Register from './pages/Register'
import Generate from './pages/Generate'
import FAQs from './pages/FAQs'
import History from './pages/History'
import Users from './pages/Users'
import Insights from './pages/Insights'
import Tracker from './pages/Tracker'
import Profile from './pages/Profile'
import Reports from './pages/Reports'
import OpenTickets from './pages/OpenTickets'
import ProtectedRoute from './components/ProtectedRoute'
import { PlatformProvider } from './context/PlatformContext'
import { CoverProvider } from './context/CoverContext'

function App() {
  useEffect(() => {
    const saved = localStorage.getItem('darkMode')
    if (saved && JSON.parse(saved)) {
      document.documentElement.classList.add('dark')
    }
  }, [])

  return (
    <PlatformProvider>
      <CoverProvider>
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
        <Route
          path="/tracker"
          element={
            <ProtectedRoute>
              <Tracker />
            </ProtectedRoute>
          }
        />
        <Route
          path="/profile"
          element={
            <ProtectedRoute>
              <Profile />
            </ProtectedRoute>
          }
        />
        <Route
          path="/reports"
          element={
            <ProtectedRoute>
              <Reports />
            </ProtectedRoute>
          }
        />
        <Route
          path="/open-tickets"
          element={
            <ProtectedRoute>
              <OpenTickets />
            </ProtectedRoute>
          }
        />
        <Route path="/" element={<Navigate to="/login" replace />} />
      </Routes>
      </CoverProvider>
    </PlatformProvider>
  )
}

export default App
