import { useCallback, useEffect, useRef, useState } from 'react'
import client from '../api/client'

const getTodayLogs = (logs) => {
  const today = new Date().toDateString()
  return logs.filter(l => new Date(l.worked_at + 'Z').toDateString() === today)
}
const formatTime = (worked_at) =>
  new Date(worked_at + 'Z').toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
const getTicketId = (url) =>
  '#' + url.replace('https://viewlift.freshdesk.com/a/tickets/', '')

export default function TrackerToday() {
  const [logs, setLogs] = useState([])
  const [stats, setStats] = useState({ today_count: 0, daily_goal: 35 })
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  const refresh = useCallback(async () => {
    try {
      const [logsRes, statsRes] = await Promise.all([
        client.get('/ticket-tracker/'),
        client.get('/ticket-tracker/stats'),
      ])
      setLogs(logsRes.data)
      setStats(statsRes.data)
    } catch { /* silently ignore */ }
  }, [])

  useEffect(() => {
    refresh()
    const iv = setInterval(refresh, 30000)
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    window.addEventListener('tracker-refresh', onFocus)
    return () => {
      clearInterval(iv)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('tracker-refresh', onFocus)
    }
  }, [refresh])

  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const todayLogs = getTodayLogs(logs)
  const goalReached = todayLogs.length >= (stats.daily_goal || 35)

  return (
    <div className="relative hidden sm:block" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        title="Tracker Today"
        className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors"
      >
        <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" strokeWidth={1.6} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 6v.75m0 3v.75m0 3v.75m0 3V18m-9-5.25h5.25M7.5 15h3M3.375 5.25c-.621 0-1.125.504-1.125 1.125v3.026a2.999 2.999 0 010 5.198v3.026c0 .621.504 1.125 1.125 1.125h17.25c.621 0 1.125-.504 1.125-1.125v-3.026a2.999 2.999 0 010-5.198V6.375c0-.621-.504-1.125-1.125-1.125H3.375z" />
        </svg>
        <span className={`font-bold ${goalReached ? 'text-green-600 dark:text-green-400' : 'text-blue-600 dark:text-blue-400'}`}>{todayLogs.length}</span>
        <span className="text-xs text-gray-400">/ {stats.daily_goal} goal</span>
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-72 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 z-50 overflow-hidden">
          <div className="px-3 py-2 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-xs font-semibold text-gray-600 dark:text-gray-300 uppercase tracking-wide">Tracker Today</h3>
          </div>
          <div className="max-h-80 overflow-y-auto divide-y divide-gray-100 dark:divide-gray-700">
            {todayLogs.length === 0 ? (
              <p className="text-xs text-gray-400 text-center py-6 px-3">No tickets today</p>
            ) : todayLogs.map(log => (
              <div key={log.id} className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors group">
                <span className="text-xs text-gray-400 font-mono flex-shrink-0 w-14">{formatTime(log.worked_at)}</span>
                <a href={log.ticket_url} target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline truncate flex-1">
                  {getTicketId(log.ticket_url)}
                </a>
                <button
                  onClick={() => client.delete(`/ticket-tracker/${log.id}`).then(() => setLogs(prev => prev.filter(l => l.id !== log.id))).catch(() => {})}
                  className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-all flex-shrink-0"
                  title="Delete"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
