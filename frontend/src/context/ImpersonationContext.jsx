import { createContext, useContext, useState, useCallback } from 'react'

const ImpersonationContext = createContext(null)

export function ImpersonationProvider({ children }) {
  const [workingAs, setWorkingAsState] = useState(() => {
    try {
      const stored = localStorage.getItem('workingAs')
      return stored ? JSON.parse(stored) : null
    } catch {
      return null
    }
  })

  const setWorkingAs = useCallback((user) => {
    if (user) {
      localStorage.setItem('workingAs', JSON.stringify(user))
      localStorage.setItem('workingAsId', String(user.id))
    } else {
      localStorage.removeItem('workingAs')
      localStorage.removeItem('workingAsId')
    }
    setWorkingAsState(user)
  }, [])

  const clearWorkingAs = useCallback(() => setWorkingAs(null), [setWorkingAs])

  return (
    <ImpersonationContext.Provider value={{ workingAs, setWorkingAs, clearWorkingAs }}>
      {children}
    </ImpersonationContext.Provider>
  )
}

export function useImpersonation() {
  return useContext(ImpersonationContext)
}
