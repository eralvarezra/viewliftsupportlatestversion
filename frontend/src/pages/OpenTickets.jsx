import { useState, useEffect, useCallback } from 'react'
import Layout from '../components/Layout'
import client from '../api/client'
import toast from 'react-hot-toast'

const STATUS_COLORS = {
  'Open': 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  'Waiting on L1': 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
}

const PRIORITY_LABELS = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Urgent' }
const PRIORITY_COLORS = {
  1: 'text-gray-400',
  2: 'text-blue-500',
  3: 'text-orange-500',
  4: 'text-red-500',
}

function formatDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function TicketCard({ ticket }) {
  return (
    <a
      href={ticket.url}
      target="_blank"
      rel="noopener noreferrer"
      className="block p-3 rounded-lg border border-gray-100 dark:border-gray-700 hover:border-blue-300 dark:hover:border-blue-600 hover:bg-blue-50/50 dark:hover:bg-blue-900/10 transition-all group"
    >
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <span className="text-xs font-mono text-gray-400 dark:text-gray-500 flex-shrink-0">#{ticket.id}</span>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <span className={`text-xs font-medium ${PRIORITY_COLORS[ticket.priority]}`}>
            {PRIORITY_LABELS[ticket.priority] || ''}
          </span>
          <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${STATUS_COLORS[ticket.status_label] || 'bg-gray-100 text-gray-600'}`}>
            {ticket.status_label}
          </span>
        </div>
      </div>
      <p className="text-sm text-gray-800 dark:text-gray-100 font-medium leading-snug group-hover:text-blue-700 dark:group-hover:text-blue-300 line-clamp-2">
        {ticket.subject}
      </p>
      {ticket.tags?.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {ticket.tags.slice(0, 3).map(tag => (
            <span key={tag} className="text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400">
              {tag}
            </span>
          ))}
        </div>
      )}
      {ticket.possible_last_response && (
        <div className="mt-2 p-2 rounded-md bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800">
          <div className="flex items-center gap-1.5 mb-1">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 flex-shrink-0"></span>
            <span className="text-xs font-semibold text-green-700 dark:text-green-400">Possible Last Response</span>
          </div>
          {ticket.last_customer_message && (
            <p className="text-xs text-green-700 dark:text-green-300 italic line-clamp-2">"{ticket.last_customer_message}"</p>
          )}
        </div>
      )}
      <p className="text-xs text-gray-400 dark:text-gray-500 mt-1.5">
        Updated {formatDate(ticket.updated_at)}
      </p>
    </a>
  )
}

function PlatformColumn({ name, tickets, loading }) {
  const [collapsed, setCollapsed] = useState(false)
  const open = tickets.filter(t => t.status_label === 'Open')
  const waitingL1 = tickets.filter(t => t.status_label === 'Waiting on L1')

  return (
    <div className="min-w-0">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
        <button onClick={() => setCollapsed(c => !c)} className="w-full px-4 py-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700 hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <svg className={"w-4 h-4 text-gray-400 transition-transform " + (collapsed ? '-rotate-90' : '')} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
              <h3 className="font-semibold text-gray-800 dark:text-white">{name}</h3>
            </div>
            <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-gray-200 dark:bg-gray-600 text-gray-800 dark:text-gray-100">
              {loading ? '…' : tickets.length + ' total'}
            </span>
          </div>
        </button>

        {!collapsed && loading ? (
          <div className="p-6 space-y-3">
            {[1,2,3].map(i => (
              <div key={i} className="h-16 rounded-lg bg-gray-100 dark:bg-gray-700 animate-pulse" />
            ))}
          </div>
        ) : !collapsed ? (
          <div className="divide-y divide-gray-100 dark:divide-gray-700">
            {/* Open section */}
            <div className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <span className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0"></span>
                <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                  Open
                </span>
                <span className="ml-auto text-xs font-bold px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300">{open.length}</span>
              </div>
              {open.length === 0 ? (
                <p className="text-xs text-gray-400 dark:text-gray-500 text-center py-2">No open tickets</p>
              ) : (
                <div className="space-y-2">
                  {open.map(t => <TicketCard key={t.id} ticket={t} />)}
                </div>
              )}
            </div>

            {/* Waiting on L1 section */}
            <div className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <span className="w-2 h-2 rounded-full bg-amber-500 flex-shrink-0"></span>
                <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                  Waiting on L1
                </span>
                <span className="ml-auto text-xs font-bold px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300">{waitingL1.length}</span>
              </div>
              {waitingL1.length === 0 ? (
                <p className="text-xs text-gray-400 dark:text-gray-500 text-center py-2">No tickets waiting</p>
              ) : (
                <div className="space-y-2">
                  {waitingL1.map(t => <TicketCard key={t.id} ticket={t} />)}
                </div>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

export default function OpenTickets() {
  const [data, setData] = useState({})
  const [loading, setLoading] = useState(true)
  const [lastRefresh, setLastRefresh] = useState(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    try {
      const r = await client.get('/freshdesk/open-tickets')
      setData(r.data)
      setLastRefresh(new Date())
      if (isRefresh) toast.success('Tickets refreshed')
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to load tickets')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const platforms = Object.keys(data).filter(k => k !== 'Other' && data[k].length > 0)
  const totalOpen = platforms.reduce((sum, k) => sum + data[k].filter(t => t.status_label === 'Open').length, 0)
  const totalL1   = platforms.reduce((sum, k) => sum + data[k].filter(t => t.status_label === 'Waiting on L1').length, 0)

  return (
    <Layout>
      <div className="max-w-6xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex items-start justify-between mb-6 flex-wrap gap-4">
          <div>
            <h2 className="text-2xl font-bold text-gray-800 dark:text-white">Open Tickets</h2>
            <p className="text-gray-500 dark:text-gray-400 text-sm mt-0.5">
              All clients — Open and Waiting on L1
            </p>
          </div>
          <div className="flex items-center gap-3">
            {lastRefresh && (
              <span className="text-xs text-gray-400 dark:text-gray-500">
                Last refresh: {lastRefresh.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
            )}
            <button
              onClick={() => load(true)}
              disabled={refreshing || loading}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
            >
              <svg className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              {refreshing ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>
        </div>

        {/* Summary badges */}
        {!loading && (
          <div className="flex gap-3 mb-6 flex-wrap">
            <div className="flex items-center gap-2 px-3 py-1.5 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-100 dark:border-blue-800">
              <span className="w-2 h-2 rounded-full bg-blue-500"></span>
              <span className="text-sm font-medium text-blue-700 dark:text-blue-300">{totalOpen} Open</span>
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-50 dark:bg-amber-900/20 rounded-lg border border-amber-100 dark:border-amber-800">
              <span className="w-2 h-2 rounded-full bg-amber-500"></span>
              <span className="text-sm font-medium text-amber-700 dark:text-amber-300">{totalL1} Waiting on L1</span>
            </div>
          </div>
        )}

        {/* Columns */}
        <div className="grid grid-cols-2 gap-4">
          {loading
            ? [1, 2, 3].map(i => <PlatformColumn key={i} name="" tickets={[]} loading={true} />)
            : platforms.map(name => (
                <PlatformColumn key={name} name={name} tickets={data[name] || []} loading={false} />
              ))
          }
        </div>
      </div>
    </Layout>
  )
}
