import { createContext, useContext, useEffect, useState } from 'react'
import client from '../api/client'

const PlatformContext = createContext(null)

export function PlatformProvider({ children }) {
  const [platforms, setPlatforms] = useState([])
  const [activePlatform, setActivePlatformState] = useState(null)

  const loadPlatforms = () => {
    client.get('/platforms/').then((res) => {
      const list = res.data
      setPlatforms(list)
      if (!list.length) return

      const savedId = parseInt(localStorage.getItem('selectedPlatformId'), 10)
      const saved = list.find((p) => p.id === savedId)
      setActivePlatformState(prev => prev || saved || list[0])
    }).catch(() => {})
  }

  useEffect(() => {
    loadPlatforms()
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
