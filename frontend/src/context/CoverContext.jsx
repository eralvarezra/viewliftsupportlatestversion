import { createContext, useContext, useState, useEffect } from 'react'
import client from '../api/client'
import { useAuth } from '../hooks/useAuth'

const CoverContext = createContext(null)

export function CoverProvider({ children }) {
  const { isAdmin } = useAuth()
  const [coverUserId, setCoverUserId] = useState(null)
  const [agents, setAgents] = useState([])

  useEffect(() => {
    if (isAdmin) {
      client.get('/freshdesk/agents').then(r => setAgents(r.data || [])).catch(() => {})
    }
  }, [isAdmin])

  const coverAgent = agents.find(a => a.id === coverUserId) || null

  return (
    <CoverContext.Provider value={{ coverUserId, setCoverUserId, agents, coverAgent }}>
      {children}
    </CoverContext.Provider>
  )
}

export function useCover() {
  return useContext(CoverContext)
}
