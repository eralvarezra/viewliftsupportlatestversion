import { Navigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'

function ProtectedRoute({ children, requireAdmin = false }) {
  const { isAuthenticated, isAdmin } = useAuth()

  // Redirect to login if not authenticated
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />
  }

  // Redirect to login if admin is required but user is not admin
  if (requireAdmin && !isAdmin) {
    return <Navigate to="/login" replace />
  }

  return children
}

export default ProtectedRoute