import { useState, useEffect } from 'react'
import Layout from '../components/Layout'
import client from '../api/client'
import toast from 'react-hot-toast'

export default function Profile() {
  const [fdKey, setFdKey] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [profile, setProfile] = useState(null)

  const [newUsername, setNewUsername] = useState('')
  const [savingUsername, setSavingUsername] = useState(false)

  // CMS credentials (per-user)
  const [cmsCreds, setCmsCreds] = useState(null)
  const [cmsCredsUsername, setCmsCredsUsername] = useState('')
  const [cmsCredsPassword, setCmsCredsPassword] = useState('')
  const [cmsSavingCreds, setCmsSavingCreds] = useState(false)
  const [cmsShowCredForm, setCmsShowCredForm] = useState(false)

  // CMS token state
  const [cmsStatus, setCmsStatus] = useState(null)
  const [cmsRefreshing, setCmsRefreshing] = useState(false)
  const [cmsNeedsOtp, setCmsNeedsOtp] = useState(false)
  const [cmsOtpMobile, setCmsOtpMobile] = useState('')
  const [cmsOtp, setCmsOtp] = useState('')
  const [cmsVerifying, setCmsVerifying] = useState(false)

  // Altitude CMS credentials
  const [altCmsCreds, setAltCmsCreds] = useState(null)
  const [altCmsCredsUsername, setAltCmsCredsUsername] = useState('')
  const [altCmsCredsPassword, setAltCmsCredsPassword] = useState('')
  const [altCmsSavingCreds, setAltCmsSavingCreds] = useState(false)
  const [altCmsShowCredForm, setAltCmsShowCredForm] = useState(false)

  // Altitude CMS token state
  const [altCmsStatus, setAltCmsStatus] = useState(null)
  const [altCmsRefreshing, setAltCmsRefreshing] = useState(false)
  const [altCmsNeedsOtp, setAltCmsNeedsOtp] = useState(false)
  const [altCmsOtpMobile, setAltCmsOtpMobile] = useState('')
  const [altCmsOtp, setAltCmsOtp] = useState('')
  const [altCmsVerifying, setAltCmsVerifying] = useState(false)

  useEffect(() => {
    client.get('/users/me')
      .then(r => {
        setProfile(r.data)
        setFdKey(r.data.freshdesk_api_key || '')
        setNewUsername(r.data.username || '')
      })
      .catch(() => toast.error('Failed to load profile'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (profile?.role === 'admin' || profile?.is_superadmin) {
      client.get('/cms/token/status').then(r => setCmsStatus(r.data)).catch(() => {})
      client.get('/cms/credentials/status').then(r => setCmsCreds(r.data)).catch(() => {})
      client.get('/cms/token/status?site=altitude').then(r => setAltCmsStatus(r.data)).catch(() => {})
      client.get('/cms/credentials/status?site=altitude').then(r => setAltCmsCreds(r.data)).catch(() => {})
    }
  }, [profile])

  const saveFd = async () => {
    setSaving(true)
    try {
      await client.put('/users/me/freshdesk-key', { freshdesk_api_key: fdKey })
      toast.success('Settings saved')
    } catch {
      toast.error('Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const saveUsername = async () => {
    if (newUsername.trim() === profile?.username) return
    setSavingUsername(true)
    try {
      const r = await client.put('/users/me/username', { username: newUsername.trim() })
      setProfile(prev => ({ ...prev, username: r.data.username }))
      localStorage.setItem('username', r.data.username)
      toast.success('Username updated')
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to update username')
    } finally {
      setSavingUsername(false)
    }
  }

  const handleSaveCmsCreds = async () => {
    if (!cmsCredsUsername.trim() || !cmsCredsPassword.trim()) {
      toast.error('Enter both username and password')
      return
    }
    setCmsSavingCreds(true)
    try {
      await client.post('/cms/credentials', {
        username: cmsCredsUsername.trim(),
        password: cmsCredsPassword,
      })
      const r = await client.get('/cms/credentials/status')
      setCmsCreds(r.data)
      setCmsCredsPassword('')
      setCmsShowCredForm(false)
      toast.success('CMS credentials saved')
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to save credentials')
    } finally {
      setCmsSavingCreds(false)
    }
  }

  const handleDeleteCmsCreds = async () => {
    try {
      await client.delete('/cms/credentials')
      setCmsCreds({ configured: false })
      toast('CMS credentials removed')
    } catch {
      toast.error('Failed to remove credentials')
    }
  }

  const handleCmsRefresh = async () => {
    setCmsRefreshing(true)
    setCmsNeedsOtp(false)
    setCmsOtp('')
    try {
      const r = await client.post('/cms/token/refresh')
      if (r.data.needs_otp) {
        setCmsNeedsOtp(true)
        setCmsOtpMobile(r.data.obscure_mobile || '')
        toast('OTP sent to your phone ending in ' + (r.data.obscure_mobile || '????'), { icon: '📱' })
      } else if (r.data.ok) {
        toast.success('CMS token refreshed successfully!')
        const s = await client.get('/cms/token/status')
        setCmsStatus(s.data)
      } else {
        toast.error(r.data.message || 'Refresh failed')
      }
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Refresh failed')
    } finally {
      setCmsRefreshing(false)
    }
  }

  const handleCmsOtpVerify = async () => {
    if (!cmsOtp.trim()) return
    setCmsVerifying(true)
    try {
      await client.post('/cms/token/verify-otp', { otp: cmsOtp.trim() })
      toast.success('CMS token refreshed successfully!')
      setCmsNeedsOtp(false)
      setCmsOtp('')
      const s = await client.get('/cms/token/status')
      setCmsStatus(s.data)
    } catch (err) {
      toast.error(err.response?.data?.detail || 'OTP verification failed')
    } finally {
      setCmsVerifying(false)
    }
  }

  const handleSaveAltCmsCreds = async () => {
    if (!altCmsCredsUsername.trim() || !altCmsCredsPassword.trim()) { toast.error('Enter both username and password'); return }
    setAltCmsSavingCreds(true)
    try {
      await client.post('/cms/credentials?site=altitude', { username: altCmsCredsUsername.trim(), password: altCmsCredsPassword })
      const r = await client.get('/cms/credentials/status?site=altitude')
      setAltCmsCreds(r.data)
      setAltCmsCredsPassword('')
      setAltCmsShowCredForm(false)
      toast.success('Altitude CMS credentials saved')
    } catch (err) { toast.error(err.response?.data?.detail || 'Failed to save credentials') }
    finally { setAltCmsSavingCreds(false) }
  }

  const handleDeleteAltCmsCreds = async () => {
    try {
      await client.delete('/cms/credentials?site=altitude')
      setAltCmsCreds({ configured: false })
      toast('Altitude CMS credentials removed')
    } catch { toast.error('Failed to remove credentials') }
  }

  const handleAltCmsRefresh = async () => {
    setAltCmsRefreshing(true); setAltCmsNeedsOtp(false); setAltCmsOtp('')
    try {
      const r = await client.post('/cms/token/refresh?site=altitude')
      if (r.data.needs_otp) {
        setAltCmsNeedsOtp(true); setAltCmsOtpMobile(r.data.obscure_mobile || '')
        toast('OTP sent to phone ending in ' + (r.data.obscure_mobile || '????'), { icon: '📱' })
      } else if (r.data.ok) {
        toast.success('Altitude CMS token refreshed!')
        const s = await client.get('/cms/token/status?site=altitude')
        setAltCmsStatus(s.data)
      } else { toast.error(r.data.message || 'Refresh failed') }
    } catch (err) { toast.error(err.response?.data?.detail || 'Refresh failed') }
    finally { setAltCmsRefreshing(false) }
  }

  const handleAltCmsOtpVerify = async () => {
    if (!altCmsOtp.trim()) return
    setAltCmsVerifying(true)
    try {
      await client.post('/cms/token/verify-otp?site=altitude', { otp: altCmsOtp.trim() })
      toast.success('Altitude CMS token refreshed!')
      setAltCmsNeedsOtp(false); setAltCmsOtp('')
      const s = await client.get('/cms/token/status?site=altitude')
      setAltCmsStatus(s.data)
    } catch (err) { toast.error(err.response?.data?.detail || 'OTP verification failed') }
    finally { setAltCmsVerifying(false) }
  }

  const cmsMinutes = cmsStatus?.minutes_remaining
  const cmsExpired = cmsStatus?.status === 'expired'
  const cmsValid = cmsStatus?.status === 'valid'

  const TAMPERMONKEY_SCRIPT = `// ==UserScript==
// @name         Freshdesk – Reply with Bot
// @namespace    https://schn.support/
// @version      1.4
// @description  Adds "Reply with Bot" button next to the Activities button in Freshdesk
// @match        https://viewlift.freshdesk.com/a/tickets/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict'

  const BOT_BASE = 'http://135.181.37.72:3001'
  const BOT_WINDOW_NAME = 'schn-bot-window'

  function getTicketUrl() {
    return window.location.href
  }

  function sendToBot(ticketUrl) {
    const probe = window.open('', BOT_WINDOW_NAME)

    let hasContent = false
    if (probe && !probe.closed) {
      try {
        hasContent = probe.location.href !== 'about:blank' && probe.location.href !== ''
      } catch (e) {
        hasContent = true // SecurityError = bot is loaded cross-origin
      }
    }

    if (hasContent && probe) {
      probe.postMessage({ type: 'schn-load-ticket', url: ticketUrl }, BOT_BASE)
      probe.focus()
    } else {
      window.open(
        \`\${BOT_BASE}/generate?ticket=\${encodeURIComponent(ticketUrl)}\`,
        BOT_WINDOW_NAME
      )
    }
  }

  function createBotButton(referenceEl) {
    const btn = document.createElement('button')
    btn.id = 'schn-reply-with-bot'
    btn.textContent = '🤖 Reply with Bot'

    // Match the computed font/size of the Activities button so it blends in
    const ref = referenceEl ? window.getComputedStyle(referenceEl) : null
    const fontSize = ref ? ref.fontSize : '13px'
    const color = ref ? ref.color : '#1f2937'

    btn.style.cssText = [
      'display:inline-flex',
      'align-items:center',
      'gap:5px',
      'margin-left:8px',
      'padding:5px 12px',
      'background:#4f6bed',
      'color:#fff',
      'border:none',
      'border-radius:4px',
      \`font-size:\${fontSize}\`,
      'font-weight:600',
      'cursor:pointer',
      'white-space:nowrap',
      'vertical-align:middle',
      'line-height:1',
    ].join(';')

    btn.addEventListener('mouseenter', () => { btn.style.background = '#3a55d6' })
    btn.addEventListener('mouseleave', () => { btn.style.background = '#4f6bed' })
    btn.addEventListener('click', () => sendToBot(getTicketUrl()))

    return btn
  }

  function findActivitiesButton() {
    // Try specific Freshdesk selectors first
    const candidates = [
      document.querySelector('[data-test-id="activities-button"]'),
      document.querySelector('[data-key="activities"]'),
      ...[...document.querySelectorAll('button, [role="button"], a, span')]
        .filter(el => el.textContent.trim() === 'Activities'),
    ]
    return candidates.find(Boolean) || null
  }

  function inject() {
    if (document.getElementById('schn-reply-with-bot')) return

    const activitiesBtn = findActivitiesButton()
    if (!activitiesBtn) return

    const botBtn = createBotButton(activitiesBtn)
    activitiesBtn.parentNode.insertBefore(botBtn, activitiesBtn.nextSibling)
  }

  // Remove stale button when navigating to a different ticket
  let lastTicketId = null

  function onUrlChange() {
    const match = window.location.pathname.match(/\\/tickets\\/(\\d+)/)
    const currentId = match ? match[1] : null
    if (currentId !== lastTicketId) {
      lastTicketId = currentId
      const old = document.getElementById('schn-reply-with-bot')
      if (old) old.remove()
    }
  }

  // Watch for SPA navigation
  const _push = history.pushState.bind(history)
  history.pushState = function (...args) {
    _push(...args)
    onUrlChange()
    setTimeout(inject, 1500)
  }

  window.addEventListener('popstate', () => {
    onUrlChange()
    setTimeout(inject, 1500)
  })

  // Watch for DOM changes (Freshdesk lazy-loads the toolbar)
  const observer = new MutationObserver(() => inject())
  observer.observe(document.body, { childList: true, subtree: true })

  setTimeout(inject, 2000)
  setTimeout(inject, 4000)
})()
`

  if (loading) return <Layout><div className="p-8 text-gray-400">Loading...</div></Layout>

  const isAdmin = profile?.role === 'admin' || profile?.is_superadmin

  return (
    <Layout>
      <div className="max-w-xl mx-auto py-10 px-4 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-800 dark:text-white">Settings</h1>
          <p className="text-sm text-gray-500 mt-1">Manage your account preferences</p>
        </div>

        {/* Profile info */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-5 space-y-4">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide">Account</h2>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Username</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={newUsername}
                onChange={e => setNewUsername(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && saveUsername()}
                className="flex-1 px-3 py-2 text-sm border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                onClick={saveUsername}
                disabled={savingUsername || newUsername.trim() === profile?.username || !newUsername.trim()}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-colors"
              >
                {savingUsername ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>

          <div className="space-y-1">
            <p className="text-sm text-gray-700 dark:text-gray-300"><span className="font-medium">Email:</span> {profile?.email}</p>
            <p className="text-sm text-gray-700 dark:text-gray-300"><span className="font-medium">Role:</span> {profile?.role}</p>
          </div>
        </div>

        {/* Freshdesk API Key */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-5 space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide mb-1">Freshdesk API Key</h2>
            <p className="text-xs text-gray-400 dark:text-gray-500">
              Your personal Freshdesk API key. Used for loading tickets and the Daily Update tracker detection.
              Find it in Freshdesk → Profile Settings → API Key.
            </p>
          </div>
          <div className="flex gap-2">
            <input
              type="password"
              value={fdKey}
              onChange={e => setFdKey(e.target.value)}
              placeholder="Enter your Freshdesk API key"
              className="flex-1 px-3 py-2 text-sm border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              onClick={saveFd}
              disabled={saving}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
          {fdKey ? (
            <p className="text-xs text-green-600 dark:text-green-400">✓ API key configured</p>
          ) : (
            <p className="text-xs text-yellow-600 dark:text-yellow-400">⚠ No personal key set — using shared key (shared quota with all agents)</p>
          )}
        </div>

        {/* CMS Credentials + Token (admin only) */}
        {isAdmin && (
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-5 space-y-5">
            <div>
              <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide mb-1">
                ViewLift CMS (SCHN+)
              </h2>
              <p className="text-xs text-gray-400 dark:text-gray-500">
                Your personal CMS credentials are used to refresh the shared access token.
                The 2FA code will be sent to the phone number linked to your CMS account.
              </p>
            </div>

            {/* Credentials section */}
            <div className="space-y-3">
              {cmsCreds?.configured ? (
                <div className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg border border-gray-200 dark:border-gray-600">
                  <div>
                    <p className="text-xs font-medium text-gray-500 dark:text-gray-400">CMS account</p>
                    <p className="text-sm text-gray-800 dark:text-white font-mono">
                      {cmsCreds.username}
                      {cmsCreds.from_env && (
                        <span className="ml-2 text-xs text-gray-400">(shared / env)</span>
                      )}
                    </p>
                  </div>
                  {!cmsCreds.from_env && (
                    <div className="flex gap-2">
                      <button
                        onClick={() => { setCmsCredsUsername(cmsCreds.username); setCmsShowCredForm(true) }}
                        className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                      >
                        Change
                      </button>
                      <button
                        onClick={handleDeleteCmsCreds}
                        className="text-xs text-red-500 hover:underline"
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="p-3 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg border border-yellow-200 dark:border-yellow-700">
                  <p className="text-xs text-yellow-800 dark:text-yellow-300">
                    No CMS credentials configured. Add your ViewLift CMS account to enable token refresh with your own 2FA.
                  </p>
                </div>
              )}

              {/* Credential form */}
              {(cmsShowCredForm || !cmsCreds?.configured) && (
                <div className="space-y-2 p-3 bg-gray-50 dark:bg-gray-700/40 rounded-lg border border-gray-200 dark:border-gray-600">
                  <input
                    type="email"
                    value={cmsCredsUsername}
                    onChange={e => setCmsCredsUsername(e.target.value)}
                    placeholder="ViewLift CMS email"
                    className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <input
                    type="password"
                    value={cmsCredsPassword}
                    onChange={e => setCmsCredsPassword(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleSaveCmsCreds()}
                    placeholder="Password"
                    className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={handleSaveCmsCreds}
                      disabled={cmsSavingCreds || !cmsCredsUsername.trim() || !cmsCredsPassword.trim()}
                      className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-colors"
                    >
                      {cmsSavingCreds ? 'Saving…' : 'Save credentials'}
                    </button>
                    {cmsShowCredForm && (
                      <button
                        onClick={() => { setCmsShowCredForm(false); setCmsCredsPassword('') }}
                        className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Divider */}
            <div className="border-t border-gray-100 dark:border-gray-700" />

            {/* Token status */}
            <div className="space-y-3">
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Shared token status</p>

              {cmsStatus && (
                <div className="flex items-center gap-2">
                  {cmsValid && (
                    <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-full ${
                      cmsMinutes < 60
                        ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
                        : 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                    }`}>
                      {cmsMinutes < 60 ? '⚠' : '✓'} Valid — expires in {cmsMinutes < 60 ? `${cmsMinutes}m` : `${Math.floor(cmsMinutes / 60)}h ${cmsMinutes % 60}m`}
                    </span>
                  )}
                  {cmsExpired && (
                    <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-full bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
                      ✕ Expired
                    </span>
                  )}
                  {cmsStatus.status === 'not_set' && (
                    <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-full bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400">
                      — Not set
                    </span>
                  )}
                </div>
              )}

              {/* OTP step */}
              {cmsNeedsOtp && (
                <div className="space-y-3 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-700">
                  <p className="text-sm text-blue-800 dark:text-blue-300">
                    📱 Enter the OTP sent to your phone ending in <strong>{cmsOtpMobile || '????'}</strong>
                  </p>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={cmsOtp}
                      onChange={e => setCmsOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      onKeyDown={e => e.key === 'Enter' && handleCmsOtpVerify()}
                      placeholder="6-digit code"
                      maxLength={6}
                      className="flex-1 px-3 py-2 text-sm border border-blue-300 dark:border-blue-600 rounded-lg bg-white dark:bg-gray-700 text-gray-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 tracking-widest font-mono"
                    />
                    <button
                      onClick={handleCmsOtpVerify}
                      disabled={cmsVerifying || cmsOtp.length < 6}
                      className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-colors"
                    >
                      {cmsVerifying ? 'Verifying…' : 'Verify'}
                    </button>
                  </div>
                </div>
              )}

              <button
                onClick={handleCmsRefresh}
                disabled={cmsRefreshing || !cmsCreds?.configured}
                title={!cmsCreds?.configured ? 'Configure CMS credentials first' : ''}
                className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
              >
                {cmsRefreshing ? (
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                  </svg>
                ) : '↻'}
                {cmsRefreshing ? 'Refreshing…' : 'Refresh CMS Token'}
              </button>
            </div>
          </div>
        )}

        {/* Altitude CMS Credentials + Token (admin only) */}
        {isAdmin && (
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-5 space-y-5">
            <div>
              <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide mb-1">
                ViewLift CMS (Altitude Sports)
              </h2>
              <p className="text-xs text-gray-400 dark:text-gray-500">
                Credentials for the Altitude Sports CMS. Used to refresh the shared Altitude access token.
              </p>
            </div>

            <div className="space-y-3">
              {altCmsCreds?.configured ? (
                <div className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg border border-gray-200 dark:border-gray-600">
                  <div>
                    <p className="text-xs font-medium text-gray-500 dark:text-gray-400">CMS account</p>
                    <p className="text-sm text-gray-800 dark:text-white font-mono">
                      {altCmsCreds.username}
                      {altCmsCreds.from_env && <span className="ml-2 text-xs text-gray-400">(shared / env)</span>}
                    </p>
                  </div>
                  {!altCmsCreds.from_env && (
                    <div className="flex gap-2">
                      <button onClick={() => { setAltCmsCredsUsername(altCmsCreds.username); setAltCmsShowCredForm(true) }} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">Change</button>
                      <button onClick={handleDeleteAltCmsCreds} className="text-xs text-red-500 hover:underline">Remove</button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="p-3 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg border border-yellow-200 dark:border-yellow-700">
                  <p className="text-xs text-yellow-800 dark:text-yellow-300">No Altitude CMS credentials configured.</p>
                </div>
              )}

              {(altCmsShowCredForm || !altCmsCreds?.configured) && (
                <div className="space-y-2 p-3 bg-gray-50 dark:bg-gray-700/40 rounded-lg border border-gray-200 dark:border-gray-600">
                  <input type="email" value={altCmsCredsUsername} onChange={e => setAltCmsCredsUsername(e.target.value)} placeholder="Altitude CMS email" className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  <input type="password" value={altCmsCredsPassword} onChange={e => setAltCmsCredsPassword(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSaveAltCmsCreds()} placeholder="Password" className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  <div className="flex gap-2">
                    <button onClick={handleSaveAltCmsCreds} disabled={altCmsSavingCreds || !altCmsCredsUsername.trim() || !altCmsCredsPassword.trim()} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-colors">{altCmsSavingCreds ? 'Saving…' : 'Save credentials'}</button>
                    {altCmsShowCredForm && <button onClick={() => { setAltCmsShowCredForm(false); setAltCmsCredsPassword('') }} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">Cancel</button>}
                  </div>
                </div>
              )}
            </div>

            <div className="border-t border-gray-100 dark:border-gray-700" />

            <div className="space-y-3">
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Shared token status</p>
              {altCmsStatus && (
                <div className="flex items-center gap-2">
                  {altCmsStatus.status === 'valid' && (() => {
                    const mins = altCmsStatus.minutes_remaining
                    return (
                      <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-full ${mins < 60 ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400' : 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'}`}>
                        {mins < 60 ? '⚠' : '✓'} Valid — expires in {mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`}
                      </span>
                    )
                  })()}
                  {altCmsStatus.status === 'expired' && <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-full bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">✕ Expired</span>}
                  {altCmsStatus.status === 'not_set' && <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-full bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400">— Not set</span>}
                </div>
              )}

              {altCmsNeedsOtp && (
                <div className="space-y-3 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-700">
                  <p className="text-sm text-blue-800 dark:text-blue-300">📱 Enter the OTP sent to your phone ending in <strong>{altCmsOtpMobile || '????'}</strong></p>
                  <div className="flex gap-2">
                    <input type="text" value={altCmsOtp} onChange={e => setAltCmsOtp(e.target.value.replace(/\D/g, '').slice(0, 6))} onKeyDown={e => e.key === 'Enter' && handleAltCmsOtpVerify()} placeholder="6-digit code" maxLength={6} className="flex-1 px-3 py-2 text-sm border border-blue-300 dark:border-blue-600 rounded-lg bg-white dark:bg-gray-700 text-gray-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 tracking-widest font-mono" />
                    <button onClick={handleAltCmsOtpVerify} disabled={altCmsVerifying || altCmsOtp.length < 6} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-colors">{altCmsVerifying ? 'Verifying…' : 'Verify'}</button>
                  </div>
                </div>
              )}

              <button onClick={handleAltCmsRefresh} disabled={altCmsRefreshing || !altCmsCreds?.configured} title={!altCmsCreds?.configured ? 'Configure Altitude CMS credentials first' : ''} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors">
                {altCmsRefreshing ? (<svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg>) : '↻'}
                {altCmsRefreshing ? 'Refreshing…' : 'Refresh CMS Token'}
              </button>
            </div>
          </div>
        )}

        {/* Tampermonkey Script */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-5 space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide mb-1">Freshdesk Browser Script</h2>
            <p className="text-xs text-gray-400 dark:text-gray-500">
              Instala este script en Tampermonkey para agregar el botón <strong>&quot;Reply with Bot&quot;</strong> debajo del botón Update en cada ticket de Freshdesk.
            </p>
          </div>
          <div className="relative">
            <pre className="text-xs bg-gray-950 text-green-300 rounded-lg p-4 overflow-x-auto overflow-y-auto max-h-64 leading-relaxed font-mono whitespace-pre select-all border border-gray-700">{TAMPERMONKEY_SCRIPT}</pre>
            <button
              onClick={() => {
                const el = document.createElement('textarea')
                el.value = TAMPERMONKEY_SCRIPT
                el.style.cssText = 'position:fixed;opacity:0'
                document.body.appendChild(el)
                el.select()
                document.execCommand('copy')
                document.body.removeChild(el)
                toast.success('Script copiado!')
              }}
              className="absolute top-3 right-3 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-xs font-medium rounded-md transition-colors"
            >
              Copy
            </button>
          </div>
          <ol className="text-xs text-gray-500 dark:text-gray-400 space-y-1 list-decimal list-inside">
            <li>Abre Tampermonkey → Dashboard → <strong>+</strong> (New Script)</li>
            <li>Borra el contenido y pega el script copiado</li>
            <li>Guarda con <kbd className="px-1 py-0.5 bg-gray-100 dark:bg-gray-700 rounded text-xs">Ctrl+S</kbd></li>
            <li>Abre cualquier ticket en Freshdesk — el botón aparece bajo <em>Update</em></li>
          </ol>
        </div>
      </div>
    </Layout>
  )
}
