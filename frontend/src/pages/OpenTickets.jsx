import { useState, useRef } from 'react'
import Layout from '../components/Layout'
import client from '../api/client'
import toast from 'react-hot-toast'

const FRESHDESK_DOMAIN = 'viewlift.freshdesk.com'

function ControllableBadge({ value }) {
  if (value === 'yes') {
    return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300">Controllable</span>
  }
  if (value === 'no') {
    return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300">Not controllable</span>
  }
  return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300">Unknown</span>
}

export default function OpenTickets() {
  const [fileName, setFileName] = useState('')
  const [csvText, setCsvText] = useState('')
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState(null)
  const fileRef = useRef(null)

  const onFile = (e) => {
    const f = e.target.files?.[0]
    if (!f) return
    setFileName(f.name)
    const reader = new FileReader()
    reader.onload = () => setCsvText(String(reader.result || ''))
    reader.readAsText(f)
  }

  const analyze = async () => {
    if (!csvText.trim()) { toast.error('Upload a CSV first'); return }
    setLoading(true)
    setData(null)
    try {
      const res = await client.post('/csat/analyze', { csv_text: csvText }, { timeout: 300000 })
      setData(res.data)
      if (res.data.dissatisfied_count === 0) {
        toast('No dissatisfaction tickets found in this CSV', { icon: '✅' })
      } else {
        toast.success(`Analyzed ${res.data.dissatisfied_count} dissatisfaction ticket(s)`)
      }
    } catch (err) {
      const d = err?.response?.data?.detail
      toast.error(typeof d === 'string' ? d : 'Failed to analyze CSV')
    } finally {
      setLoading(false)
    }
  }

  const exportCsv = () => {
    if (!data?.results?.length) return
    const header = ['Ticket Id', 'Rating', 'Agent', 'Group', 'Controllable', 'Explanation', 'Comment']
    const esc = (v) => `"${String(v || '').replace(/"/g, '""')}"`
    const lines = [header.join(',')]
    for (const r of data.results) {
      lines.push([r.ticket_id, r.rating, r.agent, r.group, r.controllable, r.explanation, r.comment].map(esc).join(','))
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'csat-analysis.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Layout>
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-800 dark:text-white">CSAT Analysis</h2>
        <p className="text-gray-500 dark:text-gray-400 mt-1 text-sm">
          Upload a satisfaction CSV. The bot reviews the <strong>dissatisfaction</strong> tickets and,
          using our FAQ knowledge base as policy, flags which were controllable by support and why.
        </p>
      </div>

      {/* Upload */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-4 mb-5 flex flex-wrap items-center gap-3">
        <input ref={fileRef} type="file" accept=".csv,.tsv,text/csv" onChange={onFile} className="hidden" />
        <button
          onClick={() => fileRef.current?.click()}
          className="px-4 py-2 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 rounded-md text-sm font-medium hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
        >
          📎 Choose CSV
        </button>
        <span className="text-sm text-gray-500 dark:text-gray-400 truncate max-w-xs">{fileName || 'No file selected'}</span>
        <button
          onClick={analyze}
          disabled={loading || !csvText.trim()}
          className="ml-auto px-5 py-2 bg-blue-600 text-white rounded-md text-sm font-semibold hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? 'Analyzing…' : '⚡ Analyze'}
        </button>
      </div>

      {loading && (
        <div className="flex flex-col items-center justify-center py-20 gap-3">
          <svg className="animate-spin h-8 w-8 text-blue-600" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <p className="text-sm text-gray-500 dark:text-gray-400">Reviewing dissatisfaction tickets against the FAQ policies…</p>
        </div>
      )}

      {data && !loading && (
        <>
          {/* Summary */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
            <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
              <p className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">Rows</p>
              <p className="text-2xl font-bold text-gray-800 dark:text-white">{data.total_rows}</p>
            </div>
            <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
              <p className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">Dissatisfaction</p>
              <p className="text-2xl font-bold text-amber-600 dark:text-amber-400">{data.dissatisfied_count}</p>
            </div>
            <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
              <p className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">Controllable</p>
              <p className="text-2xl font-bold text-red-600 dark:text-red-400">{data.summary.controllable}</p>
            </div>
            <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
              <p className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">Not controllable</p>
              <p className="text-2xl font-bold text-green-600 dark:text-green-400">{data.summary.not_controllable}</p>
            </div>
          </div>

          {data.dissatisfied_count === 0 ? (
            <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-8 text-center text-gray-500 dark:text-gray-400">
              No dissatisfaction tickets found.
              <div className="mt-3 text-xs">Ratings seen: {Object.entries(data.ratings_seen || {}).map(([k, v]) => `${k || '(blank)'} × ${v}`).join(' · ')}</div>
            </div>
          ) : (
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
              <div className="flex justify-between items-center px-4 py-3 border-b border-gray-200 dark:border-gray-700">
                <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Dissatisfaction breakdown</h3>
                <button onClick={exportCsv} className="text-xs px-3 py-1.5 rounded-md bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600">⤓ Export CSV</button>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700 text-sm">
                  <thead className="bg-gray-50 dark:bg-gray-700/50">
                    <tr>
                      {['Ticket', 'Rating', 'Agent', 'Assessment', 'Comment & explanation'].map(h => (
                        <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-700/60">
                    {data.results.map((r, i) => (
                      <tr key={i} className="align-top">
                        <td className="px-4 py-3 whitespace-nowrap">
                          {r.ticket_id ? (
                            <a href={`https://${FRESHDESK_DOMAIN}/a/tickets/${r.ticket_id}`} target="_blank" rel="noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline font-mono text-xs">#{r.ticket_id}</a>
                          ) : <span className="text-gray-400 text-xs">—</span>}
                          {r.group && <div className="text-[10px] text-gray-400 mt-0.5">{r.group}</div>}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-xs text-amber-600 dark:text-amber-400">{r.rating}</td>
                        <td className="px-4 py-3 whitespace-nowrap text-xs text-gray-600 dark:text-gray-300">{r.agent || '—'}</td>
                        <td className="px-4 py-3 whitespace-nowrap"><ControllableBadge value={r.controllable} /></td>
                        <td className="px-4 py-3 max-w-lg">
                          {r.comment && <p className="text-xs text-gray-500 dark:text-gray-400 italic mb-1">"{r.comment}"</p>}
                          <p className="text-xs text-gray-700 dark:text-gray-200">{r.explanation}</p>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {!data && !loading && (
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-10 text-center text-gray-400 dark:text-gray-500 text-sm">
          Upload a satisfaction CSV and click Analyze to begin.
        </div>
      )}
    </Layout>
  )
}
