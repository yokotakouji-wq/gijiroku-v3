'use client'

import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react'
import { upload } from '@vercel/blob/client'

// ── Types ──────────────────────────────────────────────────────────────────
type Phase =
  | 'idle'
  | 'recording'
  | 'uploading'
  | 'transcribing'
  | 'extracting'
  | 'generating'
  | 'preview'
  | 'error'

type ActiveTab = 'detailed' | 'summary'
type BlockStatus =
  | 'streaming'     // ストリーミング中（将来用）
  | 'formatting'    // Gemini整文中
  | 'formatted'     // 整文完了・人間の確認待ち
  | 'format_failed' // Gemini整文失敗・原文表示
  | 'confirmed'     // 人間が確認OK済み
  | 'excluded'      // 人間が議事録から除外

interface Info {
  name: string; dateStart: string; dateEnd: string
  place: string; facil: string; sec: string; att: string
}

interface Agenda  { title: string; discussion: string }
interface Todo    { task: string; assignee: string; deadline: string }
interface Minutes {
  summary: string
  agenda_items: Agenda[]
  decisions: string[]
  unresolved_items?: string[]
  todos: Todo[]
  next_meeting: string
  inferred_attendees?: string
}

interface Block {
  id: string
  start: number
  end: number
  sec: number
  orig: string
  text: string
  status: BlockStatus
  include: boolean
  important: boolean
  memo: string
}

type ChunkStatus = 'pending' | 'uploading' | 'transcribing' | 'done' | 'error'

interface AudioChunk {
  index: number
  startedAt: number
  endedAt: number
  durationSec: number
  blob: Blob
  url: string | null
  transcript: string | null
  status: ChunkStatus
  error?: string
}

// ── Utils ──────────────────────────────────────────────────────────────────
const CHUNK_DURATION_MS = 5 * 60 * 1000  // 5分ごとにチャンクを切り替え

const LIVE_INTERVALS = [
  { l: '30秒', v: 30 },
  { l: '1分',  v: 60 },
  { l: '2分',  v: 120 },
  { l: '5分',  v: 300 },
] as const

// 開発環境限定のモック文字起こしデータ
const isMockAvailable = process.env.NODE_ENV === 'development'

const MOCK_TEXTS = [
  '本日はお集まりいただきありがとうございます。',
  '先週の議事確認から始めます。売上目標の達成率は87%でした。',
  'マーケティング施策について、来月のキャンペーンを重点的に検討することになりました。',
  '次のスプリントでは認証機能とUIの改善を優先して対応します。担当は田中さんです。',
  'デザインレビューは来週火曜日14時に設定しましょう。場所は第3会議室です。',
  'バグ修正の優先度について、クリティカルなものは先週中に対応完了しています。',
  'リリース日は5月末を目標にしています。テスト工程は2週間を予定しています。',
  '次回会議は2週間後の同じ時間で調整します。議題は進捗確認と新機能のデモです。',
]

const PH = '（録音から自動入力されます）'
const pad = (n: number) => String(n).padStart(2, '0')
const fmtLocal = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
const fmtDT = (v: string) =>
  v ? new Date(v).toLocaleString('ja-JP', { year:'numeric', month:'long', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '—'
const fmtT = (v: string) =>
  v ? new Date(v).toLocaleString('ja-JP', { hour:'2-digit', minute:'2-digit' }) : ''
const fmtSec = (s: number) => `${pad(Math.floor(s/60))}:${pad(s%60)}`

const isDebug =
  process.env.NODE_ENV === 'development' &&
  process.env.NEXT_PUBLIC_DEBUG_MINUTES === 'true'

function getMimeType() {
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) return t
  }
  return 'audio/mp4'
}

// バックエンド maxDuration(300s) より少し長めに設定して、サーバー側を先に失敗させる
const FETCH_TIMEOUT_MS = 330_000

const DRAFT_VERSION = 1

async function fetchWithTimeout(url: string, opts: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, { ...opts, signal: controller.signal })
  } finally {
    clearTimeout(id)
  }
}

// ── Main Component ─────────────────────────────────────────────────────────
export default function App() {
  // ── Existing state ──────────────────────────────────────────────────────
  const [phase, setPhase]     = useState<Phase>('idle')
  const [info, setInfo]       = useState<Info>({
    name: '', dateStart: fmtLocal(new Date()), dateEnd: '',
    place: '', facil: '', sec: '', att: '',
  })
  const [recSec, setRecSec]   = useState(0)
  const [procStep, setProcStep] = useState('')
  const [detailedMinutes, setDetailedMinutes] = useState<Minutes | null>(null)
  const [summaryMinutes, setSummaryMinutes]   = useState<Minutes | null>(null)
  const [activeTab, setActiveTab] = useState<ActiveTab>('detailed')
  const [isEditing, setIsEditing] = useState(false)
  const [editBuf, setEditBuf]   = useState<Minutes | null>(null)
  const [errMsg, setErrMsg]     = useState('')
  const [blobUrl, setBlobUrl]   = useState('')
  const [inferredAtt, setInferredAtt] = useState('')
  const [chunkProgress, setChunkProgress] = useState<{ current: number; total: number } | null>(null)
  const [uploadProgress, setUploadProgress] = useState(0)
  // debug
  const [dbgTranscript, setDbgTranscript]   = useState('')
  const [dbgStructured, setDbgStructured]   = useState<any>(null)
  // regenerate
  const [additionalInstruction, setAdditionalInstruction] = useState('')
  const [isRegenerating, setIsRegenerating] = useState(false)
  const [regenErr, setRegenErr] = useState('')
  const [prevDetailed, setPrevDetailed] = useState<Minutes | null>(null)
  const [prevSummary, setPrevSummary]   = useState<Minutes | null>(null)

  // ── Draft save/load state ───────────────────────────────────────────────
  const [draftMsg, setDraftMsg] = useState('')
  const [draftErr, setDraftErr] = useState('')
  const [draftDragOver, setDraftDragOver] = useState(false)

  // ── Mock / WS error state ───────────────────────────────────────────────
  const [mockMode, setMockMode] = useState(false)
  const [wsError, setWsError]   = useState('')

  // ── Live transcription state ────────────────────────────────────────────
  const [liveBlocks, setLiveBlocks] = useState<Block[]>([])
  const [liveBuf, setLiveBuf]       = useState('')
  const [liveInterim, setLiveInterim] = useState('')
  const [liveBufStart, setLiveBufStart] = useState(0)
  const [liveInterval, setLiveInterval] = useState(120)
  const [wsConnected, setWsConnected] = useState(false)
  const [memoOpen, setMemoOpen]     = useState<Record<string, boolean>>({})
  const [activeBlockId, setActiveBlockId] = useState<string | null>(null)
  const [timerKey, setTimerKey]     = useState(0)

  // ── Existing refs ───────────────────────────────────────────────────────
  const mrRef        = useRef<MediaRecorder | null>(null)
  const chunksRef    = useRef<Blob[]>([])
  const timerRef     = useRef<ReturnType<typeof setInterval> | null>(null)
  const startWall    = useRef(0)
  const lastBlobRef  = useRef<{ blob: Blob; mimeType: string } | null>(null)

  // ── Chunk recording refs ────────────────────────────────────────────────
  const audioChunksRef    = useRef<AudioChunk[]>([])
  const chunkIndexRef     = useRef(0)
  const isRotatingRef     = useRef(false)
  const recordingStreamRef = useRef<MediaStream | null>(null)
  const chunkIntervalRef  = useRef<ReturnType<typeof setInterval> | null>(null)
  const chunkMimeTypeRef  = useRef('')
  const chunkStartedAtRef = useRef(0)

  // ── Live transcription refs ─────────────────────────────────────────────
  const wsRef          = useRef<WebSocket | null>(null)
  const liveMrRef      = useRef<MediaRecorder | null>(null)
  const blockTimerRef  = useRef<ReturnType<typeof setInterval> | null>(null)
  const prevBlockTextRef = useRef<string>('')  // 直前ブロックのorigテキスト（Geminiへの文脈用）
  const mockTimerRef   = useRef<ReturnType<typeof setInterval> | null>(null)
  const liveBufRef     = useRef('')
  const liveBufStartRef = useRef(0)
  const liveIntervalRef = useRef(120)
  const liveEndSentinelRef  = useRef<HTMLDivElement>(null)
  const recordingBarRef     = useRef<HTMLDivElement>(null)
  const blockIdRef          = useRef(0)
  const liveBlocksRef       = useRef<Block[]>([])
  const draftFileRef        = useRef<HTMLInputElement>(null)
  const liveScrollAtRef     = useRef(0)
  const liveScrollTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null)
  const liveHadTextRef      = useRef(false)
  const lastFocusBlurRef    = useRef(0)      // 入力要素からblurした時刻(ms)
  const autoFollowPausedRef = useRef(false)  // 手動スクロール後、自動追従を停止するフラグ

  liveIntervalRef.current  = liveInterval
  liveBlocksRef.current    = liveBlocks

  const setField = (k: keyof Info) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setInfo(p => ({ ...p, [k]: e.target.value }))

  function isFocusedOnInput(): boolean {
    const el = document.activeElement
    if (!el || el === document.body) return false
    const tag = el.tagName.toLowerCase()
    return tag === 'input' || tag === 'textarea' || tag === 'select'
      || (el as HTMLElement).isContentEditable
  }

  function fixedBottomOffset() {
    return phase === 'recording' ? (recordingBarRef.current?.offsetHeight ?? 0) : 0
  }

  function scrollLiveTranscriptToLatest(smooth = true) {
    if (isFocusedOnInput() || Date.now() - lastFocusBlurRef.current < 1500) return
    if (autoFollowPausedRef.current) return
    const sentinel = liveEndSentinelRef.current
    if (!sentinel) return
    const rect = sentinel.getBoundingClientRect()
    const absoluteY = window.scrollY + rect.top
    const anchorY = window.innerHeight * 0.70 - fixedBottomOffset()
    const targetY = Math.max(0, absoluteY - anchorY)
    window.scrollTo({ top: targetY, behavior: smooth ? 'smooth' : 'auto' })
  }

  function scrollLiveTranscriptAfterPaint() {
    if (liveScrollTimerRef.current) {
      clearTimeout(liveScrollTimerRef.current)
      liveScrollTimerRef.current = null
    }
    liveScrollAtRef.current = Date.now()
    requestAnimationFrame(() => {
      requestAnimationFrame(() => scrollLiveTranscriptToLatest(true))
    })
    setTimeout(() => scrollLiveTranscriptToLatest(true), 80)
  }

  function scheduleLiveTranscriptScroll() {
    if (liveScrollTimerRef.current) return
    const now = Date.now()
    const wait = Math.max(0, 600 - (now - liveScrollAtRef.current))
    liveScrollTimerRef.current = setTimeout(() => {
      liveScrollTimerRef.current = null
      liveScrollAtRef.current = Date.now()
      scrollLiveTranscriptToLatest(true)
    }, wait)
  }

  // 入力要素からblurした時刻を記録（自動スクロール抑制用）
  useEffect(() => {
    function onFocusableBlur(e: FocusEvent) {
      const el = e.target as HTMLElement
      if (!el) return
      const tag = el.tagName.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable) {
        lastFocusBlurRef.current = Date.now()
      }
    }
    document.addEventListener('blur', onFocusableBlur, true)
    return () => document.removeEventListener('blur', onFocusableBlur, true)
  }, [])

  // 手動スクロール検出 — ユーザーがスクロールしたら自動追従をオフ（「ライブ文字起こしに戻る」で再開）
  useEffect(() => {
    function pauseAutoFollow() {
      autoFollowPausedRef.current = true
    }
    function onKeyDown(e: KeyboardEvent) {
      if (isFocusedOnInput()) return  // 入力フォーカス中は対象外
      const keys = ['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', ' ', 'Home', 'End']
      if (keys.includes(e.key)) pauseAutoFollow()
    }
    window.addEventListener('wheel',     pauseAutoFollow, { passive: true })
    window.addEventListener('touchmove', pauseAutoFollow, { passive: true })
    window.addEventListener('keydown',   onKeyDown)
    return () => {
      window.removeEventListener('wheel',     pauseAutoFollow)
      window.removeEventListener('touchmove', pauseAutoFollow)
      window.removeEventListener('keydown',   onKeyDown)
    }
  }, [])

  useEffect(() => {
    if (phase !== 'recording') {
      liveHadTextRef.current = false
      return
    }
    const hasLiveText = !!(liveBuf || liveInterim)
    if (hasLiveText && !liveHadTextRef.current) {
      liveHadTextRef.current = true
      scrollLiveTranscriptAfterPaint()
      return
    }
    liveHadTextRef.current = hasLiveText
    scheduleLiveTranscriptScroll()
    return () => {
      if (liveScrollTimerRef.current) {
        clearTimeout(liveScrollTimerRef.current)
        liveScrollTimerRef.current = null
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, liveBlocks.length, liveBuf, liveInterim])

  // ── Gemini整文（seal時・再試行時の共通処理）───────────────────────────────
  const formatBlock = useCallback((id: string, text: string, contextText?: string) => {
    setLiveBlocks(prev => prev.map(b =>
      b.id === id ? { ...b, status: 'formatting' } : b
    ))
    fetch('/api/gemini-format', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, context: contextText || undefined }),
    })
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(({ formatted }: { formatted: string }) => {
        setLiveBlocks(prev => prev.map(b =>
          b.id === id && b.status === 'formatting'
            ? { ...b, text: formatted || text, status: 'formatted' }
            : b
        ))
      })
      .catch(() => {
        setLiveBlocks(prev => prev.map(b =>
          b.id === id && b.status === 'formatting'
            ? { ...b, status: 'format_failed' }
            : b
        ))
      })
  }, [])

  // ── Seal current buffer into a block ────────────────────────────────────
  const seal = useCallback(() => {
    const t = liveBufRef.current.trim()
    if (!t) return

    // 直前ブロックのorigテキストを文脈として取得し、次回用に更新
    const contextText = prevBlockTextRef.current
    prevBlockTextRef.current = t

    const id = `b${++blockIdRef.current}`
    const endSec = Math.floor((Date.now() - startWall.current) / 1000)
    const block: Block = {
      id,
      start:     liveBufStartRef.current,
      end:       endSec,
      sec:       liveIntervalRef.current,
      orig:      t,
      text:      t,
      status:    'formatting',
      include:   true,
      important: false,
      memo:      '',
    }
    liveBufRef.current      = ''
    liveBufStartRef.current = endSec
    setLiveBuf('')
    setLiveInterim('')
    setLiveBufStart(endSec)
    setLiveBlocks(prev => [...prev, block])
    // Page-level live transcript scrolling is handled after React commits the new content.

    formatBlock(id, t, contextText || undefined)
  }, [formatBlock])

  // ── Block interval timer ─────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== 'recording') {
      if (blockTimerRef.current) { clearInterval(blockTimerRef.current); blockTimerRef.current = null }
      return
    }
    blockTimerRef.current = setInterval(seal, liveInterval * 1000)
    return () => {
      if (blockTimerRef.current) { clearInterval(blockTimerRef.current); blockTimerRef.current = null }
    }
  }, [phase, liveInterval, timerKey, seal])

  // ── Recording ───────────────────────────────────────────────────────────
  async function startRec() {
    // Reset live state
    setLiveBlocks([])
    setLiveBuf('')
    setLiveInterim('')
    setLiveBufStart(0)
    setActiveBlockId(null)
    setMemoOpen({})
    setTimerKey(0)
    setWsConnected(false)
    setWsError('')
    setBlobUrl('')
    liveBufRef.current      = ''
    liveBufStartRef.current = 0
    blockIdRef.current      = 0
    liveScrollAtRef.current = 0
    liveHadTextRef.current  = false
    if (liveScrollTimerRef.current) {
      clearTimeout(liveScrollTimerRef.current)
      liveScrollTimerRef.current = null
    }

    // Reset chunk state
    audioChunksRef.current = []
    chunkIndexRef.current  = 0
    isRotatingRef.current  = false
    setChunkProgress(null)

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      recordingStreamRef.current = stream
      const mimeType = getMimeType()
      chunkMimeTypeRef.current = mimeType

      startChunkRecorder(stream, mimeType)

      // 5分ごとにチャンクを切り替え
      chunkIntervalRef.current = setInterval(() => rotateChunk(), CHUNK_DURATION_MS)

      startWall.current = Date.now()
      setInfo(p => ({ ...p, dateStart: fmtLocal(new Date()) }))
      setPhase('recording')
      setRecSec(0)
      timerRef.current = setInterval(
        () => setRecSec(Math.floor((Date.now() - startWall.current) / 1000)), 500
      )

      // Deepgram WebSocket or mock (ベストエフォート — 失敗してもパイプラインは動く)
      if (isMockAvailable && mockMode) {
        connectMockTranscription()
      } else {
        connectDeepgramWS(stream)
      }
    } catch {
      setErrMsg('マイクへのアクセスが許可されていません。ブラウザの設定を確認してください。')
      setPhase('error')
    }
  }

  function startChunkRecorder(stream: MediaStream, mimeType: string) {
    const index = chunkIndexRef.current++
    chunksRef.current = []
    chunkStartedAtRef.current = Date.now()

    console.log(`[chunk] recorder #${index} starting at ${new Date().toISOString()}`)

    const mr = new MediaRecorder(stream, { mimeType })
    mr.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data) }
    mr.onstop = () => {
      const endedAt = Date.now()
      const startedAt = chunkStartedAtRef.current
      const durationSec = Math.round((endedAt - startedAt) / 1000)

      console.log(`[chunk] recorder #${index} stopped — duration: ${durationSec}s, data-chunks: ${chunksRef.current.length}`)

      const blob = new Blob(chunksRef.current, { type: mimeType })
      console.log(`[chunk] blob #${index} size: ${blob.size} bytes`)

      const chunk: AudioChunk = {
        index, startedAt, endedAt, durationSec,
        blob, url: null, transcript: null, status: 'pending',
      }
      audioChunksRef.current.push(chunk)

      if (isRotatingRef.current) {
        isRotatingRef.current = false
        console.log(`[chunk] rotating — starting recorder #${chunkIndexRef.current}`)
        startChunkRecorder(stream, mimeType)
      } else {
        console.log(`[chunk] final stop — total chunks: ${audioChunksRef.current.length}, stopping stream`)
        stream.getTracks().forEach(t => t.stop())
        recordingStreamRef.current = null
        processAllChunks(mimeType)
      }
    }
    mr.start(1000)
    mrRef.current = mr
  }

  function rotateChunk() {
    if (mrRef.current?.state !== 'recording') return
    console.log(`[chunk] rotate triggered at ${new Date().toISOString()} — stopping recorder #${chunkIndexRef.current - 1}`)
    isRotatingRef.current = true
    mrRef.current.stop()
  }

  async function connectDeepgramWS(stream: MediaStream) {
    try {
      console.log('[Deepgram] fetching temporary token...')
      const tokenRes = await fetch(`/api/deepgram-token?t=${Date.now()}`, { cache: 'no-store' })
      console.log('[Deepgram] token fetch status:', tokenRes.status)
      if (!tokenRes.ok) {
        const data = await tokenRes.json().catch(() => ({}))
        console.error('[Deepgram] token fetch failed:', data.error)
        setWsError(data.error || 'Deepgram一時トークンの発行に失敗しました。Member以上の権限を持つAPIキーを設定してください。')
        return
      }
      const { token, expiresIn } = await tokenRes.json()
      console.log('[Deepgram] token received:', Boolean(token), 'expiresIn:', expiresIn)

      if (!token) {
        console.error('[Deepgram] token is empty or undefined')
        setWsError('Deepgram一時トークンが空です。APIキーの権限を確認してください。')
        return
      }

      // JWTのexpを検証して期限切れなら接続しない
      try {
        const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
        const expMs = payload.exp * 1000
        const nowMs = Date.now()
        console.log('[Deepgram] token exp:', new Date(expMs).toISOString(), '/ now:', new Date(nowMs).toISOString())
        if (expMs <= nowMs) {
          console.error('[Deepgram] token is already expired')
          setWsError('Deepgram一時トークンが期限切れです。再度お試しください。')
          return
        }
      } catch {
        // JWTデコード失敗は無視して接続を試みる
      }

      // 認証情報はURLに載せず、Sec-WebSocket-Protocol ヘッダーで渡す（Deepgram公式推奨）
      // new WebSocket(url, ["token", token]) → Sec-WebSocket-Protocol: token, <token>
      const params = new URLSearchParams({
        model:            'nova-3',
        language:         'ja',
        smart_format:     'true',
        punctuate:        'true',
        interim_results:  'true',
        endpointing:      '500',
        utterance_end_ms: '1000',
      })
      const url = `wss://api.deepgram.com/v1/listen?${params}`
      console.log('[Deepgram] connecting via Sec-WebSocket-Protocol subprotocol auth')
      const ws = new WebSocket(url, ['bearer', token])
      wsRef.current = ws
      console.log('[Deepgram] ws readyState after new:', ws.readyState)

      ws.onopen = () => {
        console.log('[Deepgram] ws open')
        setWsConnected(true)
        const mime = typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus' : 'audio/webm'
        const liveMr = new MediaRecorder(stream, { mimeType: mime })
        liveMrRef.current = liveMr
        liveMr.ondataavailable = e => {
          if (ws.readyState === WebSocket.OPEN && e.data.size > 0) ws.send(e.data)
        }
        liveMr.start(250)
      }

      ws.onmessage = e => {
        let data: any
        try { data = JSON.parse(e.data) } catch { return }
        if (data.type !== 'Results') return
        const transcript: string = data.channel?.alternatives?.[0]?.transcript ?? ''
        if (data.is_final && transcript) {
          liveBufRef.current = liveBufRef.current ? `${liveBufRef.current}　${transcript}` : transcript
          setLiveBuf(liveBufRef.current)
          setLiveInterim('')
        } else if (!data.is_final && transcript) {
          setLiveInterim(transcript)
        }
      }

      ws.onerror = (event) => {
        console.error('[Deepgram] ws error event — readyState:', ws.readyState)
        console.log('[Deepgram] debug — tokenReceived:', Boolean(token), 'expiresIn:', expiresIn)
        setWsConnected(false)
      }
      ws.onclose = (event) => {
        console.log('[Deepgram] ws close — code:', event.code, 'reason:', event.reason || '(empty)', 'wasClean:', event.wasClean)
        console.log('[Deepgram] debug — tokenReceived:', Boolean(token), 'expiresIn:', expiresIn, 'readyState:', ws.readyState)
        if (event.code === 1006) {
          console.warn('[Deepgram] code 1006: 異常切断 — Sec-WebSocket-Protocol 不一致または認証失敗の可能性があります')
        }
        setWsConnected(false)
      }
    } catch (e) {
      console.error('[Deepgram] unexpected error:', e)
      setWsError('Deepgramへの接続に失敗しました。')
    }
  }

  function connectMockTranscription() {
    setWsConnected(true)
    let idx = 0
    mockTimerRef.current = setInterval(() => {
      const text = MOCK_TEXTS[idx % MOCK_TEXTS.length]
      idx++
      liveBufRef.current = liveBufRef.current ? `${liveBufRef.current}　${text}` : text
      setLiveBuf(liveBufRef.current)
    }, 3000)
  }

  function stopRec() {
    if (timerRef.current) clearInterval(timerRef.current)
    if (blockTimerRef.current) { clearInterval(blockTimerRef.current); blockTimerRef.current = null }
    if (mockTimerRef.current) { clearInterval(mockTimerRef.current); mockTimerRef.current = null }
    // チャンクローテーションを止める（これ以上の分割はしない）
    if (chunkIntervalRef.current) { clearInterval(chunkIntervalRef.current); chunkIntervalRef.current = null }

    const dur = Date.now() - startWall.current
    const end = new Date(new Date(info.dateStart).getTime() + dur)
    setInfo(p => ({ ...p, dateEnd: fmtLocal(end) }))

    // 残りバッファをシール
    seal()

    // ライブ MediaRecorder / WebSocket を停止
    if (liveMrRef.current?.state === 'recording') liveMrRef.current.stop()
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.close()
    setWsConnected(false)

    // メイン MediaRecorder 停止 → onstop → processAllChunks
    // isRotatingRef を false にして、次の onstop を「最終停止」として扱う
    isRotatingRef.current = false
    if (mrRef.current?.state === 'recording') mrRef.current.stop()
  }

  // ── Pipeline ────────────────────────────────────────────────────────────
  async function processAllChunks(mimeType: string) {
    const chunks = audioChunksRef.current
    const total = chunks.length

    console.log(`[pipeline] processAllChunks — total chunks: ${total}`)
    setChunkProgress({ current: 0, total })

    const ext = mimeType.includes('mp4') ? 'm4a' : 'webm'
    const transcripts: string[] = []

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      const label = `チャンク ${i + 1}/${total}`

      // Upload
      setPhase('uploading')
      setProcStep(`${label} をアップロード中… 画面を閉じないでください`)
      setUploadProgress(0)
      chunk.status = 'uploading'

      const filename = `audio/meeting-${Date.now()}-chunk${chunk.index}.${ext}`
      console.log(`[pipeline] uploading ${label} — ${chunk.durationSec}s, ${chunk.blob.size} bytes`)

      try {
        const url = await uploadAudioBlob(chunk.blob, filename, mimeType, setUploadProgress)
        chunk.url = url
        console.log(`[pipeline] upload ok ${label} — ${url}`)
      } catch (e: any) {
        chunk.status = 'error'
        chunk.error = e.message
        console.error(`[pipeline] upload failed ${label}:`, e.message)
        setErrMsg(`${label} のアップロードに失敗しました: ${e.message}`)
        setPhase('error')
        return
      }

      // Transcribe
      setPhase('transcribing')
      setProcStep(`${label} を文字起こし中… (Deepgram Nova-3)`)
      chunk.status = 'transcribing'
      console.log(`[pipeline] transcribing ${label}`)

      try {
        const txRes = await fetchWithTimeout('/api/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: chunk.url }),
        })
        if (!txRes.ok) throw new Error((await txRes.json()).error || '文字起こし失敗')
        const { transcript } = await txRes.json()
        chunk.transcript = transcript
        chunk.status = 'done'
        transcripts.push(transcript)
        setChunkProgress({ current: i + 1, total })
        console.log(`[pipeline] transcribe ok ${label} — ${transcript.length} chars`)
      } catch (e: any) {
        chunk.status = 'error'
        chunk.error = e.message
        console.error(`[pipeline] transcribe failed ${label}:`, e.message)
        setErrMsg(`${label} の文字起こしに失敗しました: ${e.message}`)
        setPhase('error')
        return
      }
    }

    // Blob を一括削除（ベストエフォート）
    const urlsToDelete = chunks.filter(c => c.url).map(c => c.url!)
    if (urlsToDelete.length > 0) {
      fetch('/api/delete-audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: urlsToDelete }),
      }).catch(e => {
        console.warn('[pipeline] blob deletion failed (best effort):', e.message)
        urlsToDelete.forEach(u => console.warn('[pipeline] failed to delete blob:', u))
      })
    }

    // Deepgram 生テキストを保険として組み立て（チャンク境界マーカー付き）
    const fmtChunkTime = (ms: number) => {
      const totalSec = Math.round(ms / 1000)
      return `${pad(Math.floor(totalSec / 60))}:${pad(totalSec % 60)}`
    }
    const origin = chunks[0]?.startedAt ?? 0
    const rawTranscript = chunks.map((c, i) => {
      const from = fmtChunkTime(c.startedAt - origin)
      const to   = fmtChunkTime(c.endedAt   - origin)
      const header = `--- チャンク ${i + 1} / ${total}（${from}〜${to}） ---`
      return `${header}\n${c.transcript ?? ''}`
    }).join('\n\n')

    console.log(`[pipeline] Deepgram raw transcript — ${rawTranscript.length} chars (保険用)`)

    // liveBlocks を主入力として構築（確認済み・未確認どちらも include: true なら対象）
    const allBlocks = liveBlocksRef.current
    const includedBlocks  = allBlocks.filter(b => b.include)
    const confirmedBlocks = allBlocks.filter(b => b.status === 'confirmed')
    const excludedBlocks  = allBlocks.filter(b => !b.include)

    console.log(
      `[pipeline] liveBlocks状態 — 全${allBlocks.length}件:` +
      ` 確認済み=${confirmedBlocks.length}件,` +
      ` 未確認（include:true）=${includedBlocks.length - confirmedBlocks.length}件,` +
      ` 除外=${excludedBlocks.length}件`
    )

    const liveBlocksTranscript = buildLiveBlocksTranscript(allBlocks)

    let transcriptForExtract: string
    if (liveBlocksTranscript.trim().length > 0) {
      transcriptForExtract = liveBlocksTranscript
      console.log(
        `[pipeline] Sonnet入力: liveBlocks由来 — ${transcriptForExtract.length} chars, ` +
        `${includedBlocks.length}ブロック（確認済み・未確認どちらも含む、除外のみ省く）`
      )
    } else {
      transcriptForExtract = rawTranscript
      console.warn('[pipeline] liveBlocksが空または全除外 — Deepgram生テキストにフォールバック')
      console.log(`[pipeline] Sonnet入力: Deepgram生テキスト — ${transcriptForExtract.length} chars`)
    }

    setDbgTranscript(transcriptForExtract)
    await runFromExtract(transcriptForExtract)
  }

  function buildLiveBlocksTranscript(blocks: Block[]): string {
    const included = blocks.filter(b => b.include)
    if (included.length === 0) return ''
    return included.map(b => {
      const text = (b.text?.trim()) || (b.orig?.trim()) || ''
      if (!text) return null
      return `[${fmtSec(b.start)}〜${fmtSec(b.end)}]\n${text}`
    }).filter(Boolean).join('\n\n')
  }

  async function retryProcessing() {
    if (audioChunksRef.current.length === 0) return
    // アップロード済みチャンクは URL が残っているが再アップロードする（シンプルな再試行）
    audioChunksRef.current.forEach(c => {
      c.status = 'pending'
      c.url = null
      c.transcript = null
      c.error = undefined
    })
    setErrMsg('')
    await processAllChunks(chunkMimeTypeRef.current)
  }

  async function retryFromExtract() {
    if (!dbgTranscript) return
    setErrMsg('')
    await runFromExtract(dbgTranscript)
  }

  async function runFromExtract(transcript: string) {
    // 1. Extract structured data
    let structured: any
    try {
      setPhase('extracting')
      setProcStep('内容を整理中… (構造化抽出)')
      const exRes = await fetchWithTimeout('/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript, meetingInfo: info }),
      })
      if (!exRes.ok) throw new Error((await exRes.json()).error || '構造化抽出に失敗しました')
      ;({ structured } = await exRes.json())
      setDbgStructured(structured)
    } catch (e: any) {
      setErrMsg(`構造化抽出に失敗しました: ${e.message} — 「構造化・議事録を再試行」を押してください。`)
      setPhase('error')
      return
    }

    // 2. Generate detailed + summary
    try {
      setPhase('generating')
      setProcStep('詳細版・要約版を生成中… (Claude)')
      const genRes = await fetchWithTimeout('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ structured, meetingInfo: info }),
      })
      if (!genRes.ok) throw new Error((await genRes.json()).error || '議事録生成に失敗しました')
      const { detailed, summary } = await genRes.json()

      if (detailed.inferred_attendees && !info.att) setInferredAtt(detailed.inferred_attendees)

      setDetailedMinutes(detailed)
      setSummaryMinutes(summary)
      setActiveTab('detailed')
      setPhase('preview')
    } catch (e: any) {
      setErrMsg(`議事録生成に失敗しました: ${e.message} — 「構造化・議事録を再試行」を押してください。`)
      setPhase('error')
    }
  }

  // ── Editing ─────────────────────────────────────────────────────────────
  function startEdit() {
    const current = activeTab === 'detailed' ? detailedMinutes : summaryMinutes
    setEditBuf(JSON.parse(JSON.stringify(current)))
    setIsEditing(true)
  }
  function saveEdit() {
    if (activeTab === 'detailed') setDetailedMinutes(editBuf)
    else setSummaryMinutes(editBuf)
    setIsEditing(false)
  }
  function cancelEdit() { setEditBuf(null); setIsEditing(false) }

  // ── Regenerate ──────────────────────────────────────────────────────────
  async function regenerate() {
    if (!dbgStructured) return
    setPrevDetailed(detailedMinutes)
    setPrevSummary(summaryMinutes)
    setIsRegenerating(true)
    setRegenErr('')
    setIsEditing(false)
    setEditBuf(null)
    try {
      const genRes = await fetchWithTimeout('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          structured: dbgStructured,
          meetingInfo: info,
          transcript: dbgTranscript || undefined,
          additionalInstruction: additionalInstruction || undefined,
        }),
      })
      if (!genRes.ok) throw new Error((await genRes.json()).error || '再生成に失敗しました')
      const { detailed, summary } = await genRes.json()
      setDetailedMinutes(detailed)
      setSummaryMinutes(summary)
      setActiveTab('detailed')
    } catch (e: any) {
      setRegenErr(e.message)
    } finally {
      setIsRegenerating(false)
    }
  }

  function updEdit<K extends keyof Minutes>(k: K, v: Minutes[K]) {
    setEditBuf(p => p ? { ...p, [k]: v } : null)
  }
  function updAgenda(i: number, field: keyof Agenda, v: string) {
    setEditBuf(p => { if (!p) return null; const a = [...p.agenda_items]; a[i] = { ...a[i], [field]: v }; return { ...p, agenda_items: a } })
  }
  function updTodo(i: number, field: keyof Todo, v: string) {
    setEditBuf(p => { if (!p) return null; const t = [...p.todos]; t[i] = { ...t[i], [field]: v }; return { ...p, todos: t } })
  }
  function updDecision(i: number, v: string) {
    setEditBuf(p => { if (!p) return null; const d = [...p.decisions]; d[i] = v; return { ...p, decisions: d } })
  }
  function updUnresolved(i: number, v: string) {
    setEditBuf(p => { if (!p) return null; const u = [...(p.unresolved_items ?? [])]; u[i] = v; return { ...p, unresolved_items: u } })
  }

  // ── Word Download ────────────────────────────────────────────────────────
  async function downloadDocx() {
    const docx = (window as any).docx
    const m = isEditing ? editBuf : (activeTab === 'detailed' ? detailedMinutes : summaryMinutes)
    if (!docx || !m) { alert('docx ライブラリが読み込まれていません'); return }
    const {
      Document, Paragraph, TextRun, Table, TableRow, TableCell,
      WidthType, AlignmentType, Packer,
    } = docx

    const blue = '185FA5', gray = '4A4540', white = 'FFFFFF'
    const tabLabel = activeTab === 'detailed' ? '詳細版' : '要約版'
    const today = new Date().toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' })

    const sanitize = (s: string) =>
      s.replace(/[/\\:*?"<>|\n\r]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 50)
    const baseName = info.name
      ? `${sanitize(info.name)}_議事録_${tabLabel}`
      : `議事録_${tabLabel}`

    const ch: any[] = []

    const titleText = info.name ? `${info.name}　議事録` : '議事録'
    ch.push(new Paragraph({
      children: [new TextRun({ text: titleText, bold: true, size: 44, color: '1A1714' })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 100, before: 200 },
    }))
    ch.push(new Paragraph({
      children: [new TextRun({ text: tabLabel, size: 22, color: '9CA3AF' })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 360 },
    }))

    const dateStr = info.dateStart
      ? fmtDT(info.dateStart) + (info.dateEnd ? ' 〜 ' + fmtT(info.dateEnd) : '')
      : ''
    const metaRows: [string, string][] = []
    metaRows.push(['開催日時', dateStr])
    if (info.place) metaRows.push(['開催場所', info.place])
    if (info.facil) metaRows.push(['司会',     info.facil])
    metaRows.push(['書記',   info.sec || ''])
    metaRows.push(['出席者', info.att || ''])
    metaRows.push(['作成日', today])
    metaRows.push(['版区分', tabLabel])

    ch.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: metaRows.map(([k, v]) => new TableRow({ children: [
        new TableCell({
          width: { size: 20, type: WidthType.PERCENTAGE },
          children: [new Paragraph({ children: [new TextRun({ text: k, bold: true, size: 20, color: blue })] })],
          margins: { top: 80, bottom: 80, left: 100, right: 100 },
        }),
        new TableCell({
          width: { size: 80, type: WidthType.PERCENTAGE },
          children: [new Paragraph({ children: [new TextRun({ text: v, size: 20 })] })],
          margins: { top: 80, bottom: 80, left: 100, right: 100 },
        }),
      ]})),
    }))
    ch.push(new Paragraph({ text: '', spacing: { after: 300 } }))

    const secTitle = (t: string) => new Paragraph({
      children: [new TextRun({ text: t, bold: true, size: 26, color: blue })],
      spacing: { before: 320, after: 120 },
    })

    const spacer = () => new Paragraph({ text: '', spacing: { after: 160 } })

    function textToParas(
      text: string,
      opts: { size?: number; color?: string; leftIndent?: number } = {}
    ): any[] {
      const { size = 21, color = gray, leftIndent = 0 } = opts
      const paras: any[] = []
      for (const line of text.split('\n')) {
        if (!line.trim()) {
          paras.push(new Paragraph({ text: '', spacing: { after: 60 } }))
          continue
        }
        const bulletMatch = line.match(/^([・\-*])\s*(.+)$/)
        if (bulletMatch) {
          paras.push(new Paragraph({
            children: [new TextRun({ text: '• ' + bulletMatch[2], size, color })],
            spacing: { after: 60 },
            indent: { left: leftIndent + 280 },
          }))
        } else {
          paras.push(new Paragraph({
            children: [new TextRun({ text: line, size, color })],
            spacing: { after: 80 },
            ...(leftIndent ? { indent: { left: leftIndent } } : {}),
          }))
        }
      }
      return paras.length ? paras : [new Paragraph({ text: '' })]
    }

    if (m.summary) {
      ch.push(secTitle('■ 会議の概要'))
      ch.push(...textToParas(m.summary))
      ch.push(spacer())
    }

    if (m.agenda_items?.length) {
      ch.push(secTitle('■ 議題・議論内容'))
      m.agenda_items.forEach((a, i) => {
        ch.push(new Paragraph({
          children: [new TextRun({ text: `${i + 1}. ${a.title}`, bold: true, size: 23 })],
          spacing: { before: 180, after: 80 },
        }))
        ch.push(...textToParas(a.discussion, { leftIndent: 280 }))
        ch.push(spacer())
      })
    }

    if (m.decisions?.length) {
      ch.push(secTitle('■ 決定事項'))
      m.decisions.forEach(d =>
        ch.push(new Paragraph({
          children: [new TextRun({ text: '• ' + d, size: 21 })],
          spacing: { after: 60 },
          indent: { left: 200 },
        }))
      )
      ch.push(spacer())
    }

    if (m.unresolved_items?.length) {
      ch.push(secTitle('■ 未決事項・検討事項'))
      m.unresolved_items.forEach(u =>
        ch.push(new Paragraph({
          children: [new TextRun({ text: '• ' + u, size: 21 })],
          spacing: { after: 60 },
          indent: { left: 200 },
        }))
      )
      ch.push(spacer())
    }

    if (m.todos?.length) {
      ch.push(secTitle('■ TODO・アクションアイテム'))
      ch.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({ children: ['タスク内容', '担当者', '期限'].map(h => new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, size: 20, color: white })] })],
            shading: { fill: blue },
            margins: { top: 80, bottom: 80, left: 100, right: 100 },
          })) }),
          ...m.todos.map(t => new TableRow({ children: [t.task, t.assignee, t.deadline || '—'].map(v => new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: v, size: 20 })] })],
            margins: { top: 80, bottom: 80, left: 100, right: 100 },
          })) })),
        ],
      }))
      ch.push(spacer())
    }

    if (m.next_meeting) {
      ch.push(secTitle('■ 次回会議'))
      ch.push(...textToParas(m.next_meeting))
    }

    const doc = new Document({
      sections: [{
        properties: { page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
        children: ch,
      }],
    })
    const blob = await Packer.toBlob(doc)
    const objUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = objUrl
    a.download = `${baseName}.docx`
    a.click()
    URL.revokeObjectURL(objUrl)
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  const isProc = (['transcribing', 'extracting', 'generating'] as Phase[]).includes(phase)
  const currentMinutes = activeTab === 'detailed' ? detailedMinutes : summaryMinutes
  const displayMin = isEditing ? editBuf : currentMinutes

  // Live helpers
  const toConfirm     = liveBlocks.filter(b => b.status === 'formatted' || b.status === 'format_failed').length
  const confirmed     = liveBlocks.filter(b => b.status === 'confirmed').length
  const anyFormatting = liveBlocks.some(b => b.status === 'formatting')

  function updateBlock(id: string, u: Partial<Block>) {
    setLiveBlocks(prev => prev.map(b => b.id === id ? { ...b, ...u } : b))
  }

  function toLatest() {
    autoFollowPausedRef.current = false  // 自動追従を再開
    lastFocusBlurRef.current = 0         // blur後抑制も解除（直前クリックのblurを無視）
    scrollLiveTranscriptToLatest(true)
  }

  function toNextUnchecked() {
    const next = liveBlocks.find(b => b.status === 'formatted' || b.status === 'format_failed')
    if (next) {
      setActiveBlockId(next.id)
      document.getElementById(next.id)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }

  function cutNow() {
    seal()
    setTimerKey(k => k + 1)
  }

  // Live transcript follow position is controlled by the sentinel at the page-flow tail.

  function resetToIdle() {
    setPhase('idle')
    setDetailedMinutes(null)
    setSummaryMinutes(null)
    setDbgTranscript('')
    setDbgStructured(null)
    setIsEditing(false)
    setEditBuf(null)
    setAdditionalInstruction('')
    setIsRegenerating(false)
    setRegenErr('')
    setPrevDetailed(null)
    setPrevSummary(null)
    setWsError('')
    setBlobUrl('')
    setChunkProgress(null)
    audioChunksRef.current = []
    if (mockTimerRef.current) { clearInterval(mockTimerRef.current); mockTimerRef.current = null }
    if (chunkIntervalRef.current) { clearInterval(chunkIntervalRef.current); chunkIntervalRef.current = null }
    // Reset live state
    setLiveBlocks([])
    setLiveBuf('')
    setLiveInterim('')
    setActiveBlockId(null)
    setMemoOpen({})
  }

  // ── Draft save/load ─────────────────────────────────────────────────────
  function saveDraft() {
    if (!detailedMinutes && !summaryMinutes) return
    const now = new Date()
    const p2 = (n: number) => String(n).padStart(2, '0')
    const dateStr = `${now.getFullYear()}${p2(now.getMonth()+1)}${p2(now.getDate())}_${p2(now.getHours())}${p2(now.getMinutes())}`
    const san = (s: string) => s.replace(/[/\\:*?"<>|\n\r]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 30)
    const fileName = info.name
      ? `議事録下書き_${san(info.name)}_${dateStr}.json`
      : `議事録下書き_${dateStr}.json`

    const draft = {
      version: DRAFT_VERSION,
      savedAt: now.toISOString(),
      info,
      transcript: dbgTranscript,
      liveBlocks,
      detailedMinutes,
      summaryMinutes,
      activeTab,
    }

    const blob = new Blob([JSON.stringify(draft, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    a.click()
    URL.revokeObjectURL(url)
    setDraftMsg('下書きを保存しました。別の日に開いてWordを作成できます。')
    setTimeout(() => setDraftMsg(''), 5000)
  }

  function processDraftFile(file: File) {
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const draft = JSON.parse(ev.target?.result as string)
        if (!draft || typeof draft !== 'object') throw new Error()
        if (draft.version !== DRAFT_VERSION) throw new Error()
        if (!draft.info || typeof draft.info !== 'object') throw new Error()
        if (!draft.detailedMinutes && !draft.summaryMinutes) throw new Error()
        setInfo(draft.info)
        setDbgTranscript(typeof draft.transcript === 'string' ? draft.transcript : '')
        setLiveBlocks(Array.isArray(draft.liveBlocks) ? draft.liveBlocks : [])
        setDetailedMinutes(draft.detailedMinutes ?? null)
        setSummaryMinutes(draft.summaryMinutes ?? null)
        setActiveTab(draft.activeTab === 'summary' ? 'summary' : 'detailed')
        setIsEditing(false)
        setEditBuf(null)
        setErrMsg('')
        setPhase('preview')
        setDraftErr('')
        setDraftMsg('下書きを読み込みました。内容を確認して編集できます。')
        setTimeout(() => setDraftMsg(''), 5000)
      } catch {
        setDraftErr('下書きファイルを読み込めませんでした。ファイルの形式を確認してください。')
        setTimeout(() => setDraftErr(''), 5000)
      }
    }
    reader.readAsText(file)
  }

  function loadDraftFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    processDraftFile(file)
  }

  function handleDraftDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDraftDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (!file) return
    processDraftFile(file)
  }

  function renderPreviewCard() {
    if (phase !== 'preview' || !displayMin) return null

    return (
      <div style={{ background:'#fff', border:'0.5px solid #e8e8e8', borderRadius:12, overflow:'hidden', marginTop:10 }}>

        {/* Tabs */}
        <div style={{ display:'flex', borderBottom:'0.5px solid #e8e8e8' }}>
          {(['detailed', 'summary'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => { setActiveTab(tab); setIsEditing(false); setEditBuf(null) }}
              style={{
                padding: '10px 24px',
                fontSize: 12,
                fontWeight: activeTab === tab ? 600 : 400,
                color: activeTab === tab ? '#1a56db' : '#6b7280',
                background: 'none',
                border: 'none',
                borderBottom: activeTab === tab ? '2px solid #1a56db' : '2px solid transparent',
                cursor: 'pointer',
                fontFamily: 'inherit',
                transition: 'color .15s',
              }}
            >
              {tab === 'detailed' ? '詳細版' : '要約版'}
            </button>
          ))}
          <div style={{ flex:1, borderBottom:'2px solid transparent' }}/>
        </div>

        {/* Preview header */}
        <div style={{ padding:'12px 18px', borderBottom:'0.5px solid #e8e8e8', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <span style={{ fontSize:13, fontWeight:500, color:'#374151' }}>
            議事録プレビュー
            <span style={{ fontSize:11, color:'#9ca3af', marginLeft:6 }}>
              ({activeTab === 'detailed' ? '詳細版' : '要約版'})
            </span>
          </span>
          {!isEditing ? (
            <button onClick={startEdit} style={{ fontSize:12, color:'#1a56db', background:'none', border:'none', cursor:'pointer' }}>
              ✏️ 編集する
            </button>
          ) : (
            <div style={{ display:'flex', gap:8, alignItems:'center' }}>
              <button onClick={cancelEdit} style={{ fontSize:12, color:'#6b7280', background:'none', border:'none', cursor:'pointer' }}>
                キャンセル
              </button>
              <button onClick={saveEdit} style={{ fontSize:12, color:'white', background:'#1a56db', border:'none', borderRadius:6, padding:'5px 14px', cursor:'pointer', fontWeight:500 }}>
                ✓ 保存
              </button>
            </div>
          )}
        </div>

        {/* Minutes body */}
        <div style={{ padding:'18px' }}>
          {/* Summary */}
          <Section title="会議の概要">
            {isEditing ? (
              <textarea value={editBuf?.summary || ''} onChange={e => updEdit('summary', e.target.value)}
                style={{ ...taStyle, minHeight:80 }}/>
            ) : (
              <p style={{ fontSize:12, lineHeight:1.85, color:'#4b5563', background:'#f0fdf4', border:'0.5px solid #bbf7d0', borderRadius:7, padding:'10px 12px' }}>{displayMin.summary}</p>
            )}
          </Section>

          {/* Agenda */}
          {(displayMin.agenda_items?.length > 0 || isEditing) && (
            <Section title="議題・議論内容">
              {displayMin.agenda_items?.map((a, i) => (
                <div key={i} style={{ background:'#f9fafb', border:'0.5px solid #e8e8e8', borderRadius:8, padding:'10px 12px', marginBottom:6 }}>
                  {isEditing ? (
                    <>
                      <input value={editBuf!.agenda_items[i].title} onChange={e => updAgenda(i, 'title', e.target.value)}
                        style={{ ...inputStyle, fontWeight:500, marginBottom:6 }} placeholder="議題タイトル"/>
                      <textarea value={editBuf!.agenda_items[i].discussion} onChange={e => updAgenda(i, 'discussion', e.target.value)}
                        style={{ ...taStyle, minHeight:60 }} placeholder="議論内容"/>
                    </>
                  ) : (
                    <>
                      <div style={{ fontSize:12, fontWeight:600, marginBottom:4 }}>{i+1}. {a.title}</div>
                      <div style={{ fontSize:12, color:'#6b7280', lineHeight:1.75, whiteSpace:'pre-wrap' }}>{a.discussion}</div>
                    </>
                  )}
                </div>
              ))}
              {isEditing && (
                <button onClick={() => updEdit('agenda_items', [...(editBuf?.agenda_items||[]), { title:'', discussion:'' }])}
                  style={addBtnStyle}>+ 議題を追加</button>
              )}
            </Section>
          )}

          {/* Decisions */}
          {(displayMin.decisions?.length > 0 || isEditing) && (
            <Section title="決定事項">
              {displayMin.decisions?.map((d, i) => (
                <div key={i} style={{ display:'flex', gap:6, marginBottom:5, alignItems:'flex-start' }}>
                  {isEditing ? (
                    <>
                      <textarea value={editBuf!.decisions[i]} onChange={e => updDecision(i, e.target.value)}
                        style={{ ...taStyle, minHeight:40, flex:1 }}/>
                      <button onClick={() => updEdit('decisions', (editBuf?.decisions||[]).filter((_,j)=>j!==i))}
                        style={delBtnStyle}>✕</button>
                    </>
                  ) : (
                    <div style={{ fontSize:12, padding:'6px 10px', borderLeft:'2px solid #93c5fd', background:'#eff6ff', flex:1, lineHeight:1.7 }}>・{d}</div>
                  )}
                </div>
              ))}
              {isEditing && (
                <button onClick={() => updEdit('decisions', [...(editBuf?.decisions||[]), ''])}
                  style={addBtnStyle}>+ 決定事項を追加</button>
              )}
            </Section>
          )}

          {/* Unresolved */}
          {((displayMin.unresolved_items?.length ?? 0) > 0 || isEditing) && (
            <Section title="未決事項・検討事項">
              {displayMin.unresolved_items?.map((u, i) => (
                <div key={i} style={{ display:'flex', gap:6, marginBottom:5, alignItems:'flex-start' }}>
                  {isEditing ? (
                    <>
                      <textarea value={editBuf!.unresolved_items?.[i] ?? ''} onChange={e => updUnresolved(i, e.target.value)}
                        style={{ ...taStyle, minHeight:40, flex:1 }}/>
                      <button onClick={() => updEdit('unresolved_items', (editBuf?.unresolved_items||[]).filter((_,j)=>j!==i))}
                        style={delBtnStyle}>✕</button>
                    </>
                  ) : (
                    <div style={{ fontSize:12, padding:'6px 10px', borderLeft:'2px solid #fde68a', background:'#fffbeb', flex:1, lineHeight:1.7 }}>・{u}</div>
                  )}
                </div>
              ))}
              {isEditing && (
                <button onClick={() => updEdit('unresolved_items', [...(editBuf?.unresolved_items||[]), ''])}
                  style={addBtnStyle}>+ 未決事項を追加</button>
              )}
            </Section>
          )}

          {/* TODOs */}
          {(displayMin.todos?.length > 0 || isEditing) && (
            <Section title="TODO・アクションアイテム">
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                <thead>
                  <tr>{['タスク内容', '担当者', '期限'].map(h => (
                    <th key={h} style={{ background:'#1a56db', color:'white', padding:'7px 10px', textAlign:'left', fontWeight:500 }}>{h}</th>
                  ))}</tr>
                </thead>
                <tbody>
                  {displayMin.todos?.map((t, i) => (
                    <tr key={i} style={{ background: i % 2 === 0 ? '#fff' : '#f9fafb' }}>
                      {isEditing ? (
                        <>
                          {(['task', 'assignee', 'deadline'] as const).map(f => (
                            <td key={f} style={tdStyle}>
                              <input value={(editBuf?.todos[i] as any)[f]} onChange={e => updTodo(i, f, e.target.value)}
                                style={{ ...inputStyle, padding:'4px 6px' }} placeholder={f === 'deadline' ? '例: 5/15' : ''}/>
                            </td>
                          ))}
                        </>
                      ) : (
                        <>
                          <td style={tdStyle}>{t.task}</td>
                          <td style={tdStyle}>{t.assignee}</td>
                          <td style={tdStyle}>{t.deadline || '—'}</td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
              {isEditing && (
                <button onClick={() => updEdit('todos', [...(editBuf?.todos||[]), { task:'', assignee:'', deadline:'' }])}
                  style={{ ...addBtnStyle, marginTop:6 }}>+ 行を追加</button>
              )}
            </Section>
          )}

          {/* Next meeting */}
          {(displayMin.next_meeting || isEditing) && (
            <Section title="次回会議">
              {isEditing ? (
                <input value={editBuf?.next_meeting || ''} onChange={e => updEdit('next_meeting', e.target.value)}
                  style={inputStyle} placeholder="例: 6月10日 15:00〜 会議室A"/>
              ) : (
                <p style={{ fontSize:12, color:'#4b5563', background:'#f0fdf4', border:'0.5px solid #bbf7d0', borderRadius:7, padding:'9px 12px' }}>{displayMin.next_meeting}</p>
              )}
            </Section>
          )}
        </div>

        {/* Action bar */}
        <div style={{ padding:'13px 18px', borderTop:'0.5px solid #e8e8e8', background:'#f9fafb', display:'flex', justifyContent:'space-between', alignItems:'center', gap:10, flexWrap:'wrap' }}>
          <p style={{ fontSize:11, color:'#9ca3af' }}>Word出力後も編集・再出力できます</p>
          <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
            <Btn onClick={() => { resetToIdle(); setBlobUrl('') }}>最初から</Btn>
            <Btn onClick={saveDraft}>下書きを保存</Btn>
            <Btn accent onClick={downloadDocx}>Word (.docx) 出力</Btn>
          </div>
        </div>
      </div>
    )
  }

  function renderRegenerateSection() {
    if (phase !== 'preview') return null

    return (
      <div style={{ marginTop:10, background:'#fff', border:'0.5px solid #e8e8e8', borderRadius:12, padding:'16px 18px' }}>
        <label style={{ display:'block', fontSize:12, fontWeight:500, color:'#374151', marginBottom:8 }}>
          追加指示（任意）
        </label>
        <textarea
          value={additionalInstruction}
          onChange={e => setAdditionalInstruction(e.target.value)}
          placeholder="例：もっと詳しく／決定事項だけまとめて／カンファレンス形式に変えて"
          rows={3}
          style={{ ...taStyle, marginBottom:10 }}
          disabled={isRegenerating}
        />
        {regenErr && (
          <div style={{ ...errBoxStyle, marginBottom:10 }}>再生成に失敗しました: {regenErr}</div>
        )}
        <div style={{ display:'flex', justifyContent:'flex-end', alignItems:'center', gap:12 }}>
          {isRegenerating && (
            <span style={{ fontSize:11, color:'#6b7280', display:'flex', alignItems:'center', gap:6 }}>
              <span style={{ width:12, height:12, borderRadius:'50%', border:'1.5px solid #e5e7eb', borderTopColor:'#1a56db', display:'inline-block', animation:'spin .7s linear infinite' }}/>
              再生成中…
            </span>
          )}
          <button
            onClick={regenerate}
            disabled={isRegenerating}
            style={{
              padding:'9px 20px', borderRadius:8, border:'none',
              fontFamily:'inherit', fontSize:12, fontWeight:500,
              background: isRegenerating ? '#9ca3af' : '#1a56db',
              color:'white', cursor: isRegenerating ? 'not-allowed' : 'pointer',
              transition:'background .15s',
            }}
          >
            再生成
          </button>
        </div>
      </div>
    )
  }

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <>
      <style>{`
        *{box-sizing:border-box;margin:0;padding:0}
        body{background:#f1f5f9}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.55}}
        input,textarea{font-family:inherit;font-size:13px}
        input::placeholder,textarea::placeholder{color:#b0bec5}
        textarea{resize:vertical;line-height:1.7}
        ::-webkit-scrollbar{width:4px}
        ::-webkit-scrollbar-thumb{background:#ddd;border-radius:2px}
        .idle-grid{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);gap:18px}
        @media(max-width:660px){.idle-grid{grid-template-columns:1fr}}
      `}</style>

      {/* ── Header ── */}
      <header style={{ background:'#fff', borderBottom:'0.5px solid #e8e8e8', padding:'10px 18px', display:'flex', alignItems:'center', gap:10, position:'sticky', top:0, zIndex:10 }}>
        <img
          src="/gijiroku-logo-icon.png"
          alt="議事録メーカー"
          style={{ width:42, height:42, objectFit:'contain', display:'block', flexShrink:0 }}
        />
        <img
          src="/gijiroku-logo-wordmark.png"
          alt="議事録メーカー"
          style={{ height:32, width:'auto', maxWidth:220, objectFit:'contain', display:'block', flexShrink:0 }}
        />
        <div style={{ flex:1 }} />
      </header>

      <main style={{ maxWidth: 1040, margin:'0 auto', padding: phase === 'idle' ? '22px 24px 40px' : '22px 32px 28px' }}>

        {/* ── Draft messages ── */}
        {draftMsg && (
          <div style={{ background:'#f0fdf4', border:'0.5px solid #86efac', borderRadius:9, padding:'10px 14px', marginBottom:10, fontSize:12, color:'#166534', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <span>{draftMsg}</span>
            <button onClick={() => setDraftMsg('')} style={{ background:'none', border:'none', color:'#166534', cursor:'pointer', padding:'0 0 0 10px', fontSize:14 }}>✕</button>
          </div>
        )}
        {draftErr && (
          <div style={{ background:'#fef2f2', border:'0.5px solid #fca5a5', borderRadius:9, padding:'10px 14px', marginBottom:10, fontSize:12, color:'#991b1b', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <span>{draftErr}</span>
            <button onClick={() => setDraftErr('')} style={{ background:'none', border:'none', color:'#991b1b', cursor:'pointer', padding:'0 0 0 10px', fontSize:14 }}>✕</button>
          </div>
        )}

        {/* ── Idle: 2-column layout ── */}
        {phase === 'idle' && (
          <div className="idle-grid">
            {/* ── Main card (left) ── */}
            <div style={{ background:'#fff', border:'1px solid #e2e8f0', borderRadius:26, padding:'36px 38px 32px', display:'flex', flexDirection:'column' }}>
              {/* Badge */}
              <div style={{ display:'inline-flex', alignItems:'center', gap:5, background:'#ecfeff', border:'1px solid #cffafe', borderRadius:999, padding:'4px 12px 4px 9px', fontSize:11.5, fontWeight:500, color:'#0e7490', marginBottom:18, width:'fit-content' }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
                会議情報は録音の前後いつでも追記できます
              </div>
              {/* Title */}
              <h2 style={{ fontSize:26, fontWeight:600, letterSpacing:'-0.03em', lineHeight:1.42, color:'#0f172a', marginBottom:10 }}>
                会議を録音して、<br/>議事録を作成
              </h2>
              {/* Description */}
              <p style={{ fontSize:13.5, color:'#64748b', lineHeight:1.7, marginBottom:28 }}>
                まず録音を始めて、必要な情報はあとから整えられます。
              </p>
              {/* Recording button */}
              <button onClick={startRec} style={idleStartBtnStyle}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink:0 }}>
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                  <line x1="12" y1="19" x2="12" y2="23"/>
                  <line x1="8" y1="23" x2="16" y2="23"/>
                </svg>
                録音開始
              </button>
              <p style={{ textAlign:'center', fontSize:11.5, color:'#b0bec5', marginTop:9, marginBottom:26 }}>
                タップするだけで録音が始まります
              </p>
              {/* Divider */}
              <hr style={{ border:'none', borderTop:'1px solid #f1f5f9', marginBottom:22 }}/>
              {/* Steps */}
              <div style={{ display:'flex' }}>
                {[
                  { num:'1', label:'録音する',   sub:'会議をそのまま記録',  on:true  },
                  { num:'2', label:'AIで整える', sub:'逐語録を読みやすく',  on:false },
                  { num:'3', label:'Wordで出力', sub:'提出しやすい形式へ',  on:false },
                ].map((s, i) => (
                  <div key={s.num} style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', textAlign:'center', position:'relative' }}>
                    {i < 2 && <div style={{ position:'absolute', top:12, left:'50%', width:'100%', height:1, background:'#e8edf2' }}/>}
                    <div style={{ width:24, height:24, borderRadius:'50%', display:'flex', alignItems:'center', justifyContent:'center', fontSize:11, fontWeight:600, position:'relative', zIndex:1, marginBottom:7, background:s.on?'#0891b2':'#fff', color:s.on?'#fff':'#94a3b8', border:s.on?'none':'1px solid #e2e8f0' }}>{s.num}</div>
                    <div style={{ fontSize:12, fontWeight:500, color:'#64748b' }}>{s.label}</div>
                    <div style={{ fontSize:11, color:'#b0bec5', marginTop:2, lineHeight:1.5 }}>{s.sub}</div>
                  </div>
                ))}
              </div>
              {isMockAvailable && (
                <label style={{ display:'flex', alignItems:'center', gap:6, fontSize:11, color:'#9b59b6', cursor:'pointer', background:'#f5f0ff', border:'0.5px solid #d8b4fe', borderRadius:6, padding:'5px 10px', marginTop:16 }}>
                  <input type="checkbox" checked={mockMode} onChange={e => setMockMode(e.target.checked)} style={{ accentColor:'#9b59b6', cursor:'pointer' }}/>
                  [DEV] モックモード（Deepgram接続なし・UIテスト用）
                </label>
              )}
            </div>
            {/* ── Sidebar (right) ── */}
            <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
              <MeetingInfoCard info={info} setField={setField} phase={phase} />
              <DraftPanel
                draftDragOver={draftDragOver}
                onDragOver={e => { e.preventDefault(); setDraftDragOver(true) }}
                onDragLeave={() => setDraftDragOver(false)}
                onDrop={handleDraftDrop}
                onOpenFile={() => draftFileRef.current?.click()}
              />
            </div>
          </div>
        )}

        {/* ── Recording Card (non-idle) ── */}
        {phase !== 'idle' && (
        <Card>
          {phase === 'recording' && (
            <div style={{ padding:'26px 34px', display:'flex', alignItems:'center', justifyContent:'space-between', gap:32 }}>
              {/* 左: rec-dot + タイマー + ライブバッジ */}
              <div style={{ display:'flex', alignItems:'center', gap:28 }}>
                <div>
                  <div style={{ display:'flex', alignItems:'center', gap:9, marginBottom:6 }}>
                    <span style={{ width:9, height:9, borderRadius:'50%', background:'#ef4444', flexShrink:0, display:'inline-block', animation:'pulse 1.4s ease-in-out infinite' }}/>
                    <span style={{ fontSize:12.5, fontWeight:600, color:'#ef4444', letterSpacing:'0.04em' }}>録音中</span>
                  </div>
                  <div style={{ fontSize:38, fontWeight:300, color:'#0f172a', letterSpacing:'-0.04em', fontVariantNumeric:'tabular-nums', lineHeight:1 }}>
                    {fmtSec(recSec)}
                  </div>
                </div>
                <div style={{ display:'inline-flex', alignItems:'center', gap:6, background:'#ecfeff', border:'1px solid #cffafe', borderRadius:999, padding:'5px 13px 5px 10px', fontSize:12, fontWeight:500, color:'#0e7490' }}>
                  <span style={{ width:7, height:7, borderRadius:'50%', background:'#0891b2', flexShrink:0, display:'inline-block', animation:'pulse 1.6s ease-in-out infinite' }}/>
                  {(isMockAvailable && mockMode) ? 'モック（DEV）' : wsConnected ? 'ライブ文字起こし中' : wsError ? 'Deepgram 接続失敗' : '接続中…'}
                </div>
              </div>
              {/* 右: 停止ボタン */}
              <button onClick={stopRec} style={{ display:'flex', alignItems:'center', gap:9, background:'#fff', border:'1.5px solid #e2e8f0', borderRadius:14, padding:'14px 26px', fontSize:15, fontWeight:600, color:'#475569', cursor:'pointer', fontFamily:'inherit', flexShrink:0 }}>
                <span style={{ width:13, height:13, borderRadius:3, background:'#94a3b8', flexShrink:0, display:'inline-block' }}/>
                録音を停止する
              </button>
            </div>
          )}

          {phase === 'uploading' && (
            <div style={{ padding:'40px 20px', display:'flex', flexDirection:'column', alignItems:'center', gap:18 }}>
              <div style={{ width:38, height:38, borderRadius:'50%', border:'2.5px solid #e5e7eb', borderTopColor:'#1a56db', animation:'spin .7s linear infinite' }}/>
              <div style={{ textAlign:'center', width:'100%', maxWidth:280 }}>
                <div style={{ fontSize:13, fontWeight:500, marginBottom:10 }}>{procStep}</div>
                <div style={{ background:'#e5e7eb', borderRadius:4, height:6, width:'100%', overflow:'hidden', marginBottom:6 }}>
                  <div style={{ height:'100%', background:'#1a56db', borderRadius:4, width:`${uploadProgress}%`, transition:'width .3s' }}/>
                </div>
                <div style={{ fontSize:11, color:'#6b7280' }}>{uploadProgress}%</div>
                {chunkProgress && chunkProgress.total > 1 && (
                  <div style={{ fontSize:11, color:'#9ca3af', marginTop:6 }}>
                    音声チャンク {chunkProgress.current + 1} / {chunkProgress.total}
                  </div>
                )}
              </div>
            </div>
          )}

          {isProc && (
            <div style={{ padding:'40px 20px', display:'flex', flexDirection:'column', alignItems:'center', gap:18 }}>
              <div style={{ width:38, height:38, borderRadius:'50%', border:'2.5px solid #e5e7eb', borderTopColor:'#1a56db', animation:'spin .7s linear infinite' }}/>
              <div style={{ textAlign:'center' }}>
                <div style={{ fontSize:13, fontWeight:500, marginBottom:10 }}>{procStep}</div>
                <ProcBar phase={phase}/>
                {chunkProgress && chunkProgress.total > 1 && phase === 'transcribing' && (
                  <div style={{ fontSize:11, color:'#9ca3af', marginTop:8 }}>
                    文字起こし済み {chunkProgress.current} / {chunkProgress.total} チャンク
                  </div>
                )}
              </div>
            </div>
          )}

          {phase === 'preview' && (
            <div style={{ padding:'12px 18px', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
              <div style={{ display:'flex', alignItems:'center', gap:7 }}>
                <span style={{ display:'inline-block', width:8, height:8, borderRadius:'50%', background:'#16a34a' }}/>
                <span style={{ fontSize:12, color:'#16a34a', fontWeight:500 }}>議事録が作成されました</span>
              </div>
              <button onClick={startRec} style={{ fontSize:11, color:'#1a56db', background:'none', border:'none', cursor:'pointer', padding:'4px 8px' }}>
                ＋ 再録音
              </button>
            </div>
          )}

          {phase === 'error' && (
            <div style={{ padding:'20px' }}>
              <div style={errBoxStyle}>{errMsg}</div>
              <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
                <Btn onClick={() => { resetToIdle(); setErrMsg('') }}>最初から</Btn>
                {audioChunksRef.current.length > 0 && (
                  <Btn accent onClick={retryProcessing}>チャンク処理を再試行</Btn>
                )}
                {dbgTranscript && (
                  <Btn accent onClick={retryFromExtract}>構造化・議事録を再試行</Btn>
                )}
              </div>
            </div>
          )}
        </Card>
        )}

        {/* ── Meeting Info Card (non-idle) ── */}
        {phase !== 'idle' && <div style={{ marginTop:8 }}><MeetingInfoCard info={info} setField={setField} phase={phase} /></div>}


        {/* ── 確認メモ（注意書き） ── */}
        <div style={{ marginTop:16, padding:'11px 16px', borderTop:'1px solid #e8edf2', display:'flex', alignItems:'flex-start', gap:9 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink:0, marginTop:2 }}>
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <div style={{ fontSize:11.5, color:'#94a3b8', lineHeight:1.75 }}>
            <strong style={{ fontWeight:500, color:'#64748b' }}>提出前の確認をお願いします。</strong>
            固有名詞・数値・決定事項はAIが誤認識する場合があります。
          </div>
        </div>

        {/* ── Inferred attendees banner ── */}
        {inferredAtt && (
          <div style={{ background:'#fffbeb', border:'0.5px solid #fcd34d', borderRadius:9, padding:'10px 14px', display:'flex', alignItems:'center', justifyContent:'space-between', marginTop:10, gap:10 }}>
            <span style={{ fontSize:11, color:'#92400e' }}>文字起こしから推測: <strong>{inferredAtt}</strong></span>
            <div style={{ display:'flex', gap:6, flexShrink:0 }}>
              <button onClick={() => { setInfo(p => ({ ...p, att: inferredAtt })); setInferredAtt('') }}
                style={{ fontSize:11, background:'#f59e0b', color:'white', border:'none', borderRadius:5, padding:'4px 10px', cursor:'pointer', fontWeight:500 }}>
                出席者に反映
              </button>
              <button onClick={() => setInferredAtt('')} style={{ fontSize:11, color:'#92400e', background:'none', border:'none', cursor:'pointer' }}>✕</button>
            </div>
          </div>
        )}

        {renderPreviewCard()}

        {renderRegenerateSection()}

        {/* ── ライブ校正セクション ── */}
        {(phase === 'recording' || liveBlocks.length > 0) && (
          <div style={{ marginTop: 10 }}>

            {/* コントロールバー — 録音中のみ */}
            {phase === 'recording' && (
              <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 20, padding: '16px 24px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 0, flexWrap: 'wrap' }}>
                  {/* 確認間隔 */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingRight: 24 }}>
                    <span style={{ fontSize: 11.5, color: '#94a3b8', whiteSpace: 'nowrap' }}>確認間隔</span>
                    <div style={{ display: 'flex', border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden' }}>
                      {LIVE_INTERVALS.map((o, idx) => (
                        <button
                          key={o.v}
                          onClick={() => setLiveInterval(o.v)}
                          style={{
                            padding: '7px 13px', fontSize: 12.5, fontWeight: 500, cursor: 'pointer',
                            fontFamily: 'inherit', border: 'none',
                            borderRight: idx < LIVE_INTERVALS.length - 1 ? '1px solid #e2e8f0' : 'none',
                            background: liveInterval === o.v ? '#0891b2' : '#fff',
                            color: liveInterval === o.v ? '#fff' : '#64748b',
                            whiteSpace: 'nowrap',
                          }}
                        >{o.l}</button>
                      ))}
                    </div>
                  </div>
                  <div style={{ width: 1, height: 30, background: '#e2e8f0', flexShrink: 0 }}/>
                  {/* 今すぐ区切る */}
                  <div style={{ display: 'flex', alignItems: 'center', padding: '0 24px' }}>
                    <button
                      onClick={cutNow}
                      style={{ display: 'flex', alignItems: 'center', gap: 7, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: '7px 14px', fontSize: 12.5, fontWeight: 500, color: '#475569', cursor: 'pointer', fontFamily: 'inherit' }}
                    >
                      ✂ 今すぐ区切る
                    </button>
                  </div>
                  <div style={{ width: 1, height: 30, background: '#e2e8f0', flexShrink: 0 }}/>
                  {/* 接続状態 */}
                  <div style={{ display: 'flex', alignItems: 'center', paddingLeft: 24 }}>
                    <div style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                      borderRadius: 8, padding: '6px 12px', fontSize: 12, fontWeight: 500,
                      background: (isMockAvailable && mockMode) ? '#f5f0ff' : wsConnected ? '#f0fdf4' : wsError ? '#fef2f2' : '#f8fafc',
                      border: `1px solid ${(isMockAvailable && mockMode) ? '#d8b4fe' : wsConnected ? '#bbf7d0' : wsError ? '#fecaca' : '#e2e8f0'}`,
                      color: (isMockAvailable && mockMode) ? '#9b59b6' : wsConnected ? '#15803d' : wsError ? '#b91c1c' : '#94a3b8',
                    }}>
                      {wsConnected && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>}
                      {(isMockAvailable && mockMode) ? 'モック（DEV）' : wsConnected ? 'Deepgram 接続中' : wsError ? 'Deepgram 接続失敗' : '接続中…'}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* バナー + ナビゲーション — ブロックがある間は常に表示 */}
            <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 16, padding: '12px 20px', marginTop: phase === 'recording' ? 8 : 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                {/* 確認用テキストバナー */}
                <div style={{ padding: '5px 12px', borderRadius: 8, background: '#f0f9ff', border: '1px solid #bae6fd', fontSize: 11.5, color: '#0369a1' }}>
                  AI整文済みのテキストです。修正後「確認OK」を押してください
                </div>
                {/* ナビゲーション */}
                {liveBlocks.length > 0 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 11.5, color: '#6b7280', whiteSpace: 'nowrap' }}>
                      <span style={{ color: '#16a34a', fontWeight: 600 }}>✓ {confirmed}</span>{' '}確認済
                      <span style={{ color: toConfirm > 0 ? '#0891b2' : '#94a3b8', fontWeight: 600 }}>○ {toConfirm}</span>{' '}要確認
                    </span>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        onClick={toNextUnchecked}
                        disabled={toConfirm === 0}
                        style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, padding: '7px 14px', borderRadius: 9, cursor: toConfirm === 0 ? 'not-allowed' : 'pointer', fontFamily: 'inherit', border: '1px solid #e2e8f0', background: '#f8fafc', color: toConfirm === 0 ? '#d1d5db' : '#475569', whiteSpace: 'nowrap' }}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                        次の要確認へ {toConfirm > 0 && <span style={{ background: '#0891b2', color: '#fff', borderRadius: 8, padding: '1px 5px', fontSize: 10 }}>{toConfirm}</span>}
                      </button>
                      <button
                        onClick={toLatest}
                        style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, padding: '7px 14px', borderRadius: 9, cursor: 'pointer', fontFamily: 'inherit', border: '1px solid #e2e8f0', background: '#f8fafc', color: '#475569' }}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
                        ライブ文字起こしに戻る
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Deepgram接続エラー — 録音中のみ */}
            {phase === 'recording' && wsError && !(isMockAvailable && mockMode) && (
              <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '8px 16px', marginTop: 8, fontSize: 12, color: '#b91c1c' }}>
                {wsError}
              </div>
            )}

            {/* ブロック一覧 + ライブバッファ */}
            <div
              style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 8 }}
            >
              {/* 空の状態 — 録音中かつブロックなし */}
              {phase === 'recording' && liveBlocks.length === 0 && !liveBuf && !liveInterim && (
                <div style={{ textAlign: 'center', padding: '24px 20px', color: '#9ca3af', fontSize: 12, background: '#fff', border: '0.5px solid #e8e8e8', borderRadius: 10 }}>
                  {(isMockAvailable && mockMode)
                    ? 'モックモード — 3秒ごとにダミーテキストが追加されます'
                    : wsConnected
                      ? '音声を認識中…　話し始めると文字起こしが表示されます'
                      : 'ライブ文字起こしを接続中…'}
                </div>
              )}

              {/* ブロックカード */}
              {liveBlocks.map(blk => (
                <LiveBlockCard
                  key={blk.id}
                  block={blk}
                  isActive={activeBlockId === blk.id}
                  memoOpen={!!memoOpen[blk.id]}
                  onUpdate={updateBlock}
                  onToggleMemo={() => setMemoOpen(m => ({ ...m, [blk.id]: !m[blk.id] }))}
                  onRetryFormat={() => formatBlock(blk.id, blk.orig)}
                  onScrollToLatest={toLatest}
                  isRecording={phase === 'recording'}
                />
              ))}

              {/* ライブバッファ（現在の区間）— 録音中のみ */}
              {phase === 'recording' && (liveBuf || liveInterim) && (
                <div style={{
                  background: '#f0f9ff', border: '1px dashed #a5f3fc',
                  borderRadius: 16, padding: '14px 20px',
                }}>
                  <div style={{ fontSize: 11.5, color: '#0e7490', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: '#0891b2', animation: 'pulse 1.4s infinite', flexShrink: 0 }} />
                    {fmtSec(liveBufStart)} 〜 書き起こし中（最大 {liveInterval}秒）
                  </div>
                  <div style={{ fontSize: 13.5, color: '#334155', lineHeight: 1.9 }}>
                    {liveBuf && <span>{liveBuf}</span>}
                    {liveInterim && <span style={{ color: '#94a3b8' }}>{liveBuf ? '　' : ''}{liveInterim}</span>}
                  </div>
                </div>
              )}
              <div ref={liveEndSentinelRef} style={{ height: phase === 'recording' ? 1 : 0 }} />
              {phase === 'recording' && (
                <div aria-hidden="true" style={{ height: '56vh', flexShrink: 0 }} />
              )}
            </div>
          </div>
        )}

        {renderRegenerateSection()}

        {/* ── Debug sections ── */}
        {isDebug && dbgTranscript && (
          <DebugSection title="文字起こし全文" content={dbgTranscript} />
        )}
        {isDebug && dbgStructured && (
          <DebugSection title="構造化抽出結果" content={JSON.stringify(dbgStructured, null, 2)} />
        )}

      </main>

      {/* ── Fixed bottom recording bar (recording only) ── */}
      {phase === 'recording' && (
        <div ref={recordingBarRef} style={{
          position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 30,
          background: 'rgba(255,255,255,0.96)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          borderTop: '1px solid #e2e8f0',
          padding: '10px 24px',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14,
        }}>
          <span style={{
            fontSize: 15, fontWeight: 500, color: '#0f172a',
            fontVariantNumeric: 'tabular-nums', minWidth: 52, textAlign: 'center', letterSpacing: '-0.02em',
          }}>
            {fmtSec(recSec)}
          </span>
          <button
            onClick={stopRec}
            style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '8px 20px', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600, border: '1.5px solid #e2e8f0', background: '#fff', color: '#475569' }}
          >
            <span style={{ width: 11, height: 11, borderRadius: 2, background: '#94a3b8', display: 'inline-block', flexShrink: 0 }}/>
            録音を停止する
          </button>
        </div>
      )}

      {/* ── Hidden file input for draft load ── */}
      <input
        ref={draftFileRef}
        type="file"
        accept=".json"
        style={{ display:'none' }}
        onChange={loadDraftFile}
      />
    </>
  )
}

// ── Sub-components ──────────────────────────────────────────────────────────
function Card({ children }: { children: React.ReactNode }) {
  return <div style={{ background:'#fff', border:'1px solid #e2e8f0', borderRadius:22, overflow:'hidden', marginTop:0 }}>{children}</div>
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom:18 }}>
      <div style={{ fontSize:11, fontWeight:600, letterSpacing:'0.07em', color:'#1a56db', marginBottom:8, paddingLeft:8, borderLeft:'2px solid #1a56db' }}>{title}</div>
      {children}
    </div>
  )
}

function DebugSection({ title, content }: { title: string; content: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ marginTop:10, background:'#f9fafb', border:'0.5px solid #e5e7eb', borderRadius:8, overflow:'hidden' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{ width:'100%', padding:'8px 12px', display:'flex', justifyContent:'space-between', background:'none', border:'none', cursor:'pointer', fontFamily:'inherit', fontSize:11 }}
      >
        <span style={{ color:'#6b7280', fontWeight:500 }}>[DEBUG] {title}</span>
        <span style={{ color:'#9ca3af' }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <pre style={{ padding:'8px 12px', fontSize:10, color:'#374151', overflow:'auto', maxHeight:300, margin:0, whiteSpace:'pre-wrap', wordBreak:'break-all', borderTop:'0.5px solid #e5e7eb' }}>
          {content}
        </pre>
      )}
    </div>
  )
}

function MeetingInfoCard({ info, setField, phase }: { info: Info; setField: (k: keyof Info) => (e: React.ChangeEvent<HTMLInputElement>) => void; phase: Phase }) {
  const [open, setOpen] = useState(true)
  return (
    <div style={{ background:'#fff', border:'1px solid #e2e8f0', borderRadius:20, overflow:'hidden' }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ width:'100%', padding:'18px 20px', display:'flex', justifyContent:'space-between', alignItems:'center', background:'none', border:'none', cursor:'pointer', fontFamily:'inherit' }}>
        <div style={{ display:'flex', alignItems:'center', gap:13 }}>
          <div style={{ width:40, height:40, borderRadius:12, background:'#ecfeff', border:'1px solid #cffafe', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0891b2" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="2"/>
              <line x1="16" y1="2" x2="16" y2="6"/>
              <line x1="8" y1="2" x2="8" y2="6"/>
              <line x1="3" y1="10" x2="21" y2="10"/>
            </svg>
          </div>
          <div>
            <div style={{ fontSize:13.5, fontWeight:600, color:'#1e293b' }}>会議情報（任意）</div>
            {!open && <div style={{ fontSize:11, color:'#94a3b8', marginTop:2 }}>未入力でも録音できます</div>}
          </div>
        </div>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#b0bec5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          style={{ flexShrink:0, transform: open ? 'rotate(180deg)' : 'none', transition:'transform 0.2s' }}>
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>
      {open && (
        <div style={{ padding:'0 20px 20px', borderTop:'1px solid #f1f5f9' }}>
          <InfoField label="会議名">
            <input style={inputStyle} value={info.name} onChange={setField('name')} placeholder={PH}/>
          </InfoField>
          <div style={{ display:'grid', gridTemplateColumns:'1fr auto 1fr', gap:8, alignItems:'end', marginBottom:14 }}>
            <InfoField label="開始">
              <input type="datetime-local" style={inputStyle} value={info.dateStart} onChange={setField('dateStart')}/>
            </InfoField>
            <span style={{ fontSize:16, color:'#d1d5db', paddingBottom:8, textAlign:'center' }}>〜</span>
            <InfoField label="終了">
              <input type="datetime-local" style={inputStyle} value={info.dateEnd} onChange={setField('dateEnd')}/>
            </InfoField>
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
            <InfoField label="開催場所"><input style={inputStyle} value={info.place} onChange={setField('place')} placeholder={PH}/></InfoField>
            <InfoField label="司会者"><input style={inputStyle} value={info.facil} onChange={setField('facil')} placeholder={PH}/></InfoField>
            <InfoField label="書記"><input style={inputStyle} value={info.sec} onChange={setField('sec')} placeholder={PH}/></InfoField>
            <InfoField label="出席者"><input style={inputStyle} value={info.att} onChange={setField('att')} placeholder={PH}/></InfoField>
          </div>
        </div>
      )}
    </div>
  )
}

function DraftPanel({ draftDragOver, onDragOver, onDragLeave, onDrop, onOpenFile }: {
  draftDragOver: boolean
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void
  onDragLeave: () => void
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void
  onOpenFile: () => void
}) {
  const [open, setOpen] = useState(true)
  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{ background: draftDragOver ? '#eff6ff' : '#fff', border:`1px ${draftDragOver ? 'dashed #3b82f6' : 'solid #e2e8f0'}`, borderRadius:20, overflow:'hidden', transition:'background 0.15s, border 0.15s' }}
    >
      <button
        onClick={() => setOpen(o => !o)}
        style={{ width:'100%', padding:'18px 20px', display:'flex', justifyContent:'space-between', alignItems:'center', background:'none', border:'none', cursor:'pointer', fontFamily:'inherit' }}
      >
        <div style={{ display:'flex', alignItems:'center', gap:13 }}>
          <div style={{ width:40, height:40, borderRadius:12, background:'#f8fafc', border:'1px solid #f1f5f9', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="16 16 12 12 8 16"/>
              <line x1="12" y1="12" x2="12" y2="21"/>
              <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/>
            </svg>
          </div>
          <div>
            <div style={{ fontSize:13.5, fontWeight:600, color:'#1e293b' }}>下書きから再開</div>
            <div style={{ fontSize:11, color:'#94a3b8', marginTop:2 }}>保存済みの作業を続けられます</div>
          </div>
        </div>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#b0bec5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          style={{ flexShrink:0, transform: open ? 'rotate(180deg)' : 'none', transition:'transform 0.2s' }}>
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>
      {open && (
        <div style={{ borderTop:'1px solid #f1f5f9', padding:'18px 20px' }}>
          <div style={{ border:`1px ${draftDragOver ? 'dashed #3b82f6' : 'dashed #d1d9e0'}`, borderRadius:12, padding:'22px 16px', textAlign:'center', background: draftDragOver ? '#dbeafe' : '#f8fafc', transition:'background 0.15s, border 0.15s' }}>
            <div style={{ fontSize:13, fontWeight:600, color:'#334155', marginBottom:3 }}>
              {draftDragOver ? 'ここにドロップしてください' : 'ファイルをドラッグ＆ドロップ'}
            </div>
            <div style={{ fontSize:11.5, color:'#94a3b8', marginBottom:13 }}>またはボタンから選択できます</div>
            <button
              onClick={onOpenFile}
              style={{ background:'#fff', border:'1px solid #e2e8f0', borderRadius:10, padding:'8px 18px', fontSize:12.5, fontWeight:500, color:'#475569', cursor:'pointer', fontFamily:'inherit' }}
            >
              下書きを開く
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function InfoField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom:0 }}>
      <label style={{ display:'block', fontSize:11, color:'#9ca3af', marginBottom:4, fontWeight:500, marginTop:12 }}>{label}</label>
      {children}
    </div>
  )
}

function ProcBar({ phase }: { phase: Phase }) {
  const steps: [Phase, string][] = [
    ['uploading',    '保存'],
    ['transcribing', '文字起こし'],
    ['extracting',   '整理'],
    ['generating',   '議事録生成'],
  ]
  const cur = steps.findIndex(([p]) => p === phase)
  return (
    <div style={{ display:'flex', alignItems:'center', gap:6 }}>
      {steps.map(([, label], i) => (
        <div key={label} style={{ display:'flex', alignItems:'center', gap:5 }}>
          <div style={{ width:7, height:7, borderRadius:'50%', background: i < cur ? '#16a34a' : i === cur ? '#1a56db' : '#e5e7eb', transition:'background .3s' }}/>
          <span style={{ fontSize:10, color: i < cur ? '#16a34a' : i === cur ? '#1a56db' : '#9ca3af' }}>{label}</span>
          {i < steps.length - 1 && <span style={{ color:'#d1d5db', fontSize:10 }}>→</span>}
        </div>
      ))}
    </div>
  )
}

function MicIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
      <rect x="9" y="2" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M5 10a7 7 0 0 0 14 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      <line x1="12" y1="17" x2="12" y2="21" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  )
}

function Btn({ children, onClick, accent }: { children: React.ReactNode; onClick?: () => void; accent?: boolean }) {
  return (
    <button onClick={onClick} style={{
      padding:'9px 18px', border:'0.5px solid', borderRadius:8, cursor:'pointer',
      fontFamily:'inherit', fontSize:12, fontWeight:500, letterSpacing:'0.02em',
      background: accent ? '#16a34a' : 'transparent',
      color: accent ? 'white' : '#374151',
      borderColor: accent ? 'transparent' : '#d1d5db',
    }}>{children}</button>
  )
}

// ── LiveBlockCard ───────────────────────────────────────────────────────────
interface LiveBlockCardProps {
  block: Block
  isActive: boolean
  memoOpen: boolean
  onUpdate: (id: string, u: Partial<Block>) => void
  onToggleMemo: () => void
  onRetryFormat?: () => void
  onScrollToLatest?: () => void  // ライブ文字起こしに戻るボタン用
  isRecording?: boolean          // phase === 'recording' のときだけボタン表示
}

function LiveBlockCard({ block, isActive, memoOpen, onUpdate, onToggleMemo, onRetryFormat, onScrollToLatest, isRecording }: LiveBlockCardProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // 整文完了・status変化のタイミングで高さを同期的に再計算（useLayoutEffect で描画前に確定させる）
  useLayoutEffect(() => {
    if (textareaRef.current) {
      const el = textareaRef.current
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight}px`
    }
  }, [block.text, block.status])

  const statusMeta: Record<BlockStatus, { color: string; bg: string; label: string }> = {
    streaming:     { color: '#9ca3af', bg: '#f9fafb',  label: '● 取得中'        },
    formatting:    { color: '#6b7280', bg: '#f3f4f6',  label: 'AI整文中...'     },
    formatted:     { color: '#1a56db', bg: '#eff6ff',  label: 'AI整文済・要確認' },
    format_failed: { color: '#d97706', bg: '#fffbeb',  label: 'AI整文失敗'      },
    confirmed:     { color: '#16a34a', bg: '#f0fdf4',  label: '✓ 確認済'        },
    excluded:      { color: '#dc2626', bg: '#fef2f2',  label: '× 除外'          },
  }
  const sm = statusMeta[block.status]

  const leftColor = block.important         ? '#1a56db'
    : block.status === 'excluded'           ? '#fca5a5'
    : block.status === 'confirmed'          ? '#bbf7d0'
    : block.status === 'formatted'          ? '#bfdbfe'
    : block.status === 'format_failed'      ? '#fde68a'
    : '#e8e8e8'

  const isExcluded = block.status === 'excluded'

  return (
    <div
      id={block.id}
      style={{
        background: '#fff',
        border: `0.5px solid ${isActive ? '#1a56db' : '#e8e8e8'}`,
        borderLeft: `3px solid ${leftColor}`,
        borderRadius: 10,
        padding: '12px 14px',
        opacity: isExcluded ? 0.55 : 1,
        transition: 'opacity .2s',
      }}
    >
      {/* Meta */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10, color: '#9ca3af', background: '#f9fafb', padding: '2px 7px', borderRadius: 4 }}>
          {fmtSec(block.start)} 〜 {fmtSec(block.end)}
        </span>
        <span style={{ fontSize: 10, color: sm.color, background: sm.bg, padding: '2px 8px', borderRadius: 10 }}>
          {sm.label}
        </span>
        {block.important && (
          <span style={{ fontSize: 10, color: '#1a56db', background: '#eff6ff', padding: '2px 7px', borderRadius: 10 }}>★ 重要</span>
        )}
      </div>

      {/* Text */}
      {block.status === 'formatting' ? (
        <div style={{
          fontSize: 12, lineHeight: 1.8, color: '#9ca3af',
          background: '#f9fafb', padding: '8px 10px', borderRadius: 6, marginBottom: 8,
          minHeight: 140,
        }}>
          {block.orig}
          <span style={{ marginLeft: 8, fontSize: 11, color: '#6b7280' }}>— AI整文中…</span>
        </div>
      ) : (
        <>
          {block.status === 'formatted' && (
            <div style={{ fontSize: 11, color: '#0369a1', marginBottom: 5 }}>
              AI整文済みです。内容を確認し、必要なら修正してください。
            </div>
          )}
          {block.status === 'format_failed' && (
            <div style={{ fontSize: 11, color: '#d97706', marginBottom: 5 }}>
              AI整文に失敗しました。原文を表示しています。
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={block.text}
            onChange={e => {
              onUpdate(block.id, { text: e.target.value })
              const el = e.target
              el.style.height = 'auto'
              el.style.height = `${el.scrollHeight}px`
            }}
            style={{
              ...taStyle,
              fontSize: 12,
              marginBottom: 8,
              minHeight: 140,
              resize: 'vertical',
              overflow: 'hidden',
              lineHeight: 1.8,
            }}
          />
        </>
      )}

      {/* Memo */}
      {memoOpen && (
        <textarea
          value={block.memo}
          onChange={e => onUpdate(block.id, { memo: e.target.value })}
          placeholder="メモ（後で確認する事項など）"
          rows={2}
          style={{ ...taStyle, fontSize: 11, marginBottom: 8 }}
        />
      )}

      {/* Actions */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {/* AI整文を再試行 — format_failed時のみ表示 */}
        {block.status === 'format_failed' && onRetryFormat && (
          <button
            onClick={onRetryFormat}
            style={liveActionBtn(false, '#d97706', '#fffbeb', '#fde68a')}
          >
            ↺ AI整文を再試行
          </button>
        )}
        {/* 確認OK — formatting中は無効（Gemini結果が上書きしてしまうため） */}
        <button
          disabled={block.status === 'formatting'}
          onClick={() => onUpdate(block.id, { status: block.status === 'confirmed' ? 'formatted' : 'confirmed', include: true })}
          style={liveActionBtn(block.status === 'confirmed', '#16a34a', '#f0fdf4', '#bbf7d0')}
        >
          ✓ {block.status === 'confirmed' ? '確認済' : '確認OK'}
        </button>
        {/* 除外 / 戻す（Geminiが確認済みステータスを誤って上書きしないよう include も更新） */}
        <button
          onClick={() => {
            if (isExcluded) {
              onUpdate(block.id, { status: 'formatted', include: true })
            } else {
              onUpdate(block.id, { status: 'excluded', include: false })
            }
          }}
          style={liveActionBtn(isExcluded, '#dc2626', '#fef2f2', '#fca5a5')}
        >
          {isExcluded ? '↩ 戻す' : '× 除外'}
        </button>
        <button
          onClick={() => onUpdate(block.id, { important: !block.important })}
          style={liveActionBtn(block.important, '#1a56db', '#eff6ff', '#93c5fd')}
        >
          ★ {block.important ? '重要解除' : '重要'}
        </button>
        <button
          onClick={onToggleMemo}
          style={liveActionBtn(memoOpen, '#6b7280', '#f3f4f6', '#e5e7eb')}
        >
          📝 メモ
        </button>
        {isRecording && onScrollToLatest && (
          <button
            onClick={onScrollToLatest}
            style={{ fontSize: 11, padding: '4px 9px', borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit', border: '1px solid #e2e8f0', background: '#f8fafc', color: '#94a3b8' }}
          >
            ↓ ライブ文字起こしに戻る
          </button>
        )}
      </div>
    </div>
  )
}

// ── Upload helper ────────────────────────────────────────────────────────────
// Vercel Blob にブラウザから直接アップロード（サーバーレス関数のbody制限を回避）
async function uploadAudioBlob(
  blob: Blob,
  filename: string,
  contentType: string,
  onProgress: (pct: number) => void,
): Promise<string> {
  const result = await upload(filename, blob, {
    access: 'public',
    handleUploadUrl: '/api/blob-token',
    contentType,
    multipart: true,
    onUploadProgress: ({ percentage }) => {
      onProgress(Math.round(percentage))
    },
  })
  return result.url
}

// ── Styles ──────────────────────────────────────────────────────────────────
const micBtnStyle = (rec: boolean): React.CSSProperties => ({
  width: 84, height: 84, borderRadius: '50%', border: 'none',
  background: rec ? '#fef2f2' : '#eff6ff',
  color: rec ? '#dc2626' : '#1a56db',
  cursor: 'pointer', display: 'flex', flexDirection: 'column',
  alignItems: 'center', justifyContent: 'center', gap: 4,
  fontSize: 11, fontWeight: 600,
  animation: rec ? 'pulse 1.4s infinite' : 'none',
})

const idleStartBtnStyle: React.CSSProperties = {
  width: '100%', padding: '22px 0', border: 'none',
  borderRadius: 18, background: '#0891b2', color: '#fff',
  cursor: 'pointer', display: 'flex', alignItems: 'center',
  justifyContent: 'center', gap: 11, fontSize: 19, fontWeight: 600,
  fontFamily: 'inherit', letterSpacing: '-0.02em',
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 11px', border: '0.5px solid #e5e7eb',
  borderRadius: 7, background: '#f9fafb', fontSize: 13, color: '#111',
  outline: 'none',
}

const taStyle: React.CSSProperties = {
  ...{} as React.CSSProperties,
  width: '100%', padding: '8px 11px', border: '0.5px solid #e5e7eb',
  borderRadius: 7, background: '#f9fafb', fontSize: 12, color: '#111',
  outline: 'none', resize: 'vertical' as const,
}

const tdStyle: React.CSSProperties = {
  padding: '7px 10px', borderBottom: '0.5px solid #f3f4f6', verticalAlign: 'top', fontSize: 12,
}

const addBtnStyle: React.CSSProperties = {
  fontSize: 11, color: '#1a56db', background: 'none', border: '0.5px dashed #93c5fd',
  borderRadius: 6, padding: '5px 12px', cursor: 'pointer', marginTop: 4, width: '100%',
}

const delBtnStyle: React.CSSProperties = {
  fontSize: 11, color: '#dc2626', background: 'none', border: 'none', cursor: 'pointer', padding: '4px',
}

const errBoxStyle: React.CSSProperties = {
  background: '#fef2f2', border: '0.5px solid #fecaca', borderRadius: 8,
  padding: '10px 14px', fontSize: 12, color: '#dc2626', marginBottom: 10,
}

const liveActionBtn = (active: boolean, color: string, activeBg: string, activeBorder: string): React.CSSProperties => ({
  fontSize: 11, padding: '3px 9px', borderRadius: 6, cursor: 'pointer',
  fontFamily: 'inherit', border: '0.5px solid',
  background: active ? activeBg : 'transparent',
  color: active ? color : '#6b7280',
  borderColor: active ? activeBorder : '#e5e7eb',
  whiteSpace: 'nowrap',
})
