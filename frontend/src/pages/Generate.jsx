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


const SUPPORT_PREFIXES = [
  'support','techsupport','helpdesk','help','info','admin','noreply',
  'no-reply','contact','team','service','ticket','feedback','care',
  'customercare','customersupport','customerservice','billing',
  'dvsupport','appsupport','donotreply','notifications','mailer',
]
// Always return a STRING from an API error — FastAPI 422s put an array of
// objects in `detail`, and rendering that directly crashes React (error #31).
function apiErr(err, fallback) {
  const d = err?.response?.data?.detail
  if (typeof d === 'string') return d
  if (Array.isArray(d)) return d.map(x => (x && x.msg) ? x.msg : JSON.stringify(x)).join('; ')
  if (d && typeof d === 'object') return d.msg || JSON.stringify(d)
  return fallback
}

// Whole domains treated as support aliases — any address here triggers the
// "update contact to the real customer" flow (same as dvsupport@dirtvision.com).
const SUPPORT_DOMAINS = ['livgolf.com']
// Replying to these domains is never allowed (internal LIV staff, not customers).
// The contact must be changed to the real customer first.
function isBlockedRecipientDomain(email) {
  if (!email) return false
  const domain = (email.split('@')[1] || '').toLowerCase()
  return SUPPORT_DOMAINS.includes(domain)
}
// Domains owned by the platforms/company — a customer never has an address here.
// Any thread email at these domains is internal (support inboxes, staff, no-reply).
const PLATFORM_DOMAINS = [
  'livgolf.com', 'livgolfplus.com', 'spacecityhn.com', 'monumentalsports.com',
  'monumentalsportsnetwork.com', 'viewlift.com', 'dirtvision.com',
  'altitudeplus.com', 'altitude.tv', 'foxone.com', 'fox.com', 'freshdesk.com',
]
const INTERNAL_LOCAL_TOKENS = [
  'support', 'appsupport', 'dvsupport', 'techsupport', 'getsupport', 'contactus',
  'contact', 'noreply', 'no-reply', 'admin', 'info', 'help', 'helpdesk', 'billing',
  'donotreply', 'do-not-reply', 'notifications', 'mailer', 'bounce', 'service',
  'customerservice', 'customercare', 'customersupport', 'team', 'care', 'feedback',
]
// Token-based match: "sc-contactus@spacecityhn.com" → tokens ["sc","contactus"]
// → internal. Token boundaries keep customer names safe (e.g. "phelps" ≠ "help").
function isInternalThreadEmail(email) {
  const [localPart, domain = ''] = email.toLowerCase().split('@')
  if (PLATFORM_DOMAINS.includes(domain)) return true
  const tokens = localPart.split(/[._\-+]/)
  return INTERNAL_LOCAL_TOKENS.some(p => tokens.some(tk => tk === p || tk.startsWith(p)))
}
// TVE (TV Everywhere): access through a TV provider — no direct billing sub,
// but a valid subscriber nonetheless.
function isTveAccount(cms) {
  if (!cms) return false
  const handler = (cms.payment_handler || '').toUpperCase()
  const plan = (cms.plan || '').toLowerCase().trim()
  return handler === 'TVE' || plan.startsWith('tve')
}
// The LLM's own verdict is a strong spam signal that keyword heuristics miss.
// If the generated bot notes / response say it's spam or needs no reply, offer
// the Mark-as-Spam action even when load-time detection didn't flag it.
const BOT_SPAM_PHRASES = [
  'marked as spam', 'mark as spam', 'mark it as spam', 'spam/solicitation',
  'spam or solicitation', 'is a spam', 'is spam', 'solicitation email',
  'not a legitimate support', 'not a legitimate customer', 'no response is warranted',
  'no customer-facing response', 'no reply is needed', 'should be closed and marked',
  'no response is required', 'phishing', 'this is spam',
]
function botOutputSaysSpam(notes, response) {
  const t = ((notes || '') + ' ' + (response || '')).toLowerCase()
  return BOT_SPAM_PHRASES.some(p => t.includes(p))
}
function isSupportEmail(email) {
  if (!email) return false
  const domain = (email.split('@')[1] || '').toLowerCase()
  if (SUPPORT_DOMAINS.includes(domain)) return true
  const prefix = email.split('@')[0].toLowerCase().replace(/[._-]/g, '')
  return SUPPORT_PREFIXES.some(p => prefix === p || prefix.startsWith(p))
}

export default function Generate() {
  const [customerMessage, setCustomerMessage] = useState('')
  const [screenshots, setScreenshots] = useState([]) // [{ base64, mediaType, previewUrl }]
  const [parsedInfo, setParsedInfo] = useState(null)
  const [generatedResponse, setGeneratedResponse] = useState('')
  const [historyId, setHistoryId] = useState(null)
  const [responseRating, setResponseRating] = useState(null) // 'useful' | 'not_useful' | null
  const [learnedCount, setLearnedCount] = useState(0)
  // Bot-maintained Freshdesk ticket summary — per-agent preference (opt-out)
  const [updateSummary, setUpdateSummary] = useState(() => localStorage.getItem('updateTicketSummary') !== 'false')
  const toggleUpdateSummary = () => setUpdateSummary(v => {
    localStorage.setItem('updateTicketSummary', String(!v))
    return !v
  })
  const [nextSteps, setNextSteps] = useState(null)
  const [botNotes, setBotNotes] = useState(null)
  const [agentNotes, setAgentNotes] = useState("")
  const [inputMode, setInputMode] = useState('manual') // 'manual' | 'freshdesk' | 'automated'
  const [fdInput, setFdInput] = useState('')
  // Full Automated — shared claim pool (multi-admin auto-assignment)
  const [autoActive, setAutoActive] = useState(false)
  const [autoStage, setAutoStage] = useState('idle') // idle|loading|generating|review|done
  const [autoCurrent, setAutoCurrent] = useState(null) // ticket currently claimed by me
  const [autoHandled, setAutoHandled] = useState(0)    // tickets I've sent this session
  const [autoStatus, setAutoStatus] = useState(null)   // live panel data
  const [autoStarting, setAutoStarting] = useState(false)
  const autoCurrentRef = useRef(null)
  const autoActiveRef = useRef(false)
  const autoPollRef = useRef(null)
  const autoHeartbeatRef = useRef(null)
  const autoBusyRef = useRef(false) // prevents overlapping claim attempts
  const [fdTicket, setFdTicket] = useState(null)
  const [fdLoading, setFdLoading] = useState(false)
  const [showContactModal, setShowContactModal] = useState(false)
  const [contactForm, setContactForm] = useState({ name: '', email: '' })
  const [contactSaving, setContactSaving] = useState(false)
  const [contactError, setContactError] = useState('')
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
  const [queues, setQueues] = useState(null)
  const [queuesLoading, setQueuesLoading] = useState(false)
  const [queuesOpen, setQueuesOpen] = useState(false)
  const [openQueuePlatforms, setOpenQueuePlatforms] = useState({})
  const [markingSpam, setMarkingSpam] = useState(false)
  const [spamMarked, setSpamMarked] = useState(false)
  const [seasonTicketCc, setSeasonTicketCc] = useState(false)
  const [isEditingResponse, setIsEditingResponse] = useState(false)
  const responseEditRef = useRef(null)
  const previewEditRef = useRef(null)
  const [soundEnabled, setSoundEnabled] = useState(() => {
    try { return localStorage.getItem('ticket_sound') !== 'off' } catch { return true }
  })
  const soundEnabledRef = useRef(true)
  soundEnabledRef.current = soundEnabled
  const audioCtxRef = useRef(null)

  const { activePlatform, platforms, setActivePlatform } = usePlatform()
  const { coverUserId, agents } = useCover()
  // Keep refs in sync so stale closures always read current values
  platformsRef.current = platforms
  activePlatformRef.current = activePlatform


  const CMS_PLATFORM_SITE = { 1: 'schn', 3: 'altitude', 10: 'dirtvision', 4: 'monumental' }

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


  useEffect(() => {
    client.get('/settings').then(r => {
      setFdEnabled(r.data?.freshdesk_on_generate !== 'false')
    }).catch(() => {})
  }, [])


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

  // Core generate call. Reads from explicit overrides when provided (automated flow),
  // otherwise from current UI state (manual/freshdesk flow). Returns the response data.
  const runGenerate = async (opts = {}) => {
    const message = opts.message ?? customerMessage
    const platformId = opts.platformId ?? activePlatform.id
    const cms = opts.cmsInfo !== undefined ? opts.cmsInfo : cmsInfo
    const altEmails = opts.cmsAltEmails !== undefined ? opts.cmsAltEmails : cmsAltEmails
    const notes = opts.agentNotes !== undefined ? opts.agentNotes : agentNotes
    const imgs = opts.skipImages ? [] : screenshots

    setIsLoading(true)
    setIsEditingResponse(false)
    setParsedInfo(null)
    setGeneratedResponse('')
    setNextSteps(null)
    setBotNotes(null)
    setNeedsVerification(false)
    setFaqSources([])
    setCannedSources([])

    try {
      const checkedEmails = [...new Set([fdTicket?.requester_email, ...(altEmails || [])].filter(Boolean).map(e => e.toLowerCase()))]
      const response = await client.post('/generate', {
        message,
        platform_id: platformId,
        images: imgs.length > 0 ? imgs.map(s => ({ base64: s.base64, media_type: s.mediaType })) : null,
        agent_notes: (notes || '').trim() || null,
        cms_account: cms?.found ? cms : null,
        checked_emails: checkedEmails.length > 0 ? checkedEmails : null,
        cms_not_found: cms !== null && !cms?.found && !cms?.token_error,
        cms_no_subscription: !!(cms?.found && !cms?.is_subscribed),
        // Spam short-circuit only applies to Full Automated bulk runs; when an
        // agent manually clicks Analyze & Generate, always produce a real reply.
        automated: !!opts.automated,
      })

      setParsedInfo(response.data.parsed)
      setGeneratedResponse(response.data.response || '')
      setNextSteps(response.data.next_steps || null)
      setBotNotes(response.data.bot_notes || null)
      setNeedsVerification(response.data.needs_verification || false)
      setFaqSources(response.data.faq_sources || [])
      setCannedSources(response.data.canned_sources || [])
      setHistoryId(response.data.history_id || null)
      setResponseRating(null)
      setLearnedCount(response.data.learned_count || 0)
      return response.data
    } catch (error) {
      const msg = apiErr(error, 'Failed to generate response. Please try again.')
      if (!opts.silent) toast.error(msg)
      return null
    } finally {
      setIsLoading(false)
    }
  }

  const handleAnalyzeAndGenerate = async () => {
    if (!customerMessage.trim()) {
      toast.error('Please enter the message content')
      return
    }
    const data = await runGenerate()
    if (data) {
      if (data.needs_verification) {
        toast('CMS verification required — attach a screenshot to continue', { icon: '⚠️' })
      } else {
        toast.success('Response generated successfully')
      }
    }
  }

  const handleRegenerate = async () => {
    if (!customerMessage.trim()) {
      toast.error('No message to regenerate from')
      return
    }

    setIsRegenerating(true)
    setIsEditingResponse(false)

    try {
      const response = await client.post('/generate', {
        message: customerMessage,
        platform_id: activePlatform.id,
        images: screenshots.length > 0 ? screenshots.map(s => ({ base64: s.base64, media_type: s.mediaType })) : null,
        agent_notes: agentNotes.trim() || null,
        cms_account: cmsInfo?.found ? cmsInfo : null,
        cms_not_found: cmsInfo !== null && !cmsInfo?.found && !cmsInfo?.token_error,
        cms_no_subscription: !!(cmsInfo?.found && !cmsInfo?.is_subscribed),
      })

      setParsedInfo(response.data.parsed)
      setGeneratedResponse(response.data.response || '')
      setNextSteps(response.data.next_steps || null)
      setBotNotes(response.data.bot_notes || null)
      setNeedsVerification(response.data.needs_verification || false)
      setFaqSources(response.data.faq_sources || [])
      setCannedSources(response.data.canned_sources || [])
      setHistoryId(response.data.history_id || null)
      setResponseRating(null)
      setLearnedCount(response.data.learned_count || 0)

      if (response.data.needs_verification) {
        toast('CMS verification required — attach a screenshot to continue', { icon: '⚠️' })
      } else {
        toast.success('Response regenerated successfully')
      }
    } catch (error) {
      const message = apiErr(error, 'Failed to regenerate response. Please try again.')
      toast.error(message)
    } finally {
      setIsRegenerating(false)
    }
  }

  const [spamMarkedIds, setSpamMarkedIds] = useState([])
  const markTicketSpam = async (ticketId) => {
    if (!ticketId) return
    setMarkingSpam(true)
    try {
      await client.post(`/freshdesk/ticket/${ticketId}/mark-spam`)
      setSpamMarkedIds(prev => [...prev, ticketId])
      if (fdTicket?.id === ticketId) setSpamMarked(true)
      toast.success('Ran the SPAM scenario in Freshdesk')
    } catch (err) {
      toast.error(apiErr(err, 'Failed to run the SPAM scenario'))
    } finally {
      setMarkingSpam(false)
    }
  }
  const handleMarkSpam = () => markTicketSpam(fdTicket?.id)

  // Load a flagged ticket into the manual Freshdesk Ticket flow.
  const loadFlaggedTicket = (url) => {
    setInputMode('freshdesk')
    setFdInput(url)
    loadFdTicket(url)
  }

  const QUEUE_PLATFORMS = ['SCHN+', 'Altitude Sports', 'DirtVision', 'Monumental Sports']
  const refreshQueues = async () => {
    setQueuesOpen(true)
    setQueuesLoading(true)
    try {
      const res = await client.get('/freshdesk/queues')
      const src = res.data.queues || {}
      const map = {}
      QUEUE_PLATFORMS.forEach(p => { map[p] = src[p] || [] })
      setQueues(map)
    } catch (err) {
      toast.error(apiErr(err, 'Failed to load queues'))
    } finally {
      setQueuesLoading(false)
    }
  }
  const toggleQueues = () => {
    const next = !queuesOpen
    setQueuesOpen(next)
    if (next && !queues) refreshQueues()
  }

  const rateResponse = async (value) => {
    if (!historyId) return
    const prev = responseRating
    setResponseRating(value)
    try {
      await client.patch(`/history/${historyId}/feedback`, { feedback: value })
      toast.success(value === 'useful' ? 'Rated as good response' : 'Sent to review queue')
    } catch (error) {
      setResponseRating(prev)
      toast.error('Failed to save rating')
    }
  }

  const saveContact = async () => {
    if (!contactForm.name.trim() || !contactForm.email.trim()) return
    setContactSaving(true)
    setContactError('')
    try {
      await client.post(`/freshdesk/ticket/${fdTicket.id}/requester`, contactForm)
      setShowContactModal(false)
      loadFdTicket()
    } catch (e) {
      setContactError(apiErr(e, 'Error updating contact'))
    } finally {
      setContactSaving(false)
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

  // Any 429 anywhere carries Freshdesk's real Retry-After — override the
  // widget's local 1-hour estimate so both countdowns always match.
  useEffect(() => {
    const onRateLimited = (e) => {
      const seconds = e.detail?.seconds
      if (!seconds) return
      setFdRateLimit(prev => {
        // Rate-limited means zero calls available NOW — the stale "remaining"
        // from before the block would contradict the paused state.
        const next = { ...(prev || { total: 5000 }), remaining: 0, resetAt: Date.now() + seconds * 1000 }
        localStorage.setItem('fd_rate_limit', JSON.stringify(next))
        return next
      })
    }
    window.addEventListener('fd-rate-limited', onRateLimited)
    return () => window.removeEventListener('fd-rate-limited', onRateLimited)
  }, [])

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
    setSpamMarked(false)
    try {
      const r = await client.get(`/freshdesk/ticket/${id}`)
      setFdTicket(r.data)
      setSeasonTicketCc(!!r.data.season_ticket_holder)
      const loadedMessage = r.data.full_thread || r.data.description
      setCustomerMessage(loadedMessage)
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
      let finalCmsInfo = null
      let finalAlts = []
      if (cmsSite && r.data.requester_email) {
        setCmsLoading(true)
        const requesterEmail = r.data.requester_email.toLowerCase()
        try {
          const cr = await client.get(`/cms/lookup?email=${encodeURIComponent(r.data.requester_email)}&site=${cmsSite}`)
          {
            finalCmsInfo = cr.data
            setCmsInfo(cr.data)
            if (cr.data?.token_error) {
              toast.error(cr.data.message || `CMS token for ${cmsSite} expired — renew it in Profile → CMS token.`, { duration: 9000, icon: '🔑' })
            }
            if (!cr.data.found || (cr.data.found && !cr.data.is_subscribed)) {
              const thread = r.data.full_thread || r.data.description || ''
              const requesterLocal = requesterEmail.split('@')[0]
              const found = [...new Set(
                (thread.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || [])
                  .map(e => e.toLowerCase())
                  .filter(e => {
                    if (e === requesterEmail) return false
                    if (isInternalThreadEmail(e)) return false
                    const localPart = e.split('@')[0]
                    // Filter HTML artifact: word concatenated directly before a known email (e.g. "addressjudy...")
                    if (localPart !== requesterLocal && localPart.endsWith(requesterLocal)) return false
                    return true
                  })
              )]

              // Fuzzy case 1: space in local part where second segment starts with digit
              // e.g. "tchildress 9626@gmail.com" → "tchildress9626@gmail.com"
              const fuzzyLocal = thread.match(/[a-zA-Z0-9._%+\-]{2,25}\s\d[a-zA-Z0-9._%+\-]{0,15}@[a-zA-Z0-9.\-]+\.[ \t]*[a-zA-Z]{2,6}/g) || []
              // Fuzzy case 2: space around dot in domain, normal local part
              // e.g. "swcasey495@gmail. com" → "swcasey495@gmail.com"
              const fuzzyDomain = thread.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+[ \t]*\.[ \t]*[a-zA-Z]{2,6}/g) || []
              const _knownEmails = [requesterEmail, ...found]
              // Common English words that appear after a real TLD (e.g. "email@gmail.com. Since...")
              // and get mistakenly captured as TLDs by the fuzzy regex.
              const _fakeTlds = new Set(['since','with','from','that','this','when','after','and',
                'but','for','not','are','was','has','had','its','our','you','all','can','been'])
              const fuzzyClean = [...new Set(
                [...fuzzyLocal, ...fuzzyDomain]
                  .map(m => m.replace(/[ \t]+/g, '').toLowerCase())
                  .filter(m => /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,6}$/.test(m))
                  .filter(m => {
                    // Reject if this is a known real email with extra ".word" appended
                    if (_knownEmails.some(e => m.startsWith(e + '.'))) return false
                    // Reject if the TLD is a common English word (punctuation artifact)
                    const tld = m.split('.').pop()
                    if (_fakeTlds.has(tld)) return false
                    if (m === requesterEmail || found.includes(m)) return false
                    if (isInternalThreadEmail(m)) return false
                    const localPart = m.split('@')[0]
                    if (localPart !== requesterLocal && localPart.endsWith(requesterLocal)) return false
                    return true
                  })
              )]

              finalAlts = [...found, ...fuzzyClean]
              setCmsAltEmails(finalAlts)
              // The requester's own email had no CMS account. Customers often reply
              // from a different email than the ticket's (or the ticket comes from a
              // support alias). Try each alt email found in the thread and adopt the
              // first that resolves in CMS — so both manual and Full Automated flows
              // generate against the real account.
              if (finalAlts.length > 0 && !cr.data.found) {
                for (const alt of finalAlts) {
                  try {
                    const ar = await client.get(`/cms/lookup?email=${encodeURIComponent(alt)}&site=${cmsSite}`)
                    if (ar.data.found) { finalCmsInfo = ar.data; setCmsInfo(ar.data); break }
                  } catch (_) {}
                }
              }
            }
          }
        } catch (_) {
        } finally {
          setCmsLoading(false)
        }
      } else if (r.data.requester_email && isSupportEmail(r.data.requester_email)) {
        // Support-alias ticket on a platform without a CMS site (e.g. @livgolf.com):
        // still surface the real customer email from the thread for the contact change.
        const thread = r.data.full_thread || r.data.description || ''
        const requesterEmail = r.data.requester_email.toLowerCase()
        finalAlts = [...new Set(
          (thread.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || [])
            .map(e => e.toLowerCase())
            .filter(e => e !== requesterEmail && !isInternalThreadEmail(e))
        )]
        setCmsAltEmails(finalAlts)
      }
      // Chime on manual loads; automated loads chime later when ready for review.
      if (!autoActiveRef.current) playChime()
      return { ok: true, id, message: loadedMessage, platformId: pId, cmsInfo: finalCmsInfo, cmsAltEmails: finalAlts }
    } catch (err) {
      toast.error(apiErr(err, 'Failed to load ticket'))
      return { ok: false }
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
    const row = (label, value) => value
      ? `<tr><td style="padding:5px 20px 5px 0;font-weight:600;white-space:nowrap;color:#1f2937;vertical-align:top">${label}</td><td style="padding:5px 0;color:#374151">${value}</td></tr>`
      : ''
    const planLabel = info.plan_name || info.plan || ''
    const rows = [
      row('Plan Name', planLabel),
      row('Price', info.price),
      row('Status', info.subscription_status),
      row('Country', info.country),
      row('Receipt ID', info.receipt_id),
      row('Payment Unique ID', info.payment_unique_id),
      row('Transaction ID', (info.transaction_id && info.transaction_id !== info.receipt_id) ? info.transaction_id : null),
      row('Payment Handler', info.payment_handler),
      row('Registered On', info.registered_on),
      row('End Date', info.end_date),
    ].filter(Boolean).join('\n')
    if (!rows) return ''
    return `<table style="border-collapse:collapse;font-size:13px;font-family:sans-serif">${rows}</table>`
  }

  const handleSendReply = async () => {
    if (!fdTicket?.id || !generatedResponse) return
    // HARD GUARD: never send a reply whose recipient is a support-alias domain
    // (e.g. a LIV Golf employee). Force changing the contact to the real customer.
    if (isBlockedRecipientDomain(fdTicket?.requester_email)) {
      toast.error(`This ticket's contact is ${fdTicket.requester_email} (an internal LIV address). Change the contact to the customer before sending.`, { duration: 6000 })
      setShowPreview(false)
      setContactForm({ name: cmsInfo?.name || parsedInfo?.customer_name || '', email: cmsAltEmails[0] || cmsInfo?.email || parsedInfo?.customer_email || '' })
      setShowContactModal(true)
      return
    }
    // Use the latest edited HTML from the preview editor (uncontrolled div) so
    // last-second edits are sent, even before React state catches up.
    const replyBody = previewEditRef.current ? previewEditRef.current.innerHTML : generatedResponse
    setIsSending(true)
    try {
      const replyRes = await client.post(`/freshdesk/ticket/${fdTicket.id}/reply`, {
        body: replyBody,
        update_summary: updateSummary,
        problem_summary: parsedInfo?.problem_summary || null,
        ...(seasonTicketCc ? {
          cc_emails: ['appsupport@monumentalsports.com'],
          tags: ['MSN-Issue-SeasonTicketHolder'],
        } : {}),
        ...(coverUserId ? { cover_user_id: coverUserId } : {}),
      })
      const summaryStatus = replyRes.data?.summary
      if (summaryStatus === 'created' || summaryStatus === 'updated') {
        toast.success(`Ticket summary ${summaryStatus}`, { icon: '📝' })
      }
      const cmsNote = cmsInfo?.found ? buildCmsNote(cmsInfo) : null
      const hasNoteContent = cmsNote || noteImages.length > 0
      if (hasNoteContent) {
        await client.post(`/freshdesk/ticket/${fdTicket.id}/note`, {
          body: cmsNote || 'Agent screenshots',
          images: noteImages.length > 0 ? noteImages.map(s => ({ base64: s.base64, media_type: s.mediaType })) : null,
          ...(coverUserId ? { cover_user_id: coverUserId } : {}),
        })
      }
      // Status update — the backend retries transient Freshdesk 5xx. If it still
      // fails, warn the agent so they can set the status manually.
      let statusOk = true
      try {
        const statusPayload = { status: 12 }
        if (fdTicket?.type) statusPayload.type = fdTicket.type
        await client.put(`/freshdesk/ticket/${fdTicket.id}/status`, statusPayload)
      } catch (statusErr) {
        statusOk = false
        console.warn('Status update failed:', statusErr?.response?.data || statusErr.message)
      }
      // Log reply to tracker, then refresh the widget so the count updates live.
      try { await client.post('/ticket-tracker/log-reply', { ticket_url: 'https://viewlift.freshdesk.com/a/tickets/' + fdTicket.id, ...(coverUserId ? { cover_user_id: coverUserId } : {}) }) } catch (_) {}
      window.dispatchEvent(new Event('tracker-refresh'))
      if (statusOk) {
        toast.success('Reply sent — status set to Waiting on End User')
      } else {
        toast('Reply sent, but the status could NOT be set to Waiting on End User — please change it manually.', { icon: '⚠️', duration: 6000 })
      }
      setShowPreview(false)
      setNoteImages([])
      const wasAutomated = autoActiveRef.current && autoStage === 'review'
      const sentTicket = autoCurrentRef.current
      handleClear(true)
      if (wasAutomated && sentTicket) {
        try { await client.post('/freshdesk/automated/complete', { ticket_id: sentTicket.id }) } catch (_) {}
        setAutoHandled(n => n + 1)
        setTimeout(() => claimAndProcess(), 300)
      }
    } catch (err) {
      toast.error(apiErr(err, 'Failed to send reply'))
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

      // Name every email we actually checked (ticket requester + any alt emails
      // found in the thread) so the customer knows none of them are registered
      // and can give us the correct one.
      const checked = [...new Set([email, ...cmsAltEmails].filter(Boolean).map(e => e.toLowerCase()))]
      if (checked.length > 0) {
        const list = checked.join(' and ')
        const plural = checked.length > 1
        html = html.replace(
          'the email address or phone number you provided',
          `the email address${plural ? 'es' : ''} you provided (${list})`
        )
      }

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
      // Use CMS lookup email when available (agent may have searched a different email than the requester)
      const email = cmsInfo?.email || fdTicket?.requester_email || ''
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
    setIsEditingResponse(false)
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

  // ── Full Automated — shared claim pool orchestration ────────────────
  const startAutomated = async () => {
    // Unlock audio here (this is a real user gesture) so later auto-claim chimes
    // — which fire without a direct click — aren't blocked by the browser.
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext
      if (Ctx) {
        if (!audioCtxRef.current) audioCtxRef.current = new Ctx()
        if (audioCtxRef.current.state === 'suspended') await audioCtxRef.current.resume()
      }
    } catch (_) {}
    setAutoStarting(true)
    setAutoActive(true)
    autoActiveRef.current = true
    setAutoHandled(0)
    try {
      await claimAndProcess()
    } finally {
      setAutoStarting(false)
    }
  }

  // Claim the next available ticket from the shared pool, load it, and generate.
  // When the pool is empty, enter a 'watching' state and keep monitoring until
  // a new ticket appears (auto-picked up by the live-status watcher effect).
  const claimAndProcess = async () => {
    if (!autoActiveRef.current || autoBusyRef.current) return
    autoBusyRef.current = true
    setAutoStage('loading')
    setAutoCurrent(null)
    autoCurrentRef.current = null
    try {
      let ticket = null
      try {
        const r = await client.post('/freshdesk/automated/claim-next')
        ticket = r.data.ticket
      } catch (e) {
        toast.error(apiErr(e, 'Failed to claim next ticket'))
        setAutoStage('watching')
        return
      }
      if (!ticket) {
        // Nothing available right now (or the Freshdesk API window is
        // exhausted) — watch and pick up automatically when possible.
        setAutoStage('watching')
        return
      }
      setAutoCurrent(ticket)
      autoCurrentRef.current = ticket
      const loaded = await loadFdTicket(ticket.url)
      if (!loaded?.ok) {
        try { await client.post('/freshdesk/automated/release', { ticket_id: ticket.id, reason: 'stop' }) } catch (_) {}
        autoBusyRef.current = false
        return claimAndProcess()
      }
      setAutoStage('generating')
      await runGenerate({
        message: loaded.message,
        platformId: loaded.platformId,
        cmsInfo: loaded.cmsInfo,
        cmsAltEmails: loaded.cmsAltEmails,
        agentNotes: '',
        skipImages: true,
        automated: true,
      })
      setAutoStage('review')
    } finally {
      autoBusyRef.current = false
    }
  }

  const stopAutomated = async () => {
    autoActiveRef.current = false
    const cur = autoCurrentRef.current
    if (cur) {
      try { await client.post('/freshdesk/automated/release', { ticket_id: cur.id, reason: 'stop' }) } catch (_) {}
    }
    setAutoActive(false)
    setAutoStage('idle')
    setAutoCurrent(null)
    autoCurrentRef.current = null
  }

  // Live panel polling + heartbeat while automated mode is active
  useEffect(() => {
    if (!autoActive) {
      if (autoPollRef.current) { clearInterval(autoPollRef.current); autoPollRef.current = null }
      if (autoHeartbeatRef.current) { clearInterval(autoHeartbeatRef.current); autoHeartbeatRef.current = null }
      return
    }
    const poll = async () => {
      try {
        const r = await client.get('/freshdesk/automated/status')
        setAutoStatus(r.data)
        // The backend brake absorbs Freshdesk 429s (no error reaches the
        // browser), so sync the rate-limit widget from its countdown too.
        if ((r.data?.rate_limited_seconds || 0) > 0) {
          window.dispatchEvent(new CustomEvent('fd-rate-limited', { detail: { seconds: r.data.rate_limited_seconds } }))
        }
      } catch (_) {}
    }
    poll()
    autoPollRef.current = setInterval(poll, 4000)
    autoHeartbeatRef.current = setInterval(async () => {
      const cur = autoCurrentRef.current
      if (cur) { try { await client.post('/freshdesk/automated/heartbeat', { ticket_id: cur.id }) } catch (_) {} }
    }, 90000)
    return () => {
      if (autoPollRef.current) { clearInterval(autoPollRef.current); autoPollRef.current = null }
      if (autoHeartbeatRef.current) { clearInterval(autoHeartbeatRef.current); autoHeartbeatRef.current = null }
    }
  }, [autoActive])

  // Watcher: while idle-watching, auto-claim as soon as a ticket appears in the
  // pool — but never while the Freshdesk API window is exhausted (the bot
  // pauses and resumes by itself when rate_limited_seconds reaches 0).
  useEffect(() => {
    if (autoActive && autoStage === 'watching' && !autoBusyRef.current
        && (autoStatus?.rate_limited_seconds || 0) === 0
        && (autoStatus?.pool_remaining || 0) > 0) {
      claimAndProcess()
    }
  }, [autoStatus, autoStage, autoActive])

  // Populate the editable area once when entering edit mode (uncontrolled — so
  // background re-renders like the live-pool poll never wipe the admin's edits).
  useEffect(() => {
    if (isEditingResponse && responseEditRef.current) {
      responseEditRef.current.innerHTML = generatedResponse
      responseEditRef.current.focus()
    }
  }, [isEditingResponse])

  // Commit the edited HTML back into state (call before send/copy/close).
  const commitResponseEdit = () => {
    if (isEditingResponse && responseEditRef.current) {
      setGeneratedResponse(responseEditRef.current.innerHTML)
    }
  }

  // Populate the preview modal's editable area when it opens (uncontrolled, so
  // background re-renders never wipe edits made right before sending).
  useEffect(() => {
    if (showPreview && previewEditRef.current) {
      previewEditRef.current.innerHTML = generatedResponse
    }
  }, [showPreview])

  // Pleasant two-tone chime (Web Audio — no asset needed). The AudioContext is
  // unlocked by the click that starts monitoring / loads a ticket.
  const playChime = () => {
    if (!soundEnabledRef.current) return
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext
      if (!Ctx) return
      if (!audioCtxRef.current) audioCtxRef.current = new Ctx()
      const ctx = audioCtxRef.current
      if (ctx.state === 'suspended') ctx.resume()
      const now = ctx.currentTime
      ;[[880, 0], [1174.66, 0.13]].forEach(([freq, t]) => {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.value = freq
        gain.gain.setValueAtTime(0.0001, now + t)
        gain.gain.exponentialRampToValueAtTime(0.18, now + t + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.28)
        osc.connect(gain); gain.connect(ctx.destination)
        osc.start(now + t); osc.stop(now + t + 0.3)
      })
    } catch (_) {}
  }

  const toggleSound = () => {
    setSoundEnabled(v => {
      const nv = !v
      try { localStorage.setItem('ticket_sound', nv ? 'on' : 'off') } catch (_) {}
      if (nv) { soundEnabledRef.current = true; playChime() } // preview on enable
      return nv
    })
  }

  // Chime when an automated ticket becomes ready for review.
  useEffect(() => {
    if (autoActive && autoStage === 'review') playChime()
  }, [autoStage, autoActive])

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
            <div className="mb-4">
              {fdEnabled ? (
                <div className="inline-flex rounded-lg border border-gray-200 dark:border-gray-600 overflow-hidden text-xs font-medium">
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
                  <button
                    onClick={() => setInputMode('automated')}
                    className={`px-3 py-1.5 transition-colors border-l border-gray-200 dark:border-gray-600 ${inputMode === 'automated' ? 'bg-purple-600 text-white' : 'text-purple-500 hover:bg-purple-50 dark:hover:bg-gray-700'}`}
                  >
                    ⚡ Full Automated
                  </button>
                </div>
              ) : (
                <span className="text-xs font-medium text-gray-400 dark:text-gray-500">Manual input</span>
              )}
              <div className="mt-2">
                <button onClick={handleClear} className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors">✕ Clear</button>
              </div>
            </div>

            {/* Full Automated control panel */}
            {inputMode === 'automated' && (
              <div className="mb-4 space-y-3">
                <div className="p-3 rounded-lg bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-700">
                  <p className="text-xs text-purple-800 dark:text-purple-300 font-semibold mb-1">⚡ Full Automated — SCHN · Monumental · DirtVision · Altitude</p>
                  <p className="text-[11px] text-purple-600 dark:text-purple-400 leading-snug">
                    Shared pool across all admins. Each admin is auto-assigned a different ticket
                    (Open / Waiting on L1, new customer reply within 5h): it loads, switches client,
                    generates the response, and waits for your approval. Spam and refund/cancellation
                    tickets are filtered out for manual review.
                  </p>
                </div>

                {!autoActive && (
                  <button
                    onClick={startAutomated}
                    disabled={autoStarting}
                    className="w-full px-4 py-2.5 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white text-sm font-semibold rounded-lg transition-colors"
                  >
                    {autoStarting ? 'Starting…' : '⚡ Start Monitoring'}
                  </button>
                )}

                {autoActive && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">
                        {`You've sent ${autoHandled} this session`}
                      </span>
                      <div className="flex items-center gap-3">
                        <button onClick={toggleSound} title={soundEnabled ? 'Sound on — click to mute' : 'Sound off — click to enable'} className="text-sm">
                          {soundEnabled ? '🔊' : '🔇'}
                        </button>
                        <button onClick={stopAutomated} className="text-xs text-red-500 hover:text-red-600 font-medium">Stop</button>
                      </div>
                    </div>

                    <p className="text-[11px] text-gray-500 dark:text-gray-400">
                      {autoStage === 'loading' && '⏳ Claiming & loading next ticket…'}
                      {autoStage === 'generating' && '🤖 Generating response…'}
                      {autoStage === 'review' && autoCurrent && `👀 Working #${autoCurrent.id} (${autoCurrent.platform}) — review & Send Reply to continue.`}
                      {autoStage === 'watching' && ((autoStatus?.rate_limited_seconds || 0) > 0
                        ? `⏸️ Paused — Freshdesk API limit reached. Auto-resuming in ~${Math.ceil(autoStatus.rate_limited_seconds / 60)} min.`
                        : '🔭 Monitoring — waiting for new tickets. Will claim automatically when one arrives.')}
                    </p>
                    {(autoStatus?.rate_limited_seconds || 0) > 0 && autoStage !== 'watching' && (
                      <p className="text-[11px] text-amber-600 dark:text-amber-400">
                        ⚠️ Freshdesk API limit reached — new claims paused for ~{Math.ceil(autoStatus.rate_limited_seconds / 60)} min.
                      </p>
                    )}

                    {/* Live shared-pool panel */}
                    {autoStatus && (
                      <div className="p-2 rounded-md bg-gray-50 dark:bg-gray-700/50 border border-gray-200 dark:border-gray-600 space-y-1.5">
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="font-semibold text-gray-700 dark:text-gray-300">🟢 Live pool</span>
                          <span className="text-gray-500 dark:text-gray-400">
                            {autoStatus.pool_remaining} remaining · {autoStatus.sent_count} sent
                          </span>
                        </div>
                        {autoStatus.active_admins?.length > 0 && (
                          <div className="space-y-0.5">
                            <p className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Active admins ({autoStatus.active_admins.length})</p>
                            {autoStatus.active_admins.map(a => (
                              <div key={a.id} className="flex items-center gap-1.5 text-[11px] text-gray-600 dark:text-gray-300">
                                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${a.ticket_id ? 'bg-green-500' : 'bg-blue-400 animate-pulse'}`} />
                                <span className="font-medium">{a.name}{a.is_me ? ' (you)' : ''}</span>
                                {a.ticket_id ? (
                                  <><span className="text-gray-400">→</span><span className="truncate">working #{a.ticket_id}</span></>
                                ) : (
                                  <span className="text-blue-500 dark:text-blue-400">monitoring…</span>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                        {autoStatus.flagged?.length > 0 && (
                          <div className="space-y-0.5 pt-1 border-t border-gray-200 dark:border-gray-600">
                            <p className="text-[10px] font-semibold text-amber-600 dark:text-amber-400 uppercase tracking-wide">Manual review ({autoStatus.flagged.length})</p>
                            {autoStatus.flagged.slice(0, 6).map(f => (
                              <div key={f.id} className="text-[11px] py-0.5">
                                <p className="text-amber-600 dark:text-amber-400 truncate">
                                  #{f.id} · {f.reason} · {f.subject}
                                </p>
                                <div className="flex items-center gap-2 mt-0.5">
                                  <button
                                    onClick={() => loadFlaggedTicket(f.url)}
                                    className="text-blue-600 dark:text-blue-400 hover:underline"
                                  >
                                    Load ticket
                                  </button>
                                  <span className="text-gray-300 dark:text-gray-600">·</span>
                                  <a href={f.url} target="_blank" rel="noreferrer"
                                    className="text-gray-500 dark:text-gray-400 hover:underline">
                                    Open in Freshdesk ↗
                                  </a>
                                  {f.reason === 'spam' && (
                                    <>
                                      <span className="text-gray-300 dark:text-gray-600">·</span>
                                      {spamMarkedIds.includes(f.id) ? (
                                        <span className="text-red-600 dark:text-red-400 font-semibold">✓ Marked spam</span>
                                      ) : (
                                        <button
                                          onClick={() => markTicketSpam(f.id)}
                                          disabled={markingSpam}
                                          className="text-red-600 dark:text-red-400 font-semibold hover:underline disabled:opacity-50"
                                          title="Run the Freshdesk SPAM scenario"
                                        >
                                          🚫 Mark as Spam
                                        </button>
                                      )}
                                    </>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Freshdesk ticket loader */}
            {(inputMode === 'freshdesk' || inputMode === 'automated') && (
              <div className="mb-4 space-y-3">
                {inputMode === 'freshdesk' && (
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
                )}
                {fdTicket && (
                  <div className="rounded-lg border border-blue-200 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/20 p-3 text-xs space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-blue-800 dark:text-blue-300">#{fdTicket.id}</span>
                      <span className="font-semibold text-gray-800 dark:text-white">{fdTicket.subject}</span>
                      <span className="px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-800 text-blue-700 dark:text-blue-300">{fdTicket.status}</span>
                    </div>
                    {fdTicket.requester_name && <p className="text-gray-500 dark:text-gray-400">From: {fdTicket.requester_name} {fdTicket.requester_email ? `(${fdTicket.requester_email})` : ''}</p>}
                    {fdTicket.season_ticket_holder && (
                      <label className="flex items-start gap-2 mt-1 p-2 rounded-md bg-purple-50 dark:bg-purple-900/30 border border-purple-300 dark:border-purple-600 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={seasonTicketCc}
                          onChange={(e) => setSeasonTicketCc(e.target.checked)}
                          className="mt-0.5 rounded border-gray-300 dark:border-gray-600 text-purple-600 focus:ring-purple-400"
                        />
                        <span className="text-purple-800 dark:text-purple-300">
                          🎟️ <span className="font-semibold">Season ticket holder</span> — CC <span className="font-mono">appsupport@monumentalsports.com</span> and tag <span className="font-mono">MSN-Issue-SeasonTicketHolder</span> when sending.
                        </span>
                      </label>
                    )}
                    {fdTicket.spam_detected && (
                      <div className="flex items-start justify-between gap-2 mt-1 p-2 rounded-md bg-red-50 dark:bg-red-900/30 border border-red-300 dark:border-red-600">
                        <div className="min-w-0">
                          <p className="text-red-800 dark:text-red-300 font-semibold">🚫 Detected as spam</p>
                          {fdTicket.spam_reason && <p className="text-red-700 dark:text-red-400">{fdTicket.spam_reason}</p>}
                        </div>
                        {spamMarked ? (
                          <span className="shrink-0 px-2.5 py-1 rounded-md bg-red-100 dark:bg-red-800/50 text-red-700 dark:text-red-300 font-semibold whitespace-nowrap">✓ Marked</span>
                        ) : (
                          <button
                            onClick={handleMarkSpam}
                            disabled={markingSpam}
                            className="shrink-0 px-2.5 py-1 bg-red-600 hover:bg-red-700 disabled:bg-red-400 text-white font-semibold rounded-md transition-colors whitespace-nowrap"
                            title="Runs the Freshdesk SPAM scenario on this ticket"
                          >
                            {markingSpam ? 'Running…' : '🚫 Mark as Spam'}
                          </button>
                        )}
                      </div>
                    )}
                    {fdTicket.requester_email && isSupportEmail(fdTicket.requester_email) && (
                      <div className="flex items-start gap-2 mt-1 p-2 rounded-md bg-yellow-50 dark:bg-yellow-900/30 border border-yellow-300 dark:border-yellow-600">
                        <svg className="w-4 h-4 text-yellow-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                        </svg>
                        <div>
                          <p className="font-semibold text-yellow-800 dark:text-yellow-300 text-xs">Update contact info required</p>
                          <p className="text-yellow-700 dark:text-yellow-400 text-xs mt-0.5">
                            This ticket was submitted by a support email <span className="font-medium">({fdTicket.requester_email})</span>. Please update the requester to the real end user before replying.
                          </p>
                          {cmsAltEmails.length > 0 && (
                            <p className="text-yellow-700 dark:text-yellow-400 text-xs mt-0.5">
                              Real customer email detected in thread: <span className="font-mono font-semibold">{cmsAltEmails[0]}</span>
                            </p>
                          )}
                          <button
                            onClick={() => { setContactForm({ name: cmsInfo?.name || parsedInfo?.customer_name || fdTicket?.requester_name || '', email: cmsAltEmails[0] || cmsInfo?.email || parsedInfo?.customer_email || '' }); setShowContactModal(true) }}
                            className="inline-block mt-1 px-2 py-0.5 rounded bg-yellow-200 dark:bg-yellow-800 text-yellow-900 dark:text-yellow-100 text-xs font-semibold hover:bg-yellow-300 dark:hover:bg-yellow-700 transition-colors"
                          >
                            Change contact
                          </button>
                        </div>
                      </div>
                    )}
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
                              : isTveAccount(cmsInfo)
                                ? <span className="ml-2 px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400" title="TV Everywhere — subscribed through their TV provider">TVE · via TV provider</span>
                                : (cmsInfo.subscription_status || '').toUpperCase().includes('SUSPEND')
                                  ? <span className="ml-2 px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400">Suspended</span>
                                  : (cmsInfo.subscription_status || '').toUpperCase().includes('CANCEL')
                                    ? <span className="ml-2 px-1.5 py-0.5 rounded bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-400">Cancelled</span>
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
                        {cmsInfo.last_charge?.amount && <p className="text-gray-500 dark:text-gray-400 text-xs">Last charge: {cmsInfo.last_charge.currency} {cmsInfo.last_charge.amount} ({cmsInfo.last_charge.period_start} to {cmsInfo.last_charge.period_end})</p>}
                        {Array.isArray(cmsInfo.qoss) && <p className="text-gray-500 dark:text-gray-400 text-xs">QOSS: {cmsInfo.qoss.length ? cmsInfo.qoss.length + ' recent sessions' : 'no recent activity'}</p>}
                        {Array.isArray(cmsInfo.charges) && cmsInfo.charges.length > 0 && <p className="text-gray-500 dark:text-gray-400 text-xs">Charges: {cmsInfo.charges.length} total ({cmsInfo.charges[0].currency} {cmsInfo.charges.reduce((s, c) => s + (parseFloat(c.amount) || 0), 0).toFixed(2)}) — last {cmsInfo.charges[0].date}</p>}
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
                disabled={isLoading || !customerMessage.trim() || !activePlatform || (needsVerification && screenshots.length === 0 && !cmsInfo?.found && cmsAltEmails.length > 0 && !agentNotes.trim())}
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

        {/* Center Panel - Response */}
        <div className="space-y-6 min-w-0">
          {/* B2C No Account — shown when CMS lookup found nothing */}
          {/* CMS token expired — the lookup could not run, don't imply "no account" */}
          {cmsInfo?.token_error && fdTicket?.id && (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-300 dark:border-red-600 rounded-lg p-4 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-base shrink-0">🔑</span>
                <p className="text-sm text-red-800 dark:text-red-300 font-medium">
                  {cmsInfo.message || 'CMS token expired — the account could not be checked. Renew the CMS token before sending.'}
                </p>
              </div>
              <a
                href="/profile"
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-semibold rounded-md transition-colors whitespace-nowrap"
              >
                Renew token ↗
              </a>
            </div>
          )}
          {/* B2C No Account — shown when CMS lookup found nothing */}
          {(() => {
            // Alt emails from the thread are auto-tried during load, so if we're
            // still not found here, none resolved — offer the no-account reply.
            // A token error is NOT "no account" — suppress this block for it.
            if (!cmsInfo || cmsInfo.found || cmsInfo.token_error || !fdTicket?.id) return null
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

          {/* B2C No Subscription — email-aware: only suppress button if sent for this exact email.
              SUSPENDED accounts are excluded: the suspension IS the customer's problem, the
              "no subscription" template would be wrong. */}
          {(() => {
            if (!cmsInfo?.found || cmsInfo?.is_subscribed || !fdTicket?.id) return null
            if ((cmsInfo?.subscription_status || '').toUpperCase().includes('SUSPEND')) return null
            if (isTveAccount(cmsInfo)) return null
            // Account found WITH a plan/billing history (even cancelled/expired):
            // "No Subscription" would be wrong — we clearly have their account.
            if (cmsInfo?.plan || cmsInfo?.plan_name || (cmsInfo?.charges && cmsInfo.charges.length)) return null
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
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-6 min-w-0">
              <div className="flex flex-wrap justify-between items-center gap-2 mb-4">
                <div className="flex items-center gap-2 min-w-0">
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
                  {generatedResponse && learnedCount > 0 && (
                    <span
                      title={`This response used ${learnedCount} learned example${learnedCount > 1 ? 's' : ''} from rated past interactions`}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300"
                    >
                      📚 {learnedCount} learned
                    </span>
                  )}
                  {generatedResponse && historyId && (
                    <div className="flex items-center gap-1 ml-1">
                      <button
                        onClick={() => rateResponse('useful')}
                        title="Good response — teaches the bot to answer similar cases like this"
                        className={`px-2 py-1 rounded-md text-sm transition-colors border ${
                          responseRating === 'useful'
                            ? 'bg-green-100 border-green-400 dark:bg-green-900/40 dark:border-green-600'
                            : 'bg-transparent border-gray-200 dark:border-gray-600 opacity-60 hover:opacity-100'
                        }`}
                      >
                        👍
                      </button>
                      <button
                        onClick={() => rateResponse('not_useful')}
                        title="Bad response — sends it to the developer review queue"
                        className={`px-2 py-1 rounded-md text-sm transition-colors border ${
                          responseRating === 'not_useful'
                            ? 'bg-red-100 border-red-400 dark:bg-red-900/40 dark:border-red-600'
                            : 'bg-transparent border-gray-200 dark:border-gray-600 opacity-60 hover:opacity-100'
                        }`}
                      >
                        👎
                      </button>
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2 justify-end">
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
                    onClick={() => {
                      if (isEditingResponse) { commitResponseEdit(); setIsEditingResponse(false) }
                      else { setIsEditingResponse(true) }
                    }}
                    disabled={!generatedResponse}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border rounded-lg disabled:opacity-40 disabled:cursor-not-allowed transition-colors ${isEditingResponse ? 'text-white bg-green-600 border-green-600 hover:bg-green-700' : 'text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 border-gray-200 dark:border-gray-600 hover:bg-gray-200 dark:hover:bg-gray-600'}`}
                  >
                    {isEditingResponse ? '✓ Done' : '✏️ Edit'}
                  </button>
                  <button
                    onClick={handleCopy}
                    disabled={!generatedResponse}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    ⎘ Copy
                  </button>
                  {fdTicket?.id && (
                    isBlockedRecipientDomain(fdTicket?.requester_email) ? (
                      <button
                        onClick={() => { setContactForm({ name: cmsInfo?.name || parsedInfo?.customer_name || '', email: cmsAltEmails[0] || cmsInfo?.email || parsedInfo?.customer_email || '' }); setShowContactModal(true) }}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-amber-600 rounded-lg hover:bg-amber-700 transition-colors shadow-sm"
                        title={`Contact is ${fdTicket.requester_email} (internal LIV address). Change it to the customer before sending.`}
                      >
                        ⚠️ Change contact before sending
                      </button>
                    ) : (
                      <button
                        onClick={() => { commitResponseEdit(); setIsEditingResponse(false); setShowPreview(true) }}
                        disabled={!generatedResponse}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-sm"
                      >
                        ✉ Send Reply
                      </button>
                    )
                  )}
                </div>
              </div>

              {generatedResponse ? (
                isEditingResponse ? (
                  <div
                    ref={responseEditRef}
                    contentEditable
                    suppressContentEditableWarning
                    onBlur={commitResponseEdit}
                    className="bg-white dark:bg-gray-900 border-2 border-green-400 dark:border-green-600 rounded-md p-4 max-h-64 overflow-y-auto text-gray-800 dark:text-gray-100 whitespace-pre-wrap prose prose-sm dark:prose-invert focus:outline-none focus:ring-2 focus:ring-green-500"
                  />
                ) : (
                  <div className="bg-gray-50 dark:bg-gray-700 rounded-md p-4 max-h-64 overflow-y-auto">
                    <div className="text-gray-800 dark:text-gray-100 whitespace-pre-wrap prose prose-sm dark:prose-invert" dangerouslySetInnerHTML={{ __html: generatedResponse }} />
                  </div>
                )
              ) : (
                <div className="text-gray-400 text-center py-8">
                  <p>Generated response will appear here</p>
                </div>
              )}
              {isEditingResponse && (
                <p className="mt-2 text-[11px] text-green-600 dark:text-green-400">✏️ Editing — click "Done" (or anywhere outside) to save your changes before sending.</p>
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
              {fdTicket?.id && botOutputSaysSpam(botNotes, generatedResponse) && (
                <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-600 flex items-center justify-between gap-2">
                  <span className="text-xs text-red-700 dark:text-red-400">🚫 The bot flagged this as spam — no reply needed.</span>
                  {(spamMarked || spamMarkedIds.includes(fdTicket.id)) ? (
                    <span className="shrink-0 px-3 py-1.5 rounded-md bg-red-100 dark:bg-red-800/50 text-red-700 dark:text-red-300 text-xs font-semibold whitespace-nowrap">✓ Marked spam</span>
                  ) : (
                    <button
                      onClick={() => markTicketSpam(fdTicket.id)}
                      disabled={markingSpam}
                      className="shrink-0 px-3 py-1.5 bg-red-600 hover:bg-red-700 disabled:bg-red-400 text-white text-xs font-semibold rounded-md transition-colors whitespace-nowrap"
                      title="Runs the Freshdesk SPAM scenario on this ticket"
                    >
                      {markingSpam ? 'Running…' : '🚫 Mark as Spam'}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

        </div>

        {/* Right Panel - Parsed & Sources */}
        <div className="space-y-6 min-w-0">
          {/* Live Queues panel */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md overflow-hidden">
            <div className="w-full flex items-center justify-between px-4 py-3">
              <button
                onClick={toggleQueues}
                className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-white"
              >
                <span className="text-gray-400">{queuesOpen ? '▲' : '▼'}</span>
                📥 Queues
                {queues && (
                  <span className="text-xs font-normal text-gray-400">
                    {Object.values(queues).reduce((s, l) => s + l.length, 0)} waiting
                  </span>
                )}
              </button>
              <button
                onClick={refreshQueues}
                disabled={queuesLoading}
                className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30 hover:bg-blue-100 dark:hover:bg-blue-900/50 rounded-md transition-colors disabled:opacity-50"
                title="Refresh the queues"
              >
                <span className={queuesLoading ? 'inline-block animate-spin' : ''}>↺</span> Refresh
              </button>
            </div>
            {queuesOpen && (
              <div className="border-t border-gray-100 dark:border-gray-700 p-2 space-y-1">
                {queuesLoading && !queues ? (
                  <p className="text-xs text-gray-400 text-center py-4">Loading queues…</p>
                ) : (
                  QUEUE_PLATFORMS.map(p => {
                    const list = (queues && queues[p]) || []
                    const isOpen = openQueuePlatforms[p]
                    return (
                      <div key={p} className="rounded-md bg-gray-50 dark:bg-gray-700/40">
                        <button
                          onClick={() => setOpenQueuePlatforms(o => ({ ...o, [p]: !o[p] }))}
                          className="w-full flex items-center justify-between px-3 py-2 text-xs"
                        >
                          <span className="font-medium text-gray-700 dark:text-gray-200">{p}</span>
                          <span className="flex items-center gap-2">
                            <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${list.length > 0 ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300' : 'bg-gray-200 dark:bg-gray-600 text-gray-500 dark:text-gray-400'}`}>{list.length}</span>
                            <span className="text-gray-400">{isOpen ? '▲' : '▼'}</span>
                          </span>
                        </button>
                        {isOpen && (
                          <div className="px-2 pb-2 space-y-1 max-h-96 overflow-y-auto">
                            {list.length === 0 ? (
                              <p className="text-[11px] text-gray-400 px-1 py-1">No tickets waiting</p>
                            ) : list.map(t => (
                              <div key={t.id} className="flex items-center gap-2 p-2 rounded-md bg-white dark:bg-gray-800">
                                <div className="min-w-0 flex-1">
                                  <p className="text-xs font-medium text-gray-800 dark:text-gray-200 truncate">#{t.id} {t.subject}</p>
                                  <p className="text-[11px] text-gray-400 flex flex-wrap items-center gap-1">
                                    {t.waiting_on === 'us' ? (
                                      <span className="px-1.5 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 font-medium">Customer responded</span>
                                    ) : (
                                      <span className="px-1.5 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400">Agent responded</span>
                                    )}
                                    <span className="px-1.5 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400">{t.status}</span>
                                    <span className={t.hours_since_update >= 48 ? 'text-red-500 font-semibold' : t.hours_since_update >= 24 ? 'text-amber-500' : ''}>
                                      {t.hours_since_update != null ? `${t.hours_since_update}h ago` : ''}
                                    </span>
                                  </p>
                                </div>
                                <button
                                  onClick={() => loadFlaggedTicket(t.url)}
                                  className="shrink-0 px-2 py-1 text-[11px] font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors"
                                >
                                  Load
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })
                )}
              </div>
            )}
          </div>
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
                  {cmsInfo?.payment_handler && (
                    <div className="bg-gray-50 dark:bg-gray-700/60 rounded-md px-3 py-2">
                      <label className="block text-xs font-semibold text-gray-400 dark:text-gray-400 uppercase tracking-wide">Payment Handler <span className="text-green-500 normal-case">(CMS)</span></label>
                      <p className="mt-0.5 text-sm text-gray-900 dark:text-gray-100 font-medium">{cmsInfo.payment_handler}</p>
                    </div>
                  )}
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
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Reply to customer (ticket #{fdTicket?.id})</p>
                  <span className="text-[11px] text-blue-500 dark:text-blue-400">✏️ Click the text to edit before sending</span>
                </div>
                <div
                  ref={previewEditRef}
                  contentEditable
                  suppressContentEditableWarning
                  onBlur={() => { if (previewEditRef.current) setGeneratedResponse(previewEditRef.current.innerHTML) }}
                  className="bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg p-4 text-sm text-gray-800 dark:text-gray-100 whitespace-pre-wrap prose prose-sm dark:prose-invert focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
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
                  <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-700 rounded-lg p-4 text-xs text-gray-700 dark:text-gray-300" dangerouslySetInnerHTML={{ __html: buildCmsNote(cmsInfo) }} />
                </div>
              )}
            </div>
            <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-gray-200 dark:border-gray-700">
              <label className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 cursor-pointer select-none" title="The bot writes/updates the ticket summary in Freshdesk after sending. It never overwrites a summary written by a person.">
                <input
                  type="checkbox"
                  checked={updateSummary}
                  onChange={toggleUpdateSummary}
                  className="rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-400"
                />
                📝 Update ticket summary
              </label>
              <div className="flex items-center gap-3">
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
        </div>
      )}
    {showContactModal && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl p-6 w-full max-w-md mx-4">
          <h2 className="text-base font-bold text-gray-800 dark:text-white mb-4">Update ticket contact</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
            Enter the real user information. This will update the requester on the Freshdesk ticket.
          </p>
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Full name</label>
              <input
                type="text"
                value={contactForm.name}
                onChange={e => setContactForm(f => ({ ...f, name: e.target.value }))}
                placeholder="David Teeter"
                className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Email</label>
              <input
                type="email"
                value={contactForm.email}
                onChange={e => setContactForm(f => ({ ...f, email: e.target.value }))}
                placeholder="user@example.com"
                className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            {contactError && <p className="text-xs text-red-500">{contactError}</p>}
          </div>
          <div className="flex justify-end gap-2 mt-5">
            <button
              onClick={() => { setShowContactModal(false); setContactError('') }}
              className="px-4 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={saveContact}
              disabled={contactSaving || !contactForm.name.trim() || !contactForm.email.trim()}
              className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-medium transition-colors"
            >
              {contactSaving ? 'Saving...' : 'Update contact'}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  )
}
