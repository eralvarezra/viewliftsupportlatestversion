import { useState, useCallback, useEffect, useRef } from 'react'
import Layout from '../components/Layout'
import client from '../api/client'
import toast from 'react-hot-toast'
import { usePlatform } from '../context/PlatformContext'
import { useCover } from '../context/CoverContext'

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result.split(',')[1])
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

export default function Generate() {
  const [customerMessage, setCustomerMessage] = useState('')
  const [screenshots, setScreenshots] = useState([]) // [{ base64, mediaType, previewUrl }]
  const [parsedInfo, setParsedInfo] = useState(null)
  const [generatedResponse, setGeneratedResponse] = useState('')
  const [nextSteps, setNextSteps] = useState(null)
  const [botNotes, setBotNotes] = useState(null)
  const [agentNotes, setAgentNotes] = useState("")
  const [inputMode, setInputMode] = useState('manual') // 'manual' | 'freshdesk'
  const [fdInput, setFdInput] = useState('')
  const [fdTicket, setFdTicket] = useState(null)
  const [fdLoading, setFdLoading] = useState(false)
  const [fdRateLimit, setFdRateLimit] = useState(() => {
    try { return JSON.parse(localStorage.getItem('fd_rate_limit') || 'null') } catch { return null }
  })
  const [rlCountdown, setRlCountdown] = useState(null)
  const rlTimerRef = useRef(null)
  const autoLoadedRef = useRef(false)
  const platformFromTicketRef = useRef(null)
  // Refs so loadFdTicket always reads the latest platforms/activePlatform,
  // even when called from a stale closure (postMessage handler, URL-param effect)
  const platformsRef = useRef([])
  const activePlatformRef = useRef(null)
  const [needsVerification, setNeedsVerification] = useState(false)
  const [faqSources, setFaqSources] = useState([])
  const [cannedSources, setCannedSources] = useState([])
  const [cacheHit, setCacheHit] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [isRegenerating, setIsRegenerating] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [fdEnabled, setFdEnabled] = useState(true)
  const [cmsInfo, setCmsInfo] = useState(null)
  const [cmsLoading, setCmsLoading] = useState(false)
  const [cmsAltEmails, setCmsAltEmails] = useState([])
  const [showPreview, setShowPreview] = useState(false)
  const [noteImages, setNoteImages] = useState([])
  const [isSending, setIsSending] = useState(false)

  const { activePlatform, platforms, setActivePlatform } = usePlatform()
  const { coverUserId, agents } = useCover()
  // Keep refs in sync so stale closures always read current values
  platformsRef.current = platforms
  activePlatformRef.current = activePlatform


  const CMS_PLATFORM_SITE = { 1: 'schn', 3: 'altitude' }

  const GROUP_TO_PLATFORM_ID = {
    43000666076: 1,   // SCHN Support -> SCHN+
    43000663021: 2,   // LIVGolf+ Support -> LIV Golf
    43000664192: 3,   // Altitude+ Support -> Altitude Sports
    43000663122: 4,   // MSN Support -> Monumental Sports
    43000663120: 4,   // LNP Support -> Monumental Sports
    43000665558: 5,   // Tampa Bay Lightning -> TBL
    43000663267: 6,   // FOX Support -> FOX One
    43000663123: 7,   // KnightTime+ -> Knight Time
    43000662781: 10,  // DIRTVision Support -> DIRTVision
  }

  const [trackerLogs, setTrackerLogs] = useState([])
  const [trackerStats, setTrackerStats] = useState({ today_count: 0, daily_goal: 35 })
  const [trackerPage, setTrackerPage] = useState(1)
  const TRACKER_PAGE_SIZE = 10

  useEffect(() => {
    client.get('/settings').then(r => {
      setFdEnabled(r.data?.freshdesk_on_generate !== 'false')
    }).catch(() => {})
  }, [])

  useEffect(() => {
    async function loadTracker() {
      try {
        const [logsRes, statsRes] = await Promise.all([
          client.get('/ticket-tracker/'),
          client.get('/ticket-tracker/stats'),
        ])
        setTrackerLogs(logsRes.data)
        setTrackerStats(statsRes.data)
      } catch { /* silently ignore */ }
    }
    loadTracker()
  }, [])

  const getTodayLogs = (logs) => {
    const today = new Date().toDateString()
    return logs.filter(l => new Date(l.worked_at + 'Z').toDateString() === today)
  }
  const formatTrackerTime = (worked_at) =>
    new Date(worked_at + 'Z').toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
  const getTicketId = (url) =>
    '#' + url.replace('https://viewlift.freshdesk.com/a/tickets/', '')

  useEffect(() => {
    // If this platform change was triggered by loadFdTicket, skip the destructive reset
    // so the just-loaded ticket data isn't wiped.
    if (platformFromTicketRef.current !== null) {
      platformFromTicketRef.current = null
      return
    }
    setCustomerMessage('')
    setScreenshots([])
    setParsedInfo(null)
    setGeneratedResponse('')
    setNextSteps(null)
    setBotNotes(null)
    setNeedsVerification(false)
    setCmsInfo(null)
    setFaqSources([])
    setCannedSources([])
    setScreenshots([])
  }, [activePlatform?.id])

  const processImageFile = useCallback(async (file) => {
    if (!file.type.startsWith('image/')) { toast.error('Only image files are supported'); return }
    if (file.size > 5 * 1024 * 1024) { toast.error('Image must be under 5MB'); return }
    const base64 = await fileToBase64(file)
    setScreenshots(prev => [...prev, { base64, mediaType: file.type, previewUrl: URL.createObjectURL(file) }])
  }, [])

  const handlePaste = useCallback((e) => {
    const item = Array.from(e.clipboardData.items).find(i => i.type.startsWith('image/'))
    if (item) { e.preventDefault(); processImageFile(item.getAsFile()) }
  }, [processImageFile])

  const handleDrop = useCallback((e) => {
    e.preventDefault(); setDragOver(false)
    Array.from(e.dataTransfer.files).forEach(file => processImageFile(file))
  }, [processImageFile])

  const handleAnalyzeAndGenerate = async () => {
    if (!customerMessage.trim()) {
      toast.error('Please enter the message content')
      return
    }

    setIsLoading(true)
    setParsedInfo(null)
    setGeneratedResponse('')
    setNextSteps(null)
    setBotNotes(null)
    setNeedsVerification(false)
    setFaqSources([])
    setCannedSources([])

    try {
      const response = await client.post('/generate', {
        message: customerMessage,
        platform_id: activePlatform.id,
        images: screenshots.length > 0 ? screenshots.map(s => ({ base64: s.base64, media_type: s.mediaType })) : null,
        agent_notes: agentNotes.trim() || null,
        cms_account: cmsInfo?.found ? cmsInfo : null,
        cms_not_found: cmsInfo !== null && !cmsInfo?.found && cmsAltEmails.length === 0,
        cms_no_subscription: !!(cmsInfo?.found && !cmsInfo?.is_subscribed),
      })

      setParsedInfo(response.data.parsed)
      setGeneratedResponse(response.data.response || '')
      setNextSteps(response.data.next_steps || null)
      setBotNotes(response.data.bot_notes || null)
      setNeedsVerification(response.data.needs_verification || false)
      setFaqSources(response.data.faq_sources || [])
      setCannedSources(response.data.canned_sources || [])

      if (response.data.needs_verification) {
        toast('CMS verification required — attach a screenshot to continue', { icon: '⚠️' })
      } else {
        toast.success('Response generated successfully')
      }
    } catch (error) {
      const message = error.response?.data?.detail || 'Failed to generate response. Please try again.'
      toast.error(message)
    } finally {
      setIsLoading(false)
    }
  }

  const handleRegenerate = async () => {
    if (!customerMessage.trim()) {
      toast.error('No message to regenerate from')
      return
    }

    setIsRegenerating(true)

    try {
      const response = await client.post('/generate', {
        message: customerMessage,
        platform_id: activePlatform.id,
        images: screenshots.length > 0 ? screenshots.map(s => ({ base64: s.base64, media_type: s.mediaType })) : null,
        agent_notes: agentNotes.trim() || null,
        cms_account: cmsInfo?.found ? cmsInfo : null,
        cms_not_found: cmsInfo !== null && !cmsInfo?.found && cmsAltEmails.length === 0,
        cms_no_subscription: !!(cmsInfo?.found && !cmsInfo?.is_subscribed),
      })

      setParsedInfo(response.data.parsed)
      setGeneratedResponse(response.data.response || '')
      setNextSteps(response.data.next_steps || null)
      setBotNotes(response.data.bot_notes || null)
      setNeedsVerification(response.data.needs_verification || false)
      setFaqSources(response.data.faq_sources || [])
      setCannedSources(response.data.canned_sources || [])

      if (response.data.needs_verification) {
        toast('CMS verification required — attach a screenshot to continue', { icon: '⚠️' })
      } else {
        toast.success('Response regenerated successfully')
      }
    } catch (error) {
      const message = error.response?.data?.detail || 'Failed to regenerate response. Please try again.'
      toast.error(message)
    } finally {
      setIsRegenerating(false)
    }
  }

  const handleCopy = () => {
    if (!generatedResponse) {
      toast.error('No response to copy')
      return
    }

    const tempDiv = document.createElement('div')
    tempDiv.innerHTML = generatedResponse
    const plainText = tempDiv.innerText || tempDiv.textContent || generatedResponse

    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(plainText)
        .then(() => toast.success('Response copied to clipboard'))
        .catch(() => fallbackCopy(plainText))
    } else {
      fallbackCopy(plainText)
    }
  }

  const fallbackCopy = (text) => {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.cssText = 'position:fixed;top:0;left:0;width:2px;height:2px;opacity:0;border:0;padding:0'
    document.body.appendChild(textarea)
    textarea.focus()
    textarea.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    if (ok) {
      toast.success('Response copied to clipboard')
    } else {
      toast.error('Failed to copy to clipboard')
    }
  }

  const updateRateLimit = (remaining, total) => {
    if (remaining == null) return
    const now = Date.now()
    setFdRateLimit(prev => {
      // If remaining went up or no resetAt yet, start a new 1-hour window
      const resetAt = (!prev || !prev.resetAt || remaining > (prev.remaining ?? 0))
        ? now + 3600 * 1000
        : prev.resetAt
      const next = { remaining, total: total || 5000, resetAt }
      localStorage.setItem('fd_rate_limit', JSON.stringify(next))
      return next
    })
  }

  useEffect(() => {
    if (rlTimerRef.current) clearInterval(rlTimerRef.current)
    if (!fdRateLimit?.resetAt) { setRlCountdown(null); return }
    const tick = () => {
      const diff = Math.max(0, Math.floor((fdRateLimit.resetAt - Date.now()) / 1000))
      setRlCountdown(diff)
      if (diff === 0) clearInterval(rlTimerRef.current)
    }
    tick()
    rlTimerRef.current = setInterval(tick, 1000)
    return () => clearInterval(rlTimerRef.current)
  }, [fdRateLimit])

  const loadFdTicket = async (overrideInput) => {
    const input = typeof overrideInput === 'string' ? overrideInput : fdInput
    const match = input.match(/\/tickets\/(\d+)/) || input.match(/^(\d+)$/)
    if (!match) { toast.error('Enter a valid ticket ID or URL'); return }
    const id = match[1]
    setFdLoading(true)
    // Clear stale state from previous ticket
    setCmsInfo(null)
    setCmsAltEmails([])
    setParsedInfo(null)
    setGeneratedResponse('')
    setNextSteps(null)
    setBotNotes(null)
    setNeedsVerification(false)
    try {
      const r = await client.get(`/freshdesk/ticket/${id}`)
      setFdTicket(r.data)
      setCustomerMessage(r.data.full_thread || r.data.description)
      // Resolve platform — priority: cf_b2b_client_name > group_id > tags
      const CLIENT_NAME_TO_PLATFORM_ID = {
        'schn+': 1, 'altitude': 3, 'dirtvision': 10, 'fox one': 6,
        'livgolf': 2, 'liv golf': 2, 'msn': 4, 'monumental': 4,
        'tbl': 5, 'lightning': 5, 'knight': 7,
      }
      const TAG_TO_PLATFORM_ID = {
        fox: 6, livgolf: 2, altitude: 3, monumental: 4, msn: 4, lnp: 4,
        tbl: 5, lightning: 5, schn: 1, dirtvision: 10, dirt: 10, knight: 7,
      }
      let resolvedPlatformId = null
      const clientNameRaw = r.data.client_name || ''
      if (clientNameRaw) {
        const cnl = clientNameRaw.toLowerCase()
        for (const [key, pid] of Object.entries(CLIENT_NAME_TO_PLATFORM_ID)) {
          if (cnl.includes(key)) { resolvedPlatformId = pid; break }
        }
      }
      if (!resolvedPlatformId) resolvedPlatformId = GROUP_TO_PLATFORM_ID[r.data.group_id]
      if (!resolvedPlatformId && r.data.tags?.length) {
        for (const tag of r.data.tags) {
          const tl = tag.toLowerCase().replace(/[-_ ]/g, '')
          for (const [key, pid] of Object.entries(TAG_TO_PLATFORM_ID)) {
            if (tl.includes(key)) { resolvedPlatformId = pid; break }
          }
          if (resolvedPlatformId) break
        }
      }
      if (resolvedPlatformId) {
        const targetPlatform = platformsRef.current.find(p => p.id === resolvedPlatformId)
        if (targetPlatform && targetPlatform.id !== activePlatformRef.current?.id) {
          platformFromTicketRef.current = targetPlatform.id
          setActivePlatform(targetPlatform)
          toast.success('Switched to ' + targetPlatform.name)
        }
      }
      updateRateLimit(r.data.rate_limit_remaining, r.data.rate_limit_total)
      const pId = resolvedPlatformId ?? activePlatformRef.current?.id
      const cmsSite = CMS_PLATFORM_SITE[pId]
      if (cmsSite && r.data.requester_email) {
        setCmsLoading(true)
        const requesterEmail = r.data.requester_email.toLowerCase()
        client.get(`/cms/lookup?email=${encodeURIComponent(r.data.requester_email)}&site=${cmsSite}`)
          .then(cr => {
            setCmsInfo(cr.data)
            if (!cr.data.found || (cr.data.found && !cr.data.is_subscribed)) {
              const thread = r.data.full_thread || r.data.description || ''
              const found = [...new Set(
                (thread.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || [])
                  .map(e => e.toLowerCase())
                  .filter(e => e !== requesterEmail)
              )]
              setCmsAltEmails(found)
            }
          })
          .catch(() => {})
          .finally(() => setCmsLoading(false))
      }
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to load ticket')
    } finally {
      setFdLoading(false)
    }
  }

  useEffect(() => {
    const handle = (event) => {
      if (event.data?.type === 'schn-load-ticket' && event.data?.url) {
        setInputMode('freshdesk')
        setFdInput(event.data.url)
        loadFdTicket(event.data.url)
      }
    }
    window.addEventListener('message', handle)
    if (!autoLoadedRef.current) {
      const params = new URLSearchParams(window.location.search)
      const ticketParam = params.get('ticket')
      if (ticketParam) {
        autoLoadedRef.current = true
        setInputMode('freshdesk')
        setFdInput(ticketParam)
        loadFdTicket(ticketParam)
      }
    }
    return () => window.removeEventListener('message', handle)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const searchCmsWithEmail = (email, site) => {
    const s = site || CMS_PLATFORM_SITE[activePlatform?.id] || 'schn'
    setCmsLoading(true)
    setCmsAltEmails([])
    client.get(`/cms/lookup?email=${encodeURIComponent(email)}&site=${s}`)
      .then(cr => {
        setCmsInfo(cr.data)
        if (!cr.data.found) {
          toast('No CMS account found for ' + email, { icon: '🔍' })
        }
      })
      .catch(() => toast.error('CMS lookup failed'))
      .finally(() => setCmsLoading(false))
  }

  const buildCmsNote = (info) => {
    if (!info || !info.found) return ''
    const lines = []
    if (info.plan_name || info.plan) lines.push(`Plan Name: ${info.plan_name || info.plan}`)
    if (info.price)                  lines.push(`Price: ${info.price}`)
    if (info.subscription_status)    lines.push(`Status: ${info.subscription_status}`)
    if (info.country)                lines.push(`Country: ${info.country}`)
    if (info.receipt_id)             lines.push(`Receipt ID: ${info.receipt_id}`)
    if (info.payment_unique_id)      lines.push(`Payment Unique ID: ${info.payment_unique_id}`)
    if (info.transaction_id && info.transaction_id !== info.receipt_id) lines.push(`Transaction ID: ${info.transaction_id}`)
    if (info.payment_handler)        lines.push(`Payment Handler: ${info.payment_handler}`)
    if (info.registered_on)          lines.push(`Registered On: ${info.registered_on}`)
    if (info.end_date)               lines.push(`End Date: ${info.end_date}`)
    return lines.join('\n')
  }

  const handleSendReply = async () => {
    if (!fdTicket?.id || !generatedResponse) return
    setIsSending(true)
    try {
      await client.post(`/freshdesk/ticket/${fdTicket.id}/reply`, { body: generatedResponse, ...(coverUserId ? { cover_user_id: coverUserId } : {}) })
      const cmsNote = cmsInfo?.found ? buildCmsNote(cmsInfo) : null
      const hasNoteContent = cmsNote || noteImages.length > 0
      if (hasNoteContent) {
        await client.post(`/freshdesk/ticket/${fdTicket.id}/note`, {
          body: cmsNote || 'Agent screenshots',
          images: noteImages.length > 0 ? noteImages.map(s => ({ base64: s.base64, media_type: s.mediaType })) : null,
          ...(coverUserId ? { cover_user_id: coverUserId } : {}),
        })
      }
      // Status update is non-blocking — include ticket type to satisfy Freshdesk field validation
      try {
        const statusPayload = { status: 12 }
        if (fdTicket?.type) statusPayload.type = fdTicket.type
        await client.put(`/freshdesk/ticket/${fdTicket.id}/status`, statusPayload)
      } catch (statusErr) {
        console.warn('Status update skipped:', statusErr?.response?.data || statusErr.message)
      }
      // Log reply to tracker
      try { await client.post('/ticket-tracker/log-reply', { ticket_url: 'https://viewlift.freshdesk.com/a/tickets/' + fdTicket.id, ...(coverUserId ? { cover_user_id: coverUserId } : {}) }) } catch (_) {}
      toast.success('Reply sent — status set to Waiting for End User')
      setShowPreview(false)
      setNoteImages([])
      handleClear(true)
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to send reply')
    } finally {
      setIsSending(false)
    }
  }

  const handleNoAccountDirect = async () => {
    if (!fdTicket?.id) return
    setIsLoading(true)
    try {
      const res = await client.get('/canned-responses/by-title/B2C No account associated with email')
      let html = res.data.content_html || res.data.content || ''
      // Fix space-only separators to proper line breaks
      html = html.replace(/ {5,}/g, '\n\n').replace(/ {3,4}/g, '\n')

      const email = fdTicket?.requester_email || ''
      const fullName = fdTicket?.requester_name || ''
      const firstName = fullName.split(' ')[0] || fullName || 'there'
      html = html.replaceAll('{{ticket.requester.email}}', email)
      html = html.replaceAll('{{ticket.requester.name}}', fullName)
      html = html.replaceAll('{{requester.name}}', fullName)

      const greeting = `<p>Hello ${firstName},</p><p><br></p><p>Thank you for contacting the <strong>Technical Support Team</strong>.</p><p><br></p>`
      const signature = `<p><br></p><p><strong>Regards,<br>The Technical Support Team</strong></p>`
      html = greeting + html + signature

      setGeneratedResponse(html)
      setCannedSources([{ title: res.data.title, similarity: 1.0 }])
      setShowPreview(true)
    } catch (err) {
      toast.error('Failed to load B2C No Account response')
    } finally {
      setIsLoading(false)
    }
  }

  const handleNoSubDirect = async () => {
    if (!fdTicket?.id) return
    setIsLoading(true)
    try {
      const res = await client.get('/canned-responses/by-title/B2C No Subscription')
      let html = res.data.content_html || res.data.content || ''
      // Fix space-only separators to proper line breaks
      html = html.replace(/ {5,}/g, '\n\n').replace(/ {3,4}/g, '\n')

      // Replace Freshdesk template variables
      const email = fdTicket?.requester_email || ''
      const fullName = fdTicket?.requester_name || ''
      const firstName = fullName.split(' ')[0] || fullName || 'there'
      html = html.replaceAll('{{ticket.requester.email}}', email)
      html = html.replaceAll('{{ticket.requester.name}}', fullName)
      html = html.replaceAll('{{requester.name}}', fullName)

      // Wrap with greeting and signature
      const greeting = `<p>Hello ${firstName},</p><p><br></p><p>Thank you for contacting the <strong>Technical Support Team</strong>.</p><p><br></p>`
      const signature = `<p><br></p><p><strong>Regards,<br>The Technical Support Team</strong></p>`
      html = greeting + html + signature

      setGeneratedResponse(html)
      setCannedSources([{ title: res.data.title, similarity: 1.0 }])
      setShowPreview(true)
    } catch (err) {
      toast.error('Failed to load B2C No Subscription response')
    } finally {
      setIsLoading(false)
    }
  }

  const handleClear = (silent = false) => {
    setAgentNotes("")
    setFdTicket(null)
    setFdInput("")
    setCustomerMessage('')
    setScreenshots([])
    setParsedInfo(null)
    setGeneratedResponse('')
    setNextSteps(null)
    setBotNotes(null)
    setNeedsVerification(false)
    setCmsInfo(null)
    setCmsAltEmails([])
    setFaqSources([])
    setCannedSources([])
    setScreenshots([])
    if (!silent) toast.success('Cleared successfully')
  }

  return (
    <>
    <Layout>
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-800 dark:text-white">Generate Response</h2>
        <p className="text-gray-600 mt-1">
          Paste the full content including customer message, email thread, and account notes
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Panel - Input */}
        <div className="space-y-4">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-6">
            {/* Freshdesk Rate Limit widget */}
            {fdEnabled && fdRateLimit && fdRateLimit.remaining != null && (
              <div className="mb-4 p-3 rounded-lg bg-gray-50 dark:bg-gray-700/50 border border-gray-200 dark:border-gray-600">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-medium text-gray-600 dark:text-gray-300">Freshdesk API Calls</span>
                  <span className={`text-xs font-bold ${fdRateLimit.remaining < 500 ? 'text-red-500' : fdRateLimit.remaining < 1500 ? 'text-yellow-500' : 'text-green-600 dark:text-green-400'}`}>
                    {fdRateLimit.remaining.toLocaleString()} / {fdRateLimit.total.toLocaleString()}
                  </span>
                </div>
                <div className="w-full bg-gray-200 dark:bg-gray-600 rounded-full h-1.5 mb-1.5">
                  <div
                    className={`h-1.5 rounded-full transition-all ${fdRateLimit.remaining < 500 ? 'bg-red-500' : fdRateLimit.remaining < 1500 ? 'bg-yellow-400' : 'bg-green-500'}`}
                    style={{ width: (fdRateLimit.remaining / fdRateLimit.total * 100) + '%' }}
                  />
                </div>
                {rlCountdown != null && rlCountdown > 0 && (
                  <p className="text-xs text-gray-400 dark:text-gray-500">
                    Resets in {Math.floor(rlCountdown / 60)}m {rlCountdown % 60}s
                  </p>
                )}
                {rlCountdown === 0 && (
                  <p className="text-xs text-green-500">Rate limit reset</p>
                )}
              </div>
            )}

            {/* Mode tabs */}
            <div className="flex items-center justify-between mb-4">
              {fdEnabled ? (
                <div className="flex rounded-lg border border-gray-200 dark:border-gray-600 overflow-hidden text-xs font-medium">
                  <button
                    onClick={() => setInputMode('manual')}
                    className={`px-3 py-1.5 transition-colors ${inputMode === 'manual' ? 'bg-blue-600 text-white' : 'text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-700'}`}
                  >
                    Manual
                  </button>
                  <button
                    onClick={() => setInputMode('freshdesk')}
                    className={`px-3 py-1.5 transition-colors border-l border-gray-200 dark:border-gray-600 ${inputMode === 'freshdesk' ? 'bg-blue-600 text-white' : 'text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-700'}`}
                  >
                    Freshdesk Ticket
                  </button>
                </div>
              ) : (
                <span className="text-xs font-medium text-gray-400 dark:text-gray-500">Manual input</span>
              )}
              <button onClick={handleClear} className="text-sm text-gray-500 hover:text-gray-700 transition-colors">Clear</button>
            </div>

            {/* Freshdesk ticket loader */}
            {inputMode === 'freshdesk' && (
              <div className="mb-4 space-y-3">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={fdInput}
                    onChange={e => setFdInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && loadFdTicket()}
                    placeholder="Ticket ID or URL (e.g. 333954)"
                    className="flex-1 px-3 py-2 text-sm border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <button
                    onClick={loadFdTicket}
                    disabled={fdLoading || !fdInput.trim()}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
                  >
                    {fdLoading ? 'Loading...' : 'Load'}
                  </button>
                </div>
                {fdTicket && (
                  <div className="rounded-lg border border-blue-200 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/20 p-3 text-xs space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-blue-800 dark:text-blue-300">#{fdTicket.id}</span>
                      <span className="font-semibold text-gray-800 dark:text-white">{fdTicket.subject}</span>
                      <span className="px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-800 text-blue-700 dark:text-blue-300">{fdTicket.status}</span>
                    </div>
                    {fdTicket.requester_name && <p className="text-gray-500 dark:text-gray-400">From: {fdTicket.requester_name} {fdTicket.requester_email ? `(${fdTicket.requester_email})` : ''}</p>}
                    {fdTicket.company && <p className="text-gray-500 dark:text-gray-400">Company: {fdTicket.company}</p>}
                    {fdTicket.tags?.length > 0 && <p className="text-gray-500 dark:text-gray-400">Tags: {fdTicket.tags.join(', ')}</p>}
                    <p className="text-gray-500 dark:text-gray-400">{fdTicket.conversation_count || 0} replies in thread</p>
                    <a href={fdTicket.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline">Open in Freshdesk ↗</a>
                    {cmsLoading && (
                      <p className="text-gray-400 dark:text-gray-500 italic">Looking up CMS account...</p>
                    )}
                    {!cmsLoading && cmsInfo && cmsInfo.found && (
                      <div className="mt-2 pt-2 border-t border-blue-200 dark:border-blue-700 space-y-1">
                        {/* Header: name + badge + Open CMS button */}
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <p className="font-medium text-gray-700 dark:text-gray-300">
                            CMS: {cmsInfo.name || cmsInfo.email}
                            {cmsInfo.is_subscribed
                              ? <span className="ml-2 px-1.5 py-0.5 rounded bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400">Active subscriber</span>
                              : <span className="ml-2 px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400">Not subscribed</span>
                            }
                          </p>
                          <a
                            href={`https://cms-gcp.viewlift.com/users/search/${cmsInfo.user_id || ''}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white rounded-md transition-colors"
                          >
                            Open in CMS ↗
                          </a>
                        </div>
                        {/* Quick-copy fields */}
                        {cmsInfo.email && (
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs text-gray-400 dark:text-gray-500 w-14 shrink-0">Email:</span>
                            <span className="text-xs text-gray-600 dark:text-gray-300 font-mono truncate">{cmsInfo.email}</span>
                            <button
                              onClick={() => {
                              const el = document.createElement('textarea'); el.value = cmsInfo.email;
                              el.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(el);
                              el.select(); document.execCommand('copy'); document.body.removeChild(el);
                            }}
                              className="shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
                              title="Copy email"
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                              </svg>
                            </button>
                          </div>
                        )}
                        {cmsInfo.user_id && (
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs text-gray-400 dark:text-gray-500 w-14 shrink-0">User ID:</span>
                            <span className="text-xs text-gray-600 dark:text-gray-300 font-mono truncate">{cmsInfo.user_id}</span>
                            <button
                              onClick={() => {
                              const el = document.createElement('textarea'); el.value = cmsInfo.user_id;
                              el.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(el);
                              el.select(); document.execCommand('copy'); document.body.removeChild(el);
                            }}
                              className="shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
                              title="Copy user ID"
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                              </svg>
                            </button>
                          </div>
                        )}
                        {cmsInfo.plan && <p className="text-gray-500 dark:text-gray-400 text-xs">Plan: {cmsInfo.plan}{cmsInfo.subscription_status ? ` (${cmsInfo.subscription_status})` : ''}</p>}
                        {cmsInfo.payment_handler && <p className="text-gray-500 dark:text-gray-400 text-xs">Payment: {cmsInfo.payment_handler}</p>}
                        {cmsInfo.last_login && <p className="text-gray-500 dark:text-gray-400 text-xs">Last login: {cmsInfo.last_login}</p>}
                        {cmsInfo.device_count > 0 && <p className="text-gray-500 dark:text-gray-400 text-xs">Devices: {cmsInfo.device_count}</p>}
                        {!cmsInfo.is_subscribed && cmsAltEmails.length > 0 && (
                          <div className="mt-2 pt-2 border-t border-gray-200 dark:border-gray-600 space-y-1">
                            <p className="text-xs text-gray-500 dark:text-gray-400 font-medium">Try alternative email from thread:</p>
                            {cmsAltEmails.map(email => (
                              <button
                                key={email}
                                onClick={() => searchCmsWithEmail(email)}
                                className="flex items-center gap-1.5 w-full text-left px-2 py-1 text-xs text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700 rounded hover:bg-blue-100 dark:hover:bg-blue-900/40 transition-colors"
                              >
                                <span>🔍</span>
                                <span className="font-mono truncate">{email}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                    {!cmsLoading && cmsInfo && !cmsInfo.found && (
                      <div className="mt-1 space-y-1.5">
                        <p className="text-xs text-gray-400 dark:text-gray-500 italic">No CMS account found for {fdTicket?.requester_email}</p>
                        {cmsAltEmails.length > 0 && (
                          <div className="space-y-1">
                            <p className="text-xs text-gray-500 dark:text-gray-400 font-medium">Emails found in thread:</p>
                            {cmsAltEmails.map(email => (
                              <button
                                key={email}
                                onClick={() => searchCmsWithEmail(email)}
                                className="flex items-center gap-1.5 w-full text-left px-2 py-1 text-xs text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700 rounded hover:bg-blue-100 dark:hover:bg-blue-900/40 transition-colors"
                              >
                                <span>🔍</span>
                                <span className="font-mono truncate">{email}</span>
                              </button>
                            ))}
                          </div>
                        )}
                        {parsedInfo?.customer_email && parsedInfo.customer_email.toLowerCase() !== fdTicket?.requester_email?.toLowerCase() && !cmsAltEmails.includes(parsedInfo.customer_email.toLowerCase()) && (
                          <button
                            onClick={() => searchCmsWithEmail(parsedInfo.customer_email)}
                            className="flex items-center gap-1.5 w-full text-left px-2 py-1 text-xs text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-700 rounded hover:bg-purple-100 dark:hover:bg-purple-900/40 transition-colors"
                          >
                            <span>✦</span>
                            <span>Try AI-detected email: <span className="font-mono">{parsedInfo.customer_email}</span></span>
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            <textarea
              value={customerMessage}
              onChange={(e) => setCustomerMessage(e.target.value)}
              onPaste={handlePaste}
              placeholder={`Paste everything here, for example:

[Latest customer message]
I can't access my account, it says my subscription expired.

[Email thread - if any]
From: customer@email.com
Subject: Can't login
...previous messages...

[Account notes - if available]
CMS account found for customer@email.com
status: active
subscription: COMPLETED
end_of_access: 2026-05-18`}
              disabled={isLoading}
              rows={16}
              className="w-full px-4 py-3 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm placeholder-gray-400 dark:placeholder-gray-500 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100 dark:disabled:bg-gray-600 disabled:cursor-not-allowed resize-none font-mono text-sm"
            />

            {/* Agent Notes */}
            <div className="mt-3">
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                Agent Notes <span className="text-gray-400 font-normal">(optional — instructions for the bot)</span>
              </label>
              <textarea
                value={agentNotes}
                onChange={(e) => setAgentNotes(e.target.value)}
                placeholder="e.g. Customer already tried reinstalling. Offer refund only if subscription is expired."
                disabled={isLoading}
                rows={3}
                className="w-full px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-md shadow-sm placeholder-gray-400 dark:placeholder-gray-500 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100 dark:disabled:bg-gray-600 disabled:cursor-not-allowed resize-none text-sm"
              />
            </div>

            {/* Screenshot area */}
            <div className="mt-4 space-y-2">
              {/* Thumbnails grid */}
              {screenshots.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {screenshots.map((s, i) => (
                    <div key={i} className="relative group w-20 h-20 rounded-lg overflow-hidden border border-blue-200 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/20 flex-shrink-0">
                      <img src={s.previewUrl} alt={`Screenshot ${i + 1}`} className="w-full h-full object-cover" />
                      <button
                        onClick={() => setScreenshots(prev => prev.filter((_, idx) => idx !== i))}
                        className="absolute top-0.5 right-0.5 w-5 h-5 flex items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80 text-xs transition-colors opacity-0 group-hover:opacity-100"
                        title="Remove"
                      >✕</button>
                    </div>
                  ))}
                </div>
              )}
              {/* Drop zone */}
              <div
                onDrop={handleDrop}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                className={`flex items-center justify-center border-2 border-dashed rounded-lg py-3 cursor-pointer transition-colors ${
                  needsVerification && screenshots.length === 0 && !cmsInfo?.found && cmsAltEmails.length > 0
                    ? 'border-amber-400 bg-amber-50 dark:bg-amber-900/20 hover:border-amber-500'
                    : dragOver
                      ? 'border-blue-400 bg-blue-50 dark:bg-blue-900/20'
                      : 'border-gray-200 dark:border-gray-600 hover:border-gray-300 dark:hover:border-gray-500'
                }`}
                onClick={() => document.getElementById('screenshot-input').click()}
              >
                <input
                  id="screenshot-input"
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(e) => Array.from(e.target.files).forEach(f => processImageFile(f))}
                />
                <p className={`text-xs select-none ${needsVerification && screenshots.length === 0 && !cmsInfo?.found && cmsAltEmails.length > 0 ? 'text-amber-600 dark:text-amber-400 font-medium' : 'text-gray-400 dark:text-gray-500'}`}>
                  {needsVerification && screenshots.length === 0 && !cmsInfo?.found && cmsAltEmails.length > 0
                    ? '📎 Upload CMS screenshot here to proceed'
                    : screenshots.length > 0
                      ? <span>📷 Add more — paste, drag & drop, or <span className="text-blue-500">click</span></span>
                      : <span>📷 Attach screenshots — paste, drag & drop, or <span className="text-blue-500">click</span> (optional)</span>
                  }
                </p>
              </div>
            </div>

            <div className="mt-4 flex justify-end">
              <button
                onClick={handleAnalyzeAndGenerate}
                disabled={isLoading || !customerMessage.trim() || !activePlatform || (needsVerification && screenshots.length === 0 && !cmsInfo?.found && cmsAltEmails.length > 0)}
                className="px-6 py-2 bg-blue-600 text-white font-medium rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:bg-blue-400 disabled:cursor-not-allowed transition-colors"
              >
                {isLoading ? (
                  <span className="flex items-center">
                    <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    Analyzing...
                  </span>
                ) : needsVerification ? (
                  'Generate Final Response'
                ) : (
                  'Analyze and Generate'
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Right Panel - Output */}
        <div className="space-y-6">
          {/* Parsed Information */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-6">
            <h3 className="text-lg font-semibold text-gray-800 dark:text-white mb-4">Parsed Information</h3>

            {parsedInfo ? (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-gray-50 dark:bg-gray-700/60 rounded-md px-3 py-2">
                    <label className="block text-xs font-semibold text-gray-400 dark:text-gray-400 uppercase tracking-wide">Customer Name</label>
                    <p className="mt-0.5 text-sm text-gray-900 dark:text-gray-100 font-medium">{parsedInfo.customer_name || 'Not detected'}</p>
                  </div>
                  <div className="bg-gray-50 dark:bg-gray-700/60 rounded-md px-3 py-2">
                    <label className="block text-xs font-semibold text-gray-400 dark:text-gray-400 uppercase tracking-wide">Email</label>
                    <p className="mt-0.5 text-sm text-gray-900 dark:text-gray-100 font-medium truncate">{parsedInfo.customer_email || 'Not detected'}</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-gray-50 dark:bg-gray-700/60 rounded-md px-3 py-2">
                    <label className="block text-xs font-semibold text-gray-400 dark:text-gray-400 uppercase tracking-wide">Device</label>
                    <p className="mt-0.5 text-sm text-gray-900 dark:text-gray-100 font-medium">{parsedInfo.device || 'Not detected'}</p>
                  </div>
                  <div className="bg-gray-50 dark:bg-gray-700/60 rounded-md px-3 py-2">
                    <label className="block text-xs font-semibold text-gray-400 dark:text-gray-400 uppercase tracking-wide">Account Number</label>
                    <p className="mt-0.5 text-sm text-gray-900 dark:text-gray-100 font-medium">{parsedInfo.account_number || 'Not detected'}</p>
                 </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-gray-50 dark:bg-gray-700/60 rounded-md px-3 py-2">
                    <label className="block text-xs font-semibold text-gray-400 dark:text-gray-400 uppercase tracking-wide">Ticket Type</label>
                    <p className="mt-0.5 text-sm font-medium capitalize">
                      {parsedInfo.ticket_type === 'billing' && <span className="text-amber-600 dark:text-amber-400">{parsedInfo.ticket_type}</span>}
                      {parsedInfo.ticket_type === 'technical' && <span className="text-blue-600 dark:text-blue-400">{parsedInfo.ticket_type}</span>}
                      {!parsedInfo.ticket_type && <span className="text-gray-400 dark:text-gray-500 italic">Not detected</span>}
                    </p>
                  </div>
                  <div className="bg-gray-50 dark:bg-gray-700/60 rounded-md px-3 py-2">
                    <label className="block text-xs font-semibold text-gray-400 dark:text-gray-400 uppercase tracking-wide">Payment Handler</label>
                    <p className="mt-0.5 text-sm text-gray-900 dark:text-gray-100 font-medium">{parsedInfo.payment_handler || 'Not detected'}</p>
                  </div>
                </div>
                <div className="bg-gray-50 dark:bg-gray-700/60 rounded-md px-3 py-2">
                  <label className="block text-xs font-semibold text-gray-400 dark:text-gray-400 uppercase tracking-wide">Problem Summary</label>
                  <p className="mt-0.5 text-sm text-gray-900 dark:text-gray-100">{parsedInfo.problem_summary || 'Not detected'}</p>
                </div>
                <div className="bg-gray-50 dark:bg-gray-700/60 rounded-md px-3 py-2">
                  <label className="block text-xs font-semibold text-gray-400 dark:text-gray-400 uppercase tracking-wide">Context</label>
                  <p className="mt-0.5 text-sm text-gray-700 dark:text-gray-300">{parsedInfo.context || 'Not detected'}</p>
                </div>
              </div>
            ) : (
              <div className="text-gray-400 dark:text-gray-500 text-center py-8">
                <p>Parsed information will appear here</p>
              </div>
            )}
          </div>

          {/* B2C No Account — shown when CMS lookup found nothing */}
          {(() => {
            if (!cmsInfo || cmsInfo.found || cmsAltEmails.length > 0 || !fdTicket?.id) return null
            const noAcctAlreadySent = customerMessage.toLowerCase().includes('do not see an account associated with')
            return (
              <div className="bg-orange-50 dark:bg-orange-900/20 border border-orange-300 dark:border-orange-600 rounded-lg p-4 space-y-2">
                {noAcctAlreadySent ? (
                  <div className="flex items-center gap-2">
                    <span className="text-base shrink-0">ℹ️</span>
                    <p className="text-sm text-orange-800 dark:text-orange-300 font-medium">
                      B2C No Account was already sent in this thread
                    </p>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-base shrink-0">ℹ️</span>
                      <p className="text-sm text-orange-800 dark:text-orange-300 font-medium">No CMS account found</p>
                    </div>
                    <button
                      onClick={handleNoAccountDirect}
                      disabled={isLoading}
                      className="shrink-0 px-4 py-2 bg-orange-600 hover:bg-orange-700 disabled:bg-orange-400 text-white text-sm font-semibold rounded-md transition-colors whitespace-nowrap"
                    >
                      {isLoading ? 'Loading...' : '✉ Send B2C No Account'}
                    </button>
                  </div>
                )}
              </div>
            )
          })()}

          {/* B2C No Subscription — email-aware: only suppress button if sent for this exact email */}
          {(() => {
            if (!cmsInfo?.found || cmsInfo?.is_subscribed || !fdTicket?.id) return null
            const msgLower = customerMessage.toLowerCase()
            const noSubMatch = msgLower.match(/unable to locate an active subscription associated with the email address\s+([\w._%+\-]+@[\w.\-]+\.[a-z]{2,})/i)
            const noSubSentEmail = noSubMatch ? noSubMatch[1].toLowerCase() : null
            const currentEmail = (cmsInfo?.email || '').toLowerCase()
            const sentForThisEmail = noSubSentEmail && currentEmail && noSubSentEmail === currentEmail
            const sentForOtherEmail = noSubSentEmail && currentEmail && noSubSentEmail !== currentEmail
            return (
              <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-300 dark:border-blue-600 rounded-lg p-4 space-y-2">
                {sentForThisEmail ? (
                  <div className="flex items-center gap-2">
                    <span className="text-base shrink-0">ℹ️</span>
                    <p className="text-sm text-blue-800 dark:text-blue-300 font-medium">
                      B2C No Subscription was already sent for <span className="font-mono">{noSubSentEmail}</span>
                    </p>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-base shrink-0">ℹ️</span>
                      <div>
                        <p className="text-sm text-blue-800 dark:text-blue-300 font-medium">Account found — no active subscription</p>
                        {sentForOtherEmail && (
                          <p className="text-xs text-blue-600 dark:text-blue-400 mt-0.5">Previously sent for <span className="font-mono">{noSubSentEmail}</span></p>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={handleNoSubDirect}
                      disabled={isLoading}
                      className="shrink-0 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white text-sm font-semibold rounded-md transition-colors whitespace-nowrap"
                    >
                      {isLoading ? 'Loading...' : '✉ Send B2C No Subscription'}
                    </button>
                  </div>
                )}
              </div>
            )
          })()}

          {/* CMS Verification Banner */}
          {needsVerification && screenshots.length === 0 && !cmsInfo?.found && cmsAltEmails.length > 0 && (
            <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-300 dark:border-amber-600 rounded-lg p-5">
              <div className="flex items-start gap-3 mb-3">
                <span className="text-2xl">⚠️</span>
                <div>
                  <h4 className="font-semibold text-amber-800 dark:text-amber-300 text-base">CMS Verification Required</h4>
                  <p className="text-amber-700 dark:text-amber-400 text-sm mt-0.5">
                    Please upload a screenshot of the customer's account in CMS before proceeding.
                  </p>
                </div>
              </div>
              {nextSteps && (
                <div className="bg-amber-100 dark:bg-amber-900/40 rounded-md p-3 mb-3">
                  <pre className="text-xs text-amber-900 dark:text-amber-200 whitespace-pre-wrap font-sans">{nextSteps}</pre>
                </div>
              )}
              <button
                onClick={() => document.getElementById('screenshot-input').click()}
                className="w-full py-2 px-4 bg-amber-500 hover:bg-amber-600 text-white font-medium rounded-md transition-colors text-sm"
              >
                📎 Upload CMS Screenshot
              </button>
            </div>
          )}

          {/* Generated Response */}
          {(!needsVerification || screenshots.length > 0 || cmsInfo?.found || cmsAltEmails.length === 0) && (
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-6">
              <div className="flex justify-between items-center mb-4">
                <div className="flex items-center gap-2">
                  <h3 className="text-lg font-semibold text-gray-800 dark:text-white">
                    {nextSteps && generatedResponse ? '✉️ Customer Response' : 'Generated Response'}
                  </h3>
                  {generatedResponse && (
                    cacheHit ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                        ⚡ Cached
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400">
                        Fresh
                      </span>
                    )
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleRegenerate}
                    disabled={isRegenerating || !parsedInfo}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-500 dark:text-gray-400 bg-transparent border border-gray-200 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    {isRegenerating ? (
                      <>
                        <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                        </svg>
                        Regenerating…
                      </>
                    ) : (
                      <>↺ Regenerate</>
                    )}
                  </button>
                  <button
                    onClick={handleCopy}
                    disabled={!generatedResponse}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    ⎘ Copy
                  </button>
                  {fdTicket?.id && (
                    <button
                      onClick={() => setShowPreview(true)}
                      disabled={!generatedResponse}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-sm"
                    >
                      ✉ Send Reply
                    </button>
                  )}
                </div>
              </div>

              {generatedResponse ? (
                <div className="bg-gray-50 dark:bg-gray-700 rounded-md p-4 max-h-64 overflow-y-auto">
                  <div className="text-gray-800 dark:text-gray-100 whitespace-pre-wrap prose prose-sm dark:prose-invert" dangerouslySetInnerHTML={{ __html: generatedResponse }} />
                </div>
              ) : (
                <div className="text-gray-400 text-center py-8">
                  <p>Generated response will appear here</p>
                </div>
              )}
            </div>
          )}


          {/* Next Steps Panel (internal only — shown after full billing response) */}
          {nextSteps && (!needsVerification || cmsInfo?.found || cmsAltEmails.length === 0) && (
            <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-300 dark:border-amber-600 rounded-lg p-5">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-lg">📋</span>
                <h4 className="font-semibold text-amber-800 dark:text-amber-300">Next Steps</h4>
                <span className="ml-auto text-xs text-amber-600 dark:text-amber-400 bg-amber-100 dark:bg-amber-900/40 px-2 py-0.5 rounded-full font-medium">
                  Internal only
                </span>
              </div>
              <pre className="text-sm text-amber-900 dark:text-amber-200 whitespace-pre-wrap font-sans leading-relaxed">{nextSteps}</pre>
            </div>
          )}

          {/* Bot Notes Panel (internal) */}
          {botNotes && (
            <div className="bg-gray-50 dark:bg-gray-700/50 border border-gray-200 dark:border-gray-600 rounded-lg p-5">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-lg">🤖</span>
                <h4 className="font-semibold text-gray-700 dark:text-gray-300">Bot Notes</h4>
                <span className="ml-auto text-xs text-gray-500 dark:text-gray-400 bg-gray-200 dark:bg-gray-600 px-2 py-0.5 rounded-full font-medium">
                  Internal only
                </span>
              </div>
              <pre className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap font-sans leading-relaxed">{botNotes}</pre>
            </div>
          )}

          {/* Canned Responses Used */}
          {cannedSources.length > 0 && (
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-6">
              <h3 className="text-lg font-semibold text-gray-800 dark:text-white mb-4 flex items-center gap-2">
                <span className="inline-block w-2 h-2 rounded-full bg-indigo-500"></span>
                Canned Response Used
              </h3>
              <div className="space-y-2">
                {cannedSources.map((source, index) => (
                  <div key={index} className="flex items-center justify-between bg-indigo-50 dark:bg-indigo-900/30 border border-indigo-100 dark:border-indigo-800 rounded-lg px-4 py-2.5">
                    <span className="text-sm font-medium text-indigo-800 dark:text-indigo-300">{source.title}</span>
                    <span className="text-xs text-indigo-500 dark:text-indigo-400 ml-3 flex-shrink-0">{(source.similarity * 100).toFixed(1)}% match</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* FAQ Sources Used */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-6">
            <h3 className="text-lg font-semibold text-gray-800 dark:text-white mb-4">FAQ Sources Used</h3>
            {faqSources.length > 0 ? (
              <div className="space-y-3">
                {faqSources.map((source, index) => (
                  <div key={index} className="bg-blue-50 rounded-md p-3">
                    <div className="flex justify-between items-start mb-1">
                      <span className="text-xs font-medium text-blue-600">Chunk #{source.chunk_id}</span>
                      <span className="text-xs text-gray-500">Relevance: {(source.similarity * 100).toFixed(1)}%</span>
                    </div>
                    <p className="text-sm text-gray-700">{source.content_preview}</p>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-gray-400 text-center py-4">
                <p>No FAQ sources used for this response</p>
              </div>
            )}
          </div>
        </div>

        {/* Tracker Today - Column 3 */}
        <div>
          {(() => {
            const todayLogs = getTodayLogs(trackerLogs)
            const totalPages = Math.max(1, Math.ceil(todayLogs.length / TRACKER_PAGE_SIZE))
            const currentPage = Math.min(trackerPage, totalPages)
            const pageLogs = todayLogs.slice((currentPage - 1) * TRACKER_PAGE_SIZE, currentPage * TRACKER_PAGE_SIZE)
            return (
              <div className="sticky top-4 bg-white dark:bg-gray-800 rounded-lg shadow-md overflow-hidden flex flex-col" style={{ maxHeight: 'calc(100vh - 6rem)' }}>
                <div className="px-3 py-3 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
                  <h3 className="text-xs font-semibold text-gray-600 dark:text-gray-300 uppercase tracking-wide">Tracker Today</h3>
                  <div className="flex items-baseline gap-2 mt-1">
                    <p className="text-xl font-bold text-blue-600 dark:text-blue-400 leading-none">
                      {todayLogs.length}<span className="text-xs font-normal text-gray-400 ml-1">tickets</span>
                    </p>
                    <span className="text-xs text-gray-400">/ {trackerStats.daily_goal} goal</span>
                  </div>
                </div>
                <div className="overflow-y-auto flex-1 divide-y divide-gray-100 dark:divide-gray-700">
                  {todayLogs.length === 0 ? (
                    <p className="text-xs text-gray-400 text-center py-6 px-3">No tickets today</p>
                  ) : pageLogs.map(log => (
                    <div key={log.id} className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors group">
                      <span className="text-xs text-gray-400 font-mono flex-shrink-0 w-11">{formatTrackerTime(log.worked_at)}</span>
                      <a href={log.ticket_url} target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline truncate flex-1">
                        {getTicketId(log.ticket_url)}
                      </a>
                      <button
                        onClick={() => client.delete(`/ticket-tracker/${log.id}`).then(() => setTrackerLogs(prev => prev.filter(l => l.id !== log.id))).catch(() => {})}
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
                {totalPages > 1 && (
                  <div className="flex items-center justify-between px-3 py-2 border-t border-gray-200 dark:border-gray-700 flex-shrink-0">
                    <button onClick={() => setTrackerPage(p => Math.max(1, p - 1))} disabled={currentPage === 1} className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 disabled:opacity-30 disabled:cursor-not-allowed px-1">‹ Prev</button>
                    <span className="text-xs text-gray-400">{currentPage} / {totalPages}</span>
                    <button onClick={() => setTrackerPage(p => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages} className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 disabled:opacity-30 disabled:cursor-not-allowed px-1">Next ›</button>
                  </div>
                )}
              </div>
            )
          })()}
        </div>
      </div>
    </Layout>

      {/* Preview & Send Reply Modal */}
      {showPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700">
              <h3 className="text-lg font-semibold text-gray-800 dark:text-white">Preview Reply</h3>
              <button onClick={() => setShowPreview(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-xl leading-none">&times;</button>
            </div>
            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              <div>
                <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">Reply to customer (ticket #{fdTicket?.id})</p>
                <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-4 text-sm text-gray-800 dark:text-gray-100 whitespace-pre-wrap prose prose-sm dark:prose-invert" dangerouslySetInnerHTML={{ __html: generatedResponse }} />
              </div>
              {screenshots.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
                    Attach to agent notes ({noteImages.length} selected)
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {screenshots.map((s, i) => {
                      const selected = noteImages.includes(s)
                      return (
                        <button
                          key={i}
                          type="button"
                          onClick={() => setNoteImages(prev => selected ? prev.filter(x => x !== s) : [...prev, s])}
                          className={`relative rounded border-2 transition-all ${selected ? 'border-blue-500 ring-2 ring-blue-300' : 'border-gray-200 dark:border-gray-600 opacity-50'}`}
                        >
                          <img src={s.previewUrl} alt={`Screenshot ${i+1}`} className="h-16 w-auto object-cover rounded" />
                          {selected && <span className="absolute top-0.5 right-0.5 bg-blue-500 text-white text-xs rounded-full w-4 h-4 flex items-center justify-center">✓</span>}
                        </button>
                      )
                    })}
                  </div>
                  <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">Click to select screenshots to attach to Freshdesk private notes</p>
                </div>
              )}
              {cmsInfo?.found && buildCmsNote(cmsInfo) && (
                <div>
                  <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">Private note (CMS account data)</p>
                  <pre className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-700 rounded-lg p-4 text-xs text-gray-700 dark:text-gray-300 whitespace-pre-wrap font-mono">{buildCmsNote(cmsInfo)}</pre>
                </div>
              )}
            </div>
            <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-200 dark:border-gray-700">
              <button onClick={() => setShowPreview(false)} className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200">Cancel</button>
              <button
                onClick={handleSendReply}
                disabled={isSending}
                className="px-6 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg transition-colors flex items-center gap-2"
              >
                {isSending ? (
                  <>
                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                    </svg>
                    Sending...
                  </>
                ) : 'Send Reply'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
