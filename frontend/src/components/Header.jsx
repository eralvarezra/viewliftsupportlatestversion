import { useEffect, useRef, useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { useDarkMode } from '../hooks/useDarkMode'
import { usePlatform } from '../context/PlatformContext'
import { useCover } from '../context/CoverContext'
import client from '../api/client'
import toast from 'react-hot-toast'

export default function Header() {
  const { user, isAdmin, logout } = useAuth()
  const { dark, toggle } = useDarkMode()
  const { platforms, activePlatform, setActivePlatform } = usePlatform()
  const { coverUserId, setCoverUserId } = useCover()
  const navigate = useNavigate()
  const [platformOpen, setPlatformOpen] = useState(false)
  const [burgerOpen, setBurgerOpen] = useState(false)
  const [agentList, setAgentList] = useState([])
  const platformRef = useRef(null)
  const burgerRef = useRef(null)

  useEffect(() => {
    const handler = (e) => {
      if (platformRef.current && !platformRef.current.contains(e.target)) setPlatformOpen(false)
      if (burgerRef.current && !burgerRef.current.contains(e.target)) setBurgerOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  useEffect(() => {
    if (isAdmin && user?.username) {
      client.get('/users/').then(res => {
        setAgentList(res.data.filter(u => u.username !== user.username && u.status !== 'inactive'))
      }).catch(() => {})
    }
  }, [isAdmin, user?.username])

  const handleLogout = () => {
    setCoverUserId(null)
    logout()
    toast.success('Logged out successfully')
    navigate('/login')
  }

  const handleCoverChange = (e) => {
    const val = e.target.value
    if (!val) {
      setCoverUserId(null)
    } else {
      const agent = agentList.find(u => u.id === Number(val))
      if (agent) setCoverUserId(agent.id)
    }
  }

  const coveringAgent = agentList.find(u => u.id === coverUserId) || null

  const navClass = ({ isActive }) =>
    `px-3 py-2 rounded-md text-sm font-medium transition-colors ${
      isActive
        ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300'
        : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-white'
    }`

  const navLinks = [
    { to: '/generate', label: 'Generate' },
    { to: '/history', label: 'History' },
    { to: '/tracker', label: 'Tracker' },
    { to: '/insights', label: 'Daily Update' },
    ...(isAdmin && user?.is_superadmin ? [
      { to: '/reports', label: 'Reports' },
      { to: '/open-tickets', label: 'Open Tickets' },
    ] : []),
  ]

  const settingsLinks = [
    { to: '/profile', label: 'Profile' },
    ...(isAdmin ? [
      { to: '/faqs', label: 'FAQs' },
      { to: '/users', label: 'Users' },
    ] : []),
  ]

  return (
    <header className="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-200 dark:border-gray-700 transition-colors">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          <div className="flex items-center gap-6">
            <h1 className="text-lg font-bold text-gray-800 dark:text-white whitespace-nowrap">
              ViewLift Support
            </h1>
            <nav className="hidden lg:flex items-center gap-1">
              {navLinks.map(({ to, label }) => (
                <NavLink key={to} to={to} className={navClass}>{label}</NavLink>
              ))}
            </nav>
          </div>

          <div className="flex items-center gap-2">
            {activePlatform && platforms.length > 1 && (
              <div className="relative" ref={platformRef}>
                <button
                  onClick={() => setPlatformOpen(o => !o)}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors"
                >
                  <span className="max-w-[120px] truncate">{activePlatform.name}</span>
                  <svg className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {platformOpen && (
                  <div className="absolute right-0 mt-1 w-44 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg shadow-lg z-50">
                    {platforms.map(p => (
                      <button
                        key={p.id}
                        onClick={() => { setActivePlatform(p); setPlatformOpen(false) }}
                        className={`w-full text-left px-4 py-2 text-sm first:rounded-t-lg last:rounded-b-lg transition-colors ${
                          p.id === activePlatform.id
                            ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 font-medium'
                            : 'text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-600'
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
              <span className="hidden sm:inline px-2 py-1 text-xs font-medium text-gray-500 dark:text-gray-400">
                {activePlatform.name}
              </span>
            )}

            {/* Cubrir select — admins only */}
            {isAdmin && agentList.length > 0 && (
              <div className="hidden sm:flex items-center gap-1.5">
                <span className="text-xs text-gray-400 dark:text-gray-500 whitespace-nowrap">Cubrir:</span>
                <select
                  value={coverUserId || ''}
                  onChange={handleCoverChange}
                  className="text-xs border border-gray-200 dark:border-gray-600 rounded-lg px-2 py-1.5 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-2 focus:ring-orange-400 max-w-[130px]"
                >
                  <option value="">Yo mismo</option>
                  {agentList.map(u => (
                    <option key={u.id} value={u.id}>{u.username}</option>
                  ))}
                </select>
              </div>
            )}

            <button
              onClick={toggle}
              className="p-2 rounded-md text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-700 transition-colors"
              title={dark ? 'Light mode' : 'Dark mode'}
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

            <div className="hidden sm:flex items-center gap-2">
              <span className="text-sm text-gray-500 dark:text-gray-400">{user?.username}</span>
              <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300 capitalize">
                {user?.role || 'user'}
              </span>
            </div>

            <div className="relative" ref={burgerRef}>
              <button
                onClick={() => setBurgerOpen(o => !o)}
                className="p-2 rounded-md text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-700 transition-colors"
                aria-label="Menu"
              >
                {burgerOpen ? (
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                  </svg>
                )}
              </button>

              {burgerOpen && (
                <div className="absolute right-0 mt-2 w-52 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl z-50 overflow-hidden">
                  <div className="lg:hidden border-b border-gray-100 dark:border-gray-700 p-2 space-y-0.5">
                    {navLinks.map(({ to, label }) => (
                      <NavLink
                        key={to}
                        to={to}
                        onClick={() => setBurgerOpen(false)}
                        className={({ isActive }) =>
                          `block px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                            isActive
                              ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
                              : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
                          }`
                        }
                      >
                        {label}
                      </NavLink>
                    ))}
                  </div>
                  <div className="sm:hidden px-3 py-2 border-b border-gray-100 dark:border-gray-700">
                    <p className="text-sm font-medium text-gray-800 dark:text-white">{user?.username}</p>
                    <p className="text-xs text-gray-400 capitalize">{user?.role}</p>
                  </div>
                  {/* Cubrir in burger menu */}
                  {isAdmin && agentList.length > 0 && (
                    <div className="p-3 border-b border-gray-100 dark:border-gray-700">
                      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1.5">Cubrir:</p>
                      <select
                        value={coverUserId || ''}
                        onChange={(e) => { handleCoverChange(e); setBurgerOpen(false) }}
                        className="w-full text-sm border border-gray-200 dark:border-gray-600 rounded-lg px-2 py-1.5 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-2 focus:ring-orange-400"
                      >
                        <option value="">Yo mismo</option>
                        {agentList.map(u => (
                          <option key={u.id} value={u.id}>{u.username}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div className="p-2 space-y-0.5">
                    <p className="px-3 pt-1 pb-0.5 text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide">Settings</p>
                    {settingsLinks.map(({ to, label }) => (
                      <NavLink
                        key={to}
                        to={to}
                        onClick={() => setBurgerOpen(false)}
                        className={({ isActive }) =>
                          `block px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                            isActive
                              ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
                              : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
                          }`
                        }
                      >
                        {label}
                      </NavLink>
                    ))}
                    <button
                      onClick={() => { setBurgerOpen(false); handleLogout() }}
                      className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                      </svg>
                      Logout
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Impersonation banner */}
      {coveringAgent && (
        <div className="bg-amber-400 dark:bg-amber-500 px-4 py-1.5 flex items-center justify-center gap-3">
          <svg className="w-4 h-4 text-amber-900 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
          </svg>
          <span className="text-sm font-medium text-amber-900">
            Estás trabajando como: <strong>{coveringAgent.username}</strong>
          </span>
          <button
            onClick={() => setCoverUserId(null)}
            className="text-xs font-semibold text-amber-800 hover:text-amber-900 underline underline-offset-2"
          >
            Salir
          </button>
        </div>
      )}
    </header>
  )
}
