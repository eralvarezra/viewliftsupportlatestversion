import { useState, useEffect } from 'react'
import Layout from '../components/Layout'
import client from '../api/client'
import toast from 'react-hot-toast'

function StatCard({ label, value, sub, color = 'text-gray-800 dark:text-white' }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
      <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">{label}</p>
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
      {sub && <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{sub}</p>}
    </div>
  )
}

function SetupCard({ onSaved }) {
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)

  const save = async () => {
    if (!token.trim()) return
    setSaving(true)
    try {
      await client.put('/harvest/config', { harvest_token: token.trim() })
      toast.success('Harvest token saved')
      onSaved()
    } catch {
      toast.error('Failed to save token')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-lg mx-auto mt-16 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-8 text-center space-y-4">
      <div className="w-12 h-12 rounded-full bg-orange-100 dark:bg-orange-900/30 flex items-center justify-center mx-auto">
        <svg className="w-6 h-6 text-orange-600 dark:text-orange-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </div>
      <div>
        <h2 className="text-lg font-semibold text-gray-800 dark:text-white">Connect Harvest</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Enter your Harvest Personal Access Token to see your pay report.
          Find it at <span className="font-medium">harvestapp.com → Developers → Personal Access Tokens</span>.
        </p>
      </div>
      <div className="flex gap-2">
        <input
          type="password"
          value={token}
          onChange={e => setToken(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && save()}
          placeholder="Harvest Personal Access Token"
          className="flex-1 px-3 py-2 text-sm border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-orange-500"
        />
        <button
          onClick={save}
          disabled={saving || !token.trim()}
          className="px-4 py-2 bg-orange-500 hover:bg-orange-600 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-colors"
        >
          {saving ? 'Saving…' : 'Connect'}
        </button>
      </div>
    </div>
  )
}

export default function GetPayed() {
  const [configured, setConfigured] = useState(null)
  const [report, setReport] = useState(null)
  const [loading, setLoading] = useState(false)
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [customRange, setCustomRange] = useState(false)

  const checkConfig = async () => {
    try {
      const r = await client.get('/harvest/config')
      setConfigured(r.data.configured)
      if (r.data.configured) loadReport()
    } catch {
      setConfigured(false)
    }
  }

  const loadReport = async (fd, td) => {
    setLoading(true)
    try {
      const params = {}
      if (fd && td) { params.from_date = fd; params.to_date = td }
      const r = await client.get('/harvest/report', { params })
      setReport(r.data)
      if (!fd) {
        setFromDate(r.data.from_date)
        setToDate(r.data.to_date)
      }
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to load report')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { checkConfig() }, [])

  if (configured === null) {
    return <Layout><div className="p-8 text-gray-400 text-sm">Loading…</div></Layout>
  }

  if (!configured) {
    return <Layout><SetupCard onSaved={() => { setConfigured(true); loadReport() }} /></Layout>
  }

  const applyRange = () => {
    if (fromDate && toDate) loadReport(fromDate, toDate)
  }

  const approvalPct = report ? Math.round((report.approved_hours / (report.billable_hours || 1)) * 100) : 0

  return (
    <Layout>
      <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-2xl font-bold text-gray-800 dark:text-white">Get Paid</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
              {report ? `${report.name} — ${report.month}` : 'Loading your pay report…'}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {customRange ? (
              <>
                <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
                  className="px-3 py-1.5 text-sm border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-orange-500" />
                <span className="text-gray-400 text-sm">→</span>
                <input type="date" value={toDate} onChange={e => setToDate(e.target.value)}
                  className="px-3 py-1.5 text-sm border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-orange-500" />
                <button onClick={applyRange} disabled={loading}
                  className="px-3 py-1.5 bg-orange-500 hover:bg-orange-600 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-colors">
                  Apply
                </button>
                <button onClick={() => { setCustomRange(false); loadReport() }}
                  className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
                  Current month
                </button>
              </>
            ) : (
              <button onClick={() => setCustomRange(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-200 dark:border-gray-600 rounded-lg text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                Custom range
              </button>
            )}
            <button onClick={() => loadReport(customRange ? fromDate : undefined, customRange ? toDate : undefined)} disabled={loading}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-orange-500 hover:bg-orange-600 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-colors">
              <svg className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              {loading ? 'Loading…' : 'Refresh'}
            </button>
          </div>
        </div>

        {loading && !report && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {[1,2,3,4].map(i => <div key={i} className="h-24 rounded-xl bg-gray-100 dark:bg-gray-700 animate-pulse" />)}
          </div>
        )}

        {report && (
          <>
            {/* Total Payment Banner */}
            <div className="bg-gradient-to-r from-orange-500 to-orange-600 rounded-xl p-6 text-white shadow-lg">
              <p className="text-sm font-medium opacity-80 mb-1">Total Payment — {report.month}</p>
              <p className="text-4xl font-bold">${report.total_payment.toFixed(2)}</p>
              <div className="flex gap-4 mt-3 text-sm opacity-90 flex-wrap">
                <span>Base: ${report.earned.toFixed(2)}</span>
                {report.weekend_bonus > 0 && <span>+ Weekend bonus: ${report.weekend_bonus.toFixed(2)} ({report.weekend_days} day{report.weekend_days !== 1 ? 's' : ''})</span>}
                <span>Rate: ${report.hourly_rate.toFixed(4)}/hr</span>
              </div>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <StatCard label="Total Hours" value={`${report.total_hours}h`} sub={`of ${report.capacity_hours}h capacity`} />
              <StatCard label="Billable Hours" value={`${report.billable_hours}h`} sub={report.time_off_hours > 0 ? `${report.time_off_hours}h time off` : 'No time off'} color="text-blue-600 dark:text-blue-400" />
              <StatCard label="Approved" value={`${report.approved_hours}h`} sub={`${approvalPct}% of billable`} color="text-green-600 dark:text-green-400" />
              <StatCard label="Pending" value={`${report.pending_hours}h`} sub="awaiting approval" color={report.pending_hours > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-gray-800 dark:text-white'} />
            </div>

            {/* Approval progress bar */}
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Hours Approval Progress</p>
                <p className="text-sm text-gray-500 dark:text-gray-400">{report.approved_hours}h approved / {report.billable_hours}h billable</p>
              </div>
              <div className="h-3 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
                <div
                  className="h-full bg-green-500 rounded-full transition-all"
                  style={{ width: `${Math.min(approvalPct, 100)}%` }}
                />
              </div>
              {report.pending_billable > 0 && (
                <p className="text-xs text-amber-600 dark:text-amber-400 mt-1.5">
                  {report.pending_billable}h pending approval — payment may increase once approved
                </p>
              )}
            </div>

            {/* Projects breakdown */}
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700">
                <h3 className="font-semibold text-gray-800 dark:text-white text-sm">Projects Breakdown</h3>
              </div>
              <div className="divide-y divide-gray-50 dark:divide-gray-700">
                {report.projects.map(p => (
                  <div key={p.name} className={`flex items-center justify-between px-4 py-3 ${p.is_time_off ? 'opacity-60' : ''}`}>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-gray-800 dark:text-gray-100 truncate">{p.name}</p>
                        {p.is_time_off && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400">Time Off</span>
                        )}
                      </div>
                      <p className="text-xs text-gray-400 dark:text-gray-500">{p.task}</p>
                    </div>
                    <div className="flex items-center gap-4 text-right flex-shrink-0">
                      {!p.is_time_off && (
                        <div className="hidden sm:flex gap-3 text-xs">
                          {p.approved > 0 && <span className="text-green-600 dark:text-green-400">{p.approved}h approved</span>}
                          {p.pending > 0 && <span className="text-amber-600 dark:text-amber-400">{p.pending}h pending</span>}
                        </div>
                      )}
                      <p className="text-sm font-semibold text-gray-700 dark:text-gray-200 w-14 text-right">{p.hours}h</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Calculation detail */}
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 space-y-2">
              <h3 className="font-semibold text-gray-800 dark:text-white text-sm mb-3">Payment Calculation</h3>
              <div className="space-y-1.5 text-sm">
                <div className="flex justify-between text-gray-600 dark:text-gray-400">
                  <span>Monthly salary</span><span>$900.00</span>
                </div>
                <div className="flex justify-between text-gray-600 dark:text-gray-400">
                  <span>Working hours in month</span><span>{report.monthly_hours}h</span>
                </div>
                <div className="flex justify-between text-gray-600 dark:text-gray-400">
                  <span>Hourly rate</span><span>${report.hourly_rate.toFixed(4)}</span>
                </div>
                <div className="flex justify-between text-gray-600 dark:text-gray-400">
                  <span>Effective billable hours</span><span>{report.effective_hours}h (of {report.capacity_hours}h capacity)</span>
                </div>
                <div className="border-t border-gray-100 dark:border-gray-700 pt-1.5 flex justify-between font-medium text-gray-700 dark:text-gray-200">
                  <span>Base earned</span><span>${report.earned.toFixed(2)}</span>
                </div>
                {report.weekend_bonus > 0 && (
                  <div className="flex justify-between font-medium text-gray-700 dark:text-gray-200">
                    <span>Weekend bonus ({report.weekend_days} day{report.weekend_days !== 1 ? 's' : ''} × $20)</span>
                    <span>+${report.weekend_bonus.toFixed(2)}</span>
                  </div>
                )}
                <div className="border-t border-gray-200 dark:border-gray-600 pt-2 flex justify-between text-base font-bold text-orange-600 dark:text-orange-400">
                  <span>Total</span><span>${report.total_payment.toFixed(2)}</span>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </Layout>
  )
}
