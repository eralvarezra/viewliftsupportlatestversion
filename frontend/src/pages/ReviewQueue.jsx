import { useState, useEffect, useCallback } from 'react'
import Layout from '../components/Layout'
import client from '../api/client'
import toast from 'react-hot-toast'

const FRESHDESK_TICKET_URL = 'https://viewlift.freshdesk.com/a/tickets/'

const ticketIdFrom = (text) => (text.match(/\[Ticket #(\d+)\]/) || [])[1] || null

// Render "[Ticket #123456]" references as links to Freshdesk (to check if the
// customer marked the case resolved, read the thread, etc.)
function linkifyTickets(text) {
  return text.split(/(\[Ticket #\d+\])/g).map((part, i) => {
    const m = part.match(/^\[Ticket #(\d+)\]$/)
    return m ? (
      <a
        key={i}
        href={FRESHDESK_TICKET_URL + m[1]}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-600 dark:text-blue-400 font-semibold hover:underline"
      >
        {part}
      </a>
    ) : part
  })
}

function ItemMeta({ item }) {
  const ticketId = ticketIdFrom(item.customer_message)
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
      <span className="font-semibold text-gray-700 dark:text-gray-200">{item.customer_name || 'Unknown customer'}</span>
      {ticketId && (
        <a
          href={FRESHDESK_TICKET_URL + ticketId}
          target="_blank"
          rel="noopener noreferrer"
          className="px-2 py-0.5 rounded-full bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300 font-medium hover:underline"
          title="Open ticket in Freshdesk"
        >
          #{ticketId} ↗
        </a>
      )}
      {item.platform_name && <span className="px-2 py-0.5 rounded-full bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300">{item.platform_name}</span>}
      {item.agent_username && <span>agent: {item.agent_username}</span>}
      <span>{new Date(item.created_at).toLocaleString()}</span>
    </div>
  )
}

function QueueItem({ item, onDone }) {
  const [correction, setCorrection] = useState(item.generated_response)
  const [busy, setBusy] = useState(false)

  const save = async () => {
    if (!correction.trim()) { toast.error('Correction cannot be empty'); return }
    setBusy(true)
    try {
      await client.post(`/history/${item.id}/correct`, { corrected_response: correction })
      toast.success('Correction saved — the bot will learn from it')
      onDone(item.id)
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to save correction')
    } finally { setBusy(false) }
  }

  const dismiss = async () => {
    setBusy(true)
    try {
      await client.post(`/history/${item.id}/dismiss`)
      toast.success('Dismissed')
      onDone(item.id)
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to dismiss')
    } finally { setBusy(false) }
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-5 space-y-3">
      <ItemMeta item={item} />
      <div>
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Customer message</p>
        <div className="text-sm text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-700/50 rounded-md p-3 whitespace-pre-wrap max-h-48 overflow-y-auto">
          {linkifyTickets(item.customer_message)}
        </div>
      </div>
      <div>
        <p className="text-xs font-semibold text-red-400 uppercase tracking-wide mb-1">Bad response — edit it into the correct one</p>
        <textarea
          value={correction}
          onChange={(e) => setCorrection(e.target.value)}
          rows={10}
          className="w-full text-sm border border-gray-200 dark:border-gray-600 rounded-lg p-3 bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-400 font-mono"
        />
      </div>
      <div className="flex justify-end gap-2">
        <button
          onClick={dismiss}
          disabled={busy}
          className="px-4 py-2 text-sm font-medium text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-40 transition-colors"
        >
          Dismiss
        </button>
        <button
          onClick={save}
          disabled={busy}
          className="px-4 py-2 text-sm font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-40 transition-colors"
        >
          Save correction
        </button>
      </div>
    </div>
  )
}

const STATUS_BADGES = {
  pending: { label: 'in review queue', cls: 'bg-red-50 text-red-600 dark:bg-red-900/30 dark:text-red-300' },
  corrected: { label: 'corrected ✓', cls: 'bg-green-50 text-green-600 dark:bg-green-900/30 dark:text-green-300' },
  dismissed: { label: 'dismissed', cls: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400' },
}

function RecentItem({ item, onRated }) {
  const [expanded, setExpanded] = useState(false)
  const badge = item.review_status ? STATUS_BADGES[item.review_status] : null
  const isVerification = item.generated_response.includes('[NEEDS_VERIFICATION]')

  const rate = async (value) => {
    try {
      await client.patch(`/history/${item.id}/feedback`, { feedback: value })
      toast.success(value === 'useful' ? 'Rated as good response' : 'Sent to review queue')
      onRated(item.id, value)
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to save rating')
    }
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-4 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ItemMeta item={item} />
        <div className="flex items-center gap-1">
          {isVerification ? (
            <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-600 dark:bg-amber-900/30 dark:text-amber-300" title="Internal verification instructions, not a customer response — not ratable">
              verification step
            </span>
          ) : (<>
          {badge && <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${badge.cls}`}>{badge.label}</span>}
          <button
            onClick={() => rate('useful')}
            title="Good response — teaches the bot to answer similar cases like this"
            className={`px-2 py-1 rounded-md text-sm transition-colors border ${
              item.feedback === 'useful'
                ? 'bg-green-100 border-green-400 dark:bg-green-900/40 dark:border-green-600'
                : 'bg-transparent border-gray-200 dark:border-gray-600 opacity-60 hover:opacity-100'
            }`}
          >
            👍
          </button>
          <button
            onClick={() => rate('not_useful')}
            title="Bad response — sends it to the review queue"
            className={`px-2 py-1 rounded-md text-sm transition-colors border ${
              item.feedback === 'not_useful'
                ? 'bg-red-100 border-red-400 dark:bg-red-900/40 dark:border-red-600'
                : 'bg-transparent border-gray-200 dark:border-gray-600 opacity-60 hover:opacity-100'
            }`}
          >
            👎
          </button>
          </>)}
        </div>
      </div>
      <div className="text-sm text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-700/50 rounded-md p-3 whitespace-pre-wrap">
        {linkifyTickets(expanded || item.customer_message.length <= 220
          ? item.customer_message
          : item.customer_message.slice(0, 220) + '…')}
      </div>
      <div className={`text-sm text-gray-600 dark:text-gray-400 border-l-2 border-blue-200 dark:border-blue-800 pl-3 whitespace-pre-wrap ${expanded ? '' : 'max-h-24 overflow-hidden'}`}>
        {item.generated_response}
      </div>
      <button onClick={() => setExpanded((e) => !e)} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">
        {expanded ? '▲ Collapse' : '▼ Expand'}
      </button>
    </div>
  )
}

export default function ReviewQueue() {
  const [tab, setTab] = useState('queue') // 'queue' | 'recent'
  const [items, setItems] = useState([])
  const [recent, setRecent] = useState([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [queueRes, recentRes] = await Promise.all([
        client.get('/history/review-queue'),
        client.get('/history/recent-responses'),
      ])
      setItems(queueRes.data.items || [])
      setRecent(recentRes.data.items || [])
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to load review queue')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const removeFromQueue = (id) => {
    setItems((prev) => prev.filter((i) => i.id !== id))
    setRecent((prev) => prev.map((i) => (i.id === id ? { ...i, review_status: 'corrected' } : i)))
  }

  const onRated = (id, value) => {
    setRecent((prev) => prev.map((i) => (
      i.id === id
        ? { ...i, feedback: value, review_status: value === 'not_useful' ? (i.review_status === 'corrected' || i.review_status === 'dismissed' ? i.review_status : 'pending') : null }
        : i
    )))
    // keep the queue tab in sync without a full reload
    if (value === 'useful') {
      setItems((prev) => prev.filter((i) => i.id !== id))
    } else {
      const rated = recent.find((i) => i.id === id)
      if (rated && !items.some((i) => i.id === id) && rated.review_status !== 'corrected' && rated.review_status !== 'dismissed') {
        setItems((prev) => [{ ...rated, feedback: 'not_useful' }, ...prev])
      }
    }
  }

  const tabClass = (t) =>
    `px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
      tab === t
        ? 'bg-blue-600 text-white'
        : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
    }`

  return (
    <Layout>
      <div className="max-w-4xl mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button onClick={() => setTab('queue')} className={tabClass('queue')}>
              Pending review {items.length > 0 && <span className="ml-1 text-xs font-semibold text-white bg-red-500 rounded-full px-1.5 py-0.5">{items.length}</span>}
            </button>
            <button onClick={() => setTab('recent')} className={tabClass('recent')}>
              Recent responses
            </button>
          </div>
          <button onClick={load} className="text-sm text-blue-600 dark:text-blue-400 hover:underline">↺ Refresh</button>
        </div>

        {tab === 'queue' ? (
          <>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Responses rated 👎 by agents. Edit each one into the response the bot <em>should</em> have written — corrections are injected as examples when similar cases arrive.
            </p>
            {loading ? (
              <p className="text-sm text-gray-400">Loading…</p>
            ) : items.length === 0 ? (
              <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-8 text-center text-gray-400">
                🎉 No bad responses pending review
              </div>
            ) : (
              items.map((item) => <QueueItem key={item.id} item={item} onDone={removeFromQueue} />)
            )}
          </>
        ) : (
          <>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Latest generated responses across all agents. Rate the ones left unrated — 👍 teaches the bot, 👎 sends them to the review queue.
            </p>
            {loading ? (
              <p className="text-sm text-gray-400">Loading…</p>
            ) : recent.length === 0 ? (
              <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-8 text-center text-gray-400">
                No generated responses yet
              </div>
            ) : (
              recent.map((item) => <RecentItem key={item.id} item={item} onRated={onRated} />)
            )}
          </>
        )}
      </div>
    </Layout>
  )
}
