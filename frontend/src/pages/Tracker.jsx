import { useState, useEffect } from 'react'
import Layout from '../components/Layout'
import client from '../api/client'
import toast from 'react-hot-toast'

const DAYS_PER_PAGE = 7

const TAMPERMONKEY_SCRIPT = `// ==UserScript==
// @name         SCHN+ Case Tracker
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  Auto-tracks a case when status changes to Waiting on End User in Freshdesk
// @author       SCHN+
// @match        https://viewlift.freshdesk.com/a/tickets/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      135.181.37.72
// ==/UserScript==

(function () {
    'use strict';

    const TRACKER_URL = 'http://135.181.37.72:3001/api/ticket-tracker/';
    const WAITING_STATUS_ID = 12;
    const COOLDOWN_MS = 60000;

    // Prevents double-firing when both click listener and network interceptor trigger for the same action
    const recentlyTracked = new Map();

    GM_registerMenuCommand('⚙️ Set API Key', () => {
        const key = prompt('Paste your SCHN+ API Key (from Ticket Tracker page):');
        if (key && key.trim()) {
            GM_setValue('api_key', key.trim());
            alert('✅ API Key saved!');
        }
    });

    function getApiKey() { return GM_getValue('api_key', null); }

    function showToast(message, color = '#4f46e5') {
        const existing = document.getElementById('schn-tracker-toast');
        if (existing) existing.remove();
        const toast = document.createElement('div');
        toast.id = 'schn-tracker-toast';
        toast.style.cssText = \`position:fixed;bottom:24px;right:24px;z-index:2147483647;background:\${color};color:white;padding:11px 18px;border-radius:10px;font-size:13px;font-weight:600;box-shadow:0 6px 20px rgba(0,0,0,0.25);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;opacity:1;transition:opacity 0.4s;\`;
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 400); }, 3500);
    }

    function trackTicket(ticketId) {
        const now = Date.now();
        const lastTracked = recentlyTracked.get(ticketId);
        if (lastTracked && (now - lastTracked) < COOLDOWN_MS) {
            console.log(\`[SCHN+] Skipped duplicate track for #\${ticketId} (cooldown active)\`);
            return;
        }
        recentlyTracked.set(ticketId, now);

        const apiKey = getApiKey();
        if (!apiKey) { showToast('⚠️ No API Key set. Click Tampermonkey → Set API Key.', '#dc2626'); return; }
        GM_xmlhttpRequest({
            method: 'POST',
            url: TRACKER_URL,
            headers: { 'Content-Type': 'application/json', 'Authorization': \`Bearer \${apiKey}\` },
            data: JSON.stringify({ ticket_url: \`https://viewlift.freshdesk.com/a/tickets/\${ticketId}\` }),
            onload: (r) => r.status === 200 || r.status === 201
                ? (console.log(\`[SCHN+] ✓ Tracked #\${ticketId}\`), showToast(\`✓ Ticket #\${ticketId} tracked\`, '#16a34a'))
                : (console.warn(\`[SCHN+] Error \${r.status}\`, r.responseText), showToast(\`⚠️ Tracker error (\${r.status})\`, '#d97706')),
            onerror: () => showToast('❌ Could not reach SCHN+ tracker', '#dc2626'),
        });
    }

    function checkBody(body, url, method) {
        if (!/tickets/i.test(url)) return;
        const ticketMatch = url.match(/\\/tickets\\/(\\d+)/);
        if (!ticketMatch) return;
        console.log(\`[SCHN+] \${method} \${url}\`, typeof body === 'string' ? body.slice(0, 200) : body);
        if (/execute_scenario/i.test(url)) { trackTicket(ticketMatch[1]); return; }
        try {
            const data = typeof body === 'string' ? JSON.parse(body) : (body || {});
            const status = data.status ?? data.ticket?.status ?? data.properties?.status;
            if (Number(status) === WAITING_STATUS_ID) trackTicket(ticketMatch[1]);
        } catch (_) {}
    }

    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
        const [input, options] = args;
        const url = typeof input === 'string' ? input : (input?.url || '');
        const method = (options?.method || 'GET').toUpperCase();
        if (['PUT', 'PATCH', 'POST'].includes(method)) {
            let body = options?.body;
            if (body instanceof ReadableStream) {
                const [a, b] = body.tee();
                options.body = b;
                body = await new Response(a).text();
            }
            checkBody(body, url, method);
        }
        return originalFetch.apply(this, args);
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this._schn_method = method?.toUpperCase();
        this._schn_url = typeof url === 'string' ? url : String(url);
        return originalOpen.apply(this, [method, url, ...rest]);
    };
    XMLHttpRequest.prototype.send = function (body) {
        if (['PUT', 'PATCH', 'POST'].includes(this._schn_method)) checkBody(body, this._schn_url, this._schn_method);
        return originalSend.apply(this, arguments);
    };

    function watchExecuteButton() {
        document.addEventListener('click', function(e) {
            const el = e.target.closest('button, [role="button"], li, a');
            if (!el) return;
            const text = el.textContent.trim();
            if (!/^execute$/i.test(text)) return;
            const ticketMatch = window.location.href.match(/\\/tickets\\/(\\d+)/);
            if (!ticketMatch) return;
            setTimeout(() => trackTicket(ticketMatch[1]), 500);
        }, true);
    }
    watchExecuteButton();
    console.log('[SCHN+ Tracker] v1.4 active — watching PUT/PATCH/POST on ticket URLs + Execute Scenario.');
})();`

function groupByDay(logs) {
  const groups = {}
  for (const log of logs) {
    const day = new Date(log.worked_at + 'Z').toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    })
    if (!groups[day]) groups[day] = []
    groups[day].push(log)
  }
  return groups
}

function formatTime(worked_at) {
  return new Date(worked_at + 'Z').toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
}

export default function Tracker() {
  const [apiKey, setApiKey] = useState(null)
  const [logs, setLogs] = useState([])
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [copied, setCopied] = useState(false)
  const [scriptCopied, setScriptCopied] = useState(false)
  const [expanded, setExpanded] = useState({})
  const [page, setPage] = useState(1)

  useEffect(() => {
    async function load() {
      setLoading(true)
      try {
        const [keyRes, logsRes] = await Promise.all([
          client.get('/users/me/api-key'),
          client.get('/ticket-tracker/'),
        ])
        setApiKey(keyRes.data.api_key)
        setLogs(logsRes.data)
      } catch {
        toast.error('Failed to load tracker data')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  const generateKey = async () => {
    setGenerating(true)
    try {
      const res = await client.post('/users/me/api-key')
      setApiKey(res.data.api_key)
      toast.success('API key generated')
    } catch {
      toast.error('Failed to generate API key')
    } finally {
      setGenerating(false)
    }
  }

  const fallbackCopy = (text, onSuccess) => {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.cssText = 'position:fixed;top:0;left:0;width:2px;height:2px;opacity:0;border:0;padding:0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    if (ok && onSuccess) onSuccess()
  }

  const copyToClipboard = (text, onSuccess) => {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(onSuccess).catch(() => fallbackCopy(text, onSuccess))
    } else {
      fallbackCopy(text, onSuccess)
    }
  }

  const copyKey = () => {
    if (!apiKey) return
    copyToClipboard(apiKey, () => { setCopied(true); setTimeout(() => setCopied(false), 2000) })
  }

  const copyScript = () => {
    copyToClipboard(TAMPERMONKEY_SCRIPT, () => { setScriptCopied(true); setTimeout(() => setScriptCopied(false), 2000) })
  }

  const downloadScript = () => {
    const blob = new Blob([TAMPERMONKEY_SCRIPT], { type: 'application/javascript' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'schn-case-tracker.user.js'
    a.click()
    URL.revokeObjectURL(url)
  }

  const deleteLog = async (id) => {
    try {
      await client.delete(`/ticket-tracker/${id}`)
      setLogs(prev => prev.filter(l => l.id !== id))
      toast.success('Ticket removed')
    } catch {
      toast.error('Failed to delete ticket')
    }
  }

  const toggleDay = (day) => setExpanded(prev => ({ ...prev, [day]: !prev[day] }))

  const grouped = groupByDay(logs)
  const days = Object.keys(grouped)
  const totalPages = Math.ceil(days.length / DAYS_PER_PAGE)
  const visibleDays = days.slice((page - 1) * DAYS_PER_PAGE, page * DAYS_PER_PAGE)

  return (
    <Layout>
      <div className="max-w-3xl mx-auto px-4 py-8">
        <div className="mb-6">
          <h2 className="text-2xl font-bold text-gray-800 dark:text-white">Ticket Tracker</h2>
          <p className="text-gray-600 dark:text-gray-400 mt-1">Tickets updated in Freshdesk, grouped by day and time.</p>
        </div>

        {/* API Key section */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-5 mb-6">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide mb-3">
            Tampermonkey API Key
          </h3>
          {loading ? (
            <div className="h-8 w-64 bg-gray-100 dark:bg-gray-700 rounded animate-pulse" />
          ) : apiKey ? (
            <div className="flex items-center gap-3">
              <code className="flex-1 bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-200 text-sm px-3 py-2 rounded font-mono truncate">
                {apiKey}
              </code>
              <button
                onClick={copyKey}
                className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors flex-shrink-0"
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
          ) : (
            <button
              onClick={generateKey}
              disabled={generating}
              className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {generating ? 'Generating...' : 'Generate API Key'}
            </button>
          )}
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
            Paste this key into your Tampermonkey script to activate the tracker.
          </p>
        </div>

        {/* Tampermonkey Script section */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-5 mb-6">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide">
                Tampermonkey Script
              </h3>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                v1.4 — Install this script in Tampermonkey to enable automatic ticket tracking.
              </p>
            </div>
            <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 font-medium">
              Latest
            </span>
          </div>

          <div className="bg-gray-50 dark:bg-gray-900 rounded-md border border-gray-200 dark:border-gray-700 p-3 mb-3 max-h-48 overflow-y-auto">
            <pre className="text-xs text-gray-700 dark:text-gray-300 font-mono whitespace-pre-wrap break-all leading-relaxed">
              {TAMPERMONKEY_SCRIPT}
            </pre>
          </div>

          <div className="flex gap-2">
            <button
              onClick={copyScript}
              className="flex-1 px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
            >
              {scriptCopied ? 'Copied!' : 'Copy Script'}
            </button>
            <button
              onClick={downloadScript}
              className="px-4 py-2 text-sm font-medium bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 rounded-md hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
            >
              Download .js
            </button>
          </div>

          <div className="mt-3 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-md border border-blue-100 dark:border-blue-800">
            <p className="text-xs text-blue-700 dark:text-blue-300 font-medium mb-1">How to install:</p>
            <ol className="text-xs text-blue-600 dark:text-blue-400 space-y-0.5 list-decimal list-inside">
              <li>Install the Tampermonkey extension in your browser</li>
              <li>Click "Download .js" or copy the script above</li>
              <li>Open Tampermonkey → Dashboard → New script, paste and save</li>
              <li>Go to any Freshdesk ticket, click Tampermonkey icon → "Set API Key"</li>
              <li>Paste your API key from the section above</li>
            </ol>
          </div>
        </div>

        {/* Logs */}
        {loading ? (
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-12 flex justify-center">
            <svg className="animate-spin h-8 w-8 text-blue-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
          </div>
        ) : logs.length === 0 ? (
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-12 text-center">
            <p className="text-gray-500 dark:text-gray-400">No tickets logged yet.</p>
            <p className="text-sm text-gray-400 dark:text-gray-500 mt-1">
              Install the Tampermonkey script and start updating tickets in Freshdesk.
            </p>
          </div>
        ) : (
          <>
            <div className="space-y-3">
              {visibleDays.map(day => {
                const dayLogs = grouped[day]
                const isOpen = !!expanded[day]
                return (
                  <div key={day} className="bg-white dark:bg-gray-800 rounded-lg shadow-md overflow-hidden">
                    <button
                      onClick={() => toggleDay(day)}
                      className="w-full px-5 py-3 bg-gray-50 dark:bg-gray-700 border-b border-gray-200 dark:border-gray-600 flex items-center justify-between hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors"
                    >
                      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 capitalize">
                        {day}{' '}
                        <span className="font-normal text-gray-400">
                          ({dayLogs.length} ticket{dayLogs.length !== 1 ? 's' : ''})
                        </span>
                      </h3>
                      <svg
                        className={`w-4 h-4 text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                        fill="none" stroke="currentColor" viewBox="0 0 24 24"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>
                    {isOpen && (
                      <div className="divide-y divide-gray-100 dark:divide-gray-700">
                        {dayLogs.map(log => (
                          <div key={log.id} className="px-5 py-3 flex items-center gap-4 group">
                            <span className="text-sm text-gray-400 dark:text-gray-500 flex-shrink-0 w-14 font-mono">
                              {formatTime(log.worked_at)}
                            </span>
                            <a
                              href={log.ticket_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-sm text-blue-600 dark:text-blue-400 hover:underline truncate flex-1"
                            >
                              {log.ticket_url}
                            </a>
                            <button
                              onClick={() => deleteLog(log.id)}
                              className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-all flex-shrink-0 p-1 rounded"
                              title="Delete"
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {totalPages > 1 && (
              <div className="mt-6 flex items-center justify-between">
                <p className="text-sm text-gray-500 dark:text-gray-400">Page {page} of {totalPages}</p>
                <div className="flex gap-2">
                  <button
                    onClick={() => { setPage(p => p - 1); setExpanded({}) }}
                    disabled={page === 1}
                    className="px-4 py-2 text-sm font-medium bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    Previous
                  </button>
                  <button
                    onClick={() => { setPage(p => p + 1); setExpanded({}) }}
                    disabled={page === totalPages}
                    className="px-4 py-2 text-sm font-medium bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Layout>
  )
}
