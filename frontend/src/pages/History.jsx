import { useState, useEffect, useCallback } from 'react'
import Layout from '../components/Layout'
import client from '../api/client'
import toast from 'react-hot-toast'

function getDateRange(preset) {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const today = fmt(now)

  if (preset === 'today') return { start: today, end: today }

  if (preset === 'week') {
    const day = now.getDay()
    const diff = day === 0 ? -6 : 1 - day
    const start = new Date(now)
    start.setDate(now.getDate() + diff)
    const end = new Date(start)
    end.setDate(start.getDate() + 6)
    return { start: fmt(start), end: fmt(end) }
  }

  if (preset === 'month') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1)
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0)
    return { start: fmt(start), end: fmt(end) }
  }

  if (preset === 'lastmonth') {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const end = new Date(now.getFullYear(), now.getMonth(), 0)
    return { start: fmt(start), end: fmt(end) }
  }

  return { start: today, end: today }
}

const PRESETS = [
  { key: 'today',     label: 'Today' },
  { key: 'week',      label: 'This Week' },
  { key: 'month',     label: 'This Month' },
  { key: 'lastmonth', label: 'Last Month' },
  { key: 'custom',    label: 'Custom' },
]

const COLS = [
  { key: 'name',      label: 'Agent name' },
  { key: 'responses', label: 'Responses' },
  { key: 'notes',     label: 'Private notes' },
  { key: 'total',     label: 'Total Interaction' },
  { key: 'resolved',  label: 'Tickets resolved' },
  { key: 'assigned',  label: 'Tickets assigned' },
]

export default function History() {
  const [preset, setPreset] = useState('month')
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)

  const { start, end } =
    preset === 'custom'
      ? { start: customStart, end: customEnd }
      : getDateRange(preset)

  const fetchReport = useCallback(async (s, e) => {
    if (!s || !e) return
    setLoading(true)
    setData(null)
    try {
      const res = await client.get('/freshdesk/agent-report', { params: { start: s, end: e }, timeout: 120000 })
      setData(res.data)
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to load report')
    } finally {
      setLoading(false)
    }
  }, [])

  // No auto-fetch on mount: the agent-report scans thousands of Freshdesk tickets
  // and would burn API calls just by visiting this tab. Fetch only on click.
  const handlePreset = (key) => {
    setPreset(key)
    if (key !== 'custom') {
      const range = getDateRange(key)
      fetchReport(range.start, range.end)
    }
  }

  return (
    <Layout>
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-800 dark:text-white">B2C L1 Reports</h2>
        <p className="text-gray-500 dark:text-gray-400 mt-1 text-sm">
          Agent activity sourced from Freshdesk
        </p>
      </div>

      {/* Date Range Picker */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-4 mb-5 flex flex-wrap items-center gap-3">
        <div className="flex gap-1.5 flex-wrap">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              onClick={() => handlePreset(p.key)}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                preset === p.key
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {preset === 'custom' && (
          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="date"
              value={customStart}
              onChange={(e) => setCustomStart(e.target.value)}
              className="border border-gray-300 dark:border-gray-600 rounded-md px-3 py-1.5 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
            />
            <span className="text-gray-400 text-sm">→</span>
            <input
              type="date"
              value={customEnd}
              onChange={(e) => setCustomEnd(e.target.value)}
              className="border border-gray-300 dark:border-gray-600 rounded-md px-3 py-1.5 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
            />
            <button
              onClick={() => fetchReport(customStart, customEnd)}
              disabled={!customStart || !customEnd}
              className="px-4 py-1.5 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Apply
            </button>
          </div>
        )}

        {start && end && preset !== 'custom' && (
          <span className="text-xs text-gray-400 dark:text-gray-500 ml-auto">
            {start} → {end}
          </span>
        )}
      </div>

      {/* Table / States */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <svg className="animate-spin h-8 w-8 text-blue-600" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Loading report — this may take up to a minute…
            </p>
          </div>
        ) : !data ? (
          <div className="flex items-center justify-center py-20 text-gray-400 dark:text-gray-500 text-sm">
            Pick a range above to load the report — nothing is fetched automatically to save Freshdesk API calls
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-700/50">
                <tr>
                  {COLS.map((col) => (
                    <th
                      key={col.key}
                      className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider whitespace-nowrap"
                    >
                      {col.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {data.agents.map((agent) => (
                  <tr
                    key={agent.fd_id}
                    className="hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors"
                  >
                    <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-white whitespace-nowrap">
                      {agent.name}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300">{agent.responses}</td>
                    <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300">{agent.notes}</td>
                    <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300 font-medium">{agent.total}</td>
                    <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300">{agent.resolved}</td>
                    <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300">{agent.assigned}</td>
                  </tr>
                ))}
                <tr className="bg-gray-50 dark:bg-gray-700/40 font-semibold border-t-2 border-gray-200 dark:border-gray-600">
                  <td className="px-4 py-3 text-sm text-gray-800 dark:text-gray-200">Grand Total</td>
                  <td className="px-4 py-3 text-sm text-gray-800 dark:text-gray-200">{data.totals.responses}</td>
                  <td className="px-4 py-3 text-sm text-gray-800 dark:text-gray-200">{data.totals.notes}</td>
                  <td className="px-4 py-3 text-sm text-gray-800 dark:text-gray-200">{data.totals.total}</td>
                  <td className="px-4 py-3 text-sm text-gray-800 dark:text-gray-200">{data.totals.resolved}</td>
                  <td className="px-4 py-3 text-sm text-gray-800 dark:text-gray-200">{data.totals.assigned}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>

      {data && (
        <p className="mt-3 text-xs text-gray-400 dark:text-gray-500 text-center">
          Freshdesk data · {data.period.start} → {data.period.end}
        </p>
      )}
    </Layout>
  )
}
