import { useState, useEffect, useCallback } from 'react'
import Layout from '../components/Layout'
import client from '../api/client'
import toast from 'react-hot-toast'

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
      <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
        <span className="font-semibold text-gray-700 dark:text-gray-200">{item.customer_name || 'Unknown customer'}</span>
        {item.platform_name && <span className="px-2 py-0.5 rounded-full bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300">{item.platform_name}</span>}
        {item.agent_username && <span>agent: {item.agent_username}</span>}
        <span>{new Date(item.created_at).toLocaleString()}</span>
      </div>
      <div>
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Customer message</p>
        <div className="text-sm text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-700/50 rounded-md p-3 whitespace-pre-wrap max-h-48 overflow-y-auto">
          {item.customer_message}
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

export default function ReviewQueue() {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await client.get('/history/review-queue')
      setItems(res.data.items || [])
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to load review queue')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const remove = (id) => setItems((prev) => prev.filter((i) => i.id !== id))

  return (
    <Layout>
      <div className="max-w-4xl mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-bold text-gray-800 dark:text-white">
            Review Queue {items.length > 0 && <span className="ml-1 text-sm font-semibold text-white bg-red-500 rounded-full px-2 py-0.5">{items.length}</span>}
          </h2>
          <button onClick={load} className="text-sm text-blue-600 dark:text-blue-400 hover:underline">↺ Refresh</button>
        </div>
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
          items.map((item) => <QueueItem key={item.id} item={item} onDone={remove} />)
        )}
      </div>
    </Layout>
  )
}
