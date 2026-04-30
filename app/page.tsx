'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
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
  const [isPaused, setIsPaused] = useState(false)
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
  const [atBottom, setAtBottom]     = useState(true)
  const [newBlockCount, setNewBlockCount] = useState(0)
  const [memoOpen, setMemoOpen]     = useState<Record<string, boolean>>({})
  const [activeBlockId, setActiveBlockId] = useState<string | null>(null)
  const [timerKey, setTimerKey]     = useState(0)

  // ── Existing refs ───────────────────────────────────────────────────────
  const mrRef        = useRef<MediaRecorder | null>(null)
  const chunksRef    = useRef<Blob[]>([])
  const timerRef     = useRef<ReturnType<typeof setInterval> | null>(null)
  const startWall    = useRef(0)
  const pausedMsRef  = useRef(0)
  const pauseStartRef = useRef(0)
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
  const atBottomRef    = useRef(true)
  const blockScrollRef = useRef<HTMLDivElement>(null)
  const blockIdRef     = useRef(0)
  const liveBlocksRef  = useRef<Block[]>([])

  liveIntervalRef.current  = liveInterval
  atBottomRef.current      = atBottom
  liveBlocksRef.current    = liveBlocks

  const setField = (k: keyof Info) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setInfo(p => ({ ...p, [k]: e.target.value }))

  useEffect(() => {
    if (phase === 'recording') {
      setIsPaused(false)
      pausedMsRef.current = 0
    }
  }, [phase])

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
    const endSec = Math.floor((Date.now() - startWall.current - pausedMsRef.current) / 1000)
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
    if (!atBottomRef.current) {
      setNewBlockCount(n => n + 1)
    } else {
      setTimeout(() => blockScrollRef.current?.scrollTo({ top: 999999, behavior: 'smooth' }), 60)
    }

    formatBlock(id, t, contextText || undefined)
  }, [formatBlock])

  // ── Block interval timer ─────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== 'recording' || isPaused) {
      if (blockTimerRef.current) { clearInterval(blockTimerRef.current); blockTimerRef.current = null }
      return
    }
    blockTimerRef.current = setInterval(seal, liveInterval * 1000)
    return () => {
      if (blockTimerRef.current) { clearInterval(blockTimerRef.current); blockTimerRef.current = null }
    }
  }, [phase, liveInterval, timerKey, isPaused, seal])

  // ── Pause / Resume ──────────────────────────────────────────────────────
  function pauseRecording() {
    if (mrRef.current?.state === 'recording') {
      mrRef.current.pause()
      if (liveMrRef.current?.state === 'recording') liveMrRef.current.pause()
      if (timerRef.current) clearInterval(timerRef.current)
      if (mockTimerRef.current) { clearInterval(mockTimerRef.current); mockTimerRef.current = null }
      pauseStartRef.current = Date.now()
      setIsPaused(true)
    }
  }

  function resumeRecording() {
    if (mrRef.current?.state === 'paused') {
      mrRef.current.resume()
      if (liveMrRef.current?.state === 'paused') liveMrRef.current.resume()
      pausedMsRef.current += Date.now() - pauseStartRef.current
      const elapsed = pausedMsRef.current
      timerRef.current = setInterval(
        () => setRecSec(Math.floor((Date.now() - startWall.current - elapsed) / 1000)), 500
      )
      if (isMockAvailable && mockMode) connectMockTranscription()
      setTimerKey(k => k + 1)
      setIsPaused(false)
    }
  }

  // ── Recording ───────────────────────────────────────────────────────────
  async function startRec() {
    // Reset live state
    setLiveBlocks([])
    setLiveBuf('')
    setLiveInterim('')
    setLiveBufStart(0)
    setNewBlockCount(0)
    setActiveBlockId(null)
    setMemoOpen({})
    setAtBottom(true)
    setTimerKey(0)
    setWsConnected(false)
    setWsError('')
    setBlobUrl('')
    liveBufRef.current      = ''
    liveBufStartRef.current = 0
    blockIdRef.current      = 0
    atBottomRef.current     = true

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

    // liveBlocks（Gemini整文・ユーザー確認済み）を主入力として構築
    const liveBlocksTranscript = buildLiveBlocksTranscript(liveBlocksRef.current)
    const includedCount = liveBlocksRef.current.filter(b => b.include).length

    let transcriptForExtract: string
    if (liveBlocksTranscript.trim().length > 0) {
      transcriptForExtract = liveBlocksTranscript
      console.log(
        `[pipeline] Sonnet入力: liveBlocks由来 — ${transcriptForExtract.length} chars, ` +
        `${includedCount}ブロック（Gemini整文・ユーザー確認済み）`
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
    blockScrollRef.current?.scrollTo({ top: 999999, behavior: 'smooth' })
    setNewBlockCount(0)
    setAtBottom(true)
    atBottomRef.current = true
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

  function handleBlockScroll() {
    if (!blockScrollRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = blockScrollRef.current
    const ab = scrollHeight - scrollTop - clientHeight < 80
    setAtBottom(ab)
    atBottomRef.current = ab
    if (ab) setNewBlockCount(0)
  }

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
    setNewBlockCount(0)
    setActiveBlockId(null)
    setMemoOpen({})
  }

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <>
      <style>{`
        *{box-sizing:border-box;margin:0;padding:0}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.55}}
        input,textarea{font-family:inherit;font-size:13px}
        input::placeholder,textarea::placeholder{color:#bbb}
        textarea{resize:vertical;line-height:1.7}
        ::-webkit-scrollbar{width:4px}
        ::-webkit-scrollbar-thumb{background:#ddd;border-radius:2px}
      `}</style>

      {/* ── Header ── */}
      <header style={{ background:'#fff', borderBottom:'0.5px solid #e8e8e8', padding:'13px 18px', display:'flex', alignItems:'center', gap:10, position:'sticky', top:0, zIndex:10 }}>
        <div style={{ width:30, height:30, borderRadius:7, background:'#e8f0fe', display:'flex', alignItems:'center', justifyContent:'center', color:'#1a56db', flexShrink:0 }}>
          <svg width="17" height="17" viewBox="0 0 16 16" fill="none">
            <rect x="2" y="1" width="12" height="14" rx="2" stroke="currentColor" strokeWidth="1.3"/>
            <line x1="5" y1="5" x2="11" y2="5" stroke="currentColor" strokeWidth="1"/>
            <line x1="5" y1="8" x2="11" y2="8" stroke="currentColor" strokeWidth="1"/>
            <line x1="5" y1="11" x2="9" y2="11" stroke="currentColor" strokeWidth="1"/>
          </svg>
        </div>
        <div>
          <div style={{ fontSize:15, fontWeight:600, letterSpacing:'-0.01em' }}>議事録メーカー</div>
          <div style={{ fontSize:10, color:'#9ca3af', marginTop:1 }}>録音 → 文字起こし → AI 議事録 → Word</div>
        </div>
        <div style={{ flex:1 }} />
      </header>

      <main style={{ maxWidth:640, margin:'0 auto', padding:'14px 12px 80px' }}>

        {/* ── 注意書きカード ── */}
        <div style={{
          background: '#fffbeb',
          border: '1px solid #fde68a',
          borderRadius: 10,
          padding: '14px 18px',
          marginBottom: 16,
          fontSize: 13,
          color: '#92400e',
          lineHeight: 1.8,
        }}>
          <strong style={{ display: 'block', marginBottom: 4, color: '#78350f' }}>
            ⚠️ AIによる生成物は必ず確認をお願いします。
          </strong>
          固有名詞・数値・決定事項はAIが聞き間違える場合があります。出力後に担当者が内容を確認・修正してから提出してください。録音データおよび議事録は施設内での業務利用に限ります。
        </div>

        {/* ── Recording Card ── */}
        <Card>
          {phase === 'idle' && (
            <div style={{ display:'flex', flexDirection:'column', alignItems:'center', padding:'36px 20px 28px', gap:14 }}>
              <button onClick={startRec} style={micBtnStyle(false)}>
                <MicIcon />
                <span>録音開始</span>
              </button>
              <p style={{ fontSize:12, color:'#9ca3af', textAlign:'center' }}>
                会議情報は録音前・中・後いつでも入力できます
              </p>
              {isMockAvailable && (
                <label style={{ display:'flex', alignItems:'center', gap:6, fontSize:11, color:'#9b59b6', cursor:'pointer', background:'#f5f0ff', border:'0.5px solid #d8b4fe', borderRadius:6, padding:'5px 10px' }}>
                  <input
                    type="checkbox"
                    checked={mockMode}
                    onChange={e => setMockMode(e.target.checked)}
                    style={{ accentColor:'#9b59b6', cursor:'pointer' }}
                  />
                  [DEV] モックモード（Deepgram接続なし・UIテスト用）
                </label>
              )}
            </div>
          )}

          {phase === 'recording' && (
            <div style={{ padding:'20px 20px 16px' }}>
              {/* タイマー + ボタン行 */}
              <div style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:16, marginBottom:10 }}>
                <button onClick={stopRec} style={micBtnStyle(true)}>
                  <svg width="20" height="20" viewBox="0 0 24 24">
                    <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor"/>
                  </svg>
                  <span>停止</span>
                </button>
                {isPaused ? (
                  <button onClick={resumeRecording} style={pauseBtnStyle('resume')}>
                    ▶ 再開
                  </button>
                ) : (
                  <button onClick={pauseRecording} style={pauseBtnStyle('pause')}>
                    ⏸ 一時停止
                  </button>
                )}
              </div>
              <div style={{ textAlign:'center', fontSize:28, fontWeight:600, color: isPaused ? '#d97706' : '#dc2626', letterSpacing:'0.08em', fontVariantNumeric:'tabular-nums' }}>
                {fmtSec(recSec)}
              </div>
              <p style={{ textAlign:'center', fontSize:11, color: isPaused ? '#d97706' : '#dc2626', marginTop:4 }}>
                {isPaused ? '一時停止中 — 再開または停止してください' : '録音中 — 停止後に自動で文字起こしが始まります'}
              </p>
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

        {/* ── ライブ校正セクション ── */}
        {(phase === 'recording' || liveBlocks.length > 0) && (
          <div style={{ marginTop: 10 }}>

            {/* コントロールバー — 録音中のみ */}
            {phase === 'recording' && (
              <div style={{ background: '#fff', border: '0.5px solid #e8e8e8', borderRadius: 12, padding: '12px 16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 11, color: '#9ca3af', whiteSpace: 'nowrap' }}>確認間隔：</span>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {LIVE_INTERVALS.map(o => (
                      <button
                        key={o.v}
                        onClick={() => setLiveInterval(o.v)}
                        style={{
                          fontSize: 11, padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
                          fontFamily: 'inherit', border: '0.5px solid',
                          background: liveInterval === o.v ? '#eff6ff' : 'transparent',
                          color: liveInterval === o.v ? '#1a56db' : '#6b7280',
                          borderColor: liveInterval === o.v ? '#93c5fd' : '#e5e7eb',
                          fontWeight: liveInterval === o.v ? 600 : 400,
                        }}
                      >
                        {o.l}
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={cutNow}
                    style={{
                      fontSize: 11, padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
                      fontFamily: 'inherit', border: '0.5px dashed #93c5fd',
                      background: 'rgba(26,86,219,0.04)', color: '#1a56db', whiteSpace: 'nowrap',
                    }}
                  >
                    ✂ 今すぐ区切る
                  </button>
                  <div style={{ flex: 1 }} />
                  <span style={{ fontSize: 10, whiteSpace: 'nowrap', color: (isMockAvailable && mockMode) ? '#9b59b6' : wsConnected ? '#16a34a' : wsError ? '#dc2626' : '#9ca3af' }}>
                    {(isMockAvailable && mockMode) ? '● モック（DEV）' : wsConnected ? '● ライブ文字起こし中' : wsError ? '× Deepgram接続失敗' : '○ 接続中…'}
                  </span>
                </div>
              </div>
            )}

            {/* バナー + ナビゲーション — ブロックがある間は常に表示 */}
            <div style={{ background: '#fff', border: '0.5px solid #e8e8e8', borderRadius: 12, padding: '12px 16px', marginTop: phase === 'recording' ? 6 : 0 }}>
              {/* 確認用テキストバナー */}
              <div style={{
                padding: '7px 12px', borderRadius: 8,
                background: '#f0f9ff', border: '0.5px solid #bae6fd',
                fontSize: 11, color: '#0369a1',
              }}>
                AI整文済みの確認用テキストです。修正後「確認OK」を押してから議事録を生成してください。
              </div>

              {/* ナビゲーション */}
              {liveBlocks.length > 0 && (
                <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 11, color: '#6b7280' }}>
                    <span style={{ color: '#16a34a', fontWeight: 500 }}>✓ {confirmed}</span>
                    {' '}確認済
                    <span style={{ color: toConfirm > 0 ? '#1a56db' : '#9ca3af', fontWeight: 500 }}>○ {toConfirm}</span>
                    {' '}要確認
                  </span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      onClick={toNextUnchecked}
                      disabled={toConfirm === 0}
                      style={{
                        fontSize: 11, padding: '4px 10px', borderRadius: 6, cursor: toConfirm === 0 ? 'not-allowed' : 'pointer',
                        fontFamily: 'inherit', border: '0.5px solid #e5e7eb',
                        background: 'transparent', color: toConfirm === 0 ? '#d1d5db' : '#374151',
                      }}
                    >
                      次の要確認へ {toConfirm > 0 && <span style={{ background: '#1a56db', color: '#fff', borderRadius: 8, padding: '1px 5px', fontSize: 10 }}>{toConfirm}</span>}
                    </button>
                    <button
                      onClick={toLatest}
                      style={{
                        fontSize: 11, padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
                        fontFamily: 'inherit', border: '0.5px solid #e5e7eb',
                        background: 'transparent', color: '#374151',
                      }}
                    >
                      ↓ 最新へ
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Deepgram接続エラー — 録音中のみ */}
            {phase === 'recording' && wsError && !(isMockAvailable && mockMode) && (
              <div style={{
                background: '#fef2f2', border: '0.5px solid #fecaca', borderRadius: 8,
                padding: '8px 14px', marginTop: 6, fontSize: 11, color: '#dc2626',
              }}>
                {wsError}
              </div>
            )}

            {/* 新ブロック通知 — 録音中のみ */}
            {phase === 'recording' && newBlockCount > 0 && (
              <div style={{
                background: '#eff6ff', border: '0.5px solid #bfdbfe', borderRadius: 8,
                padding: '7px 14px', marginTop: 6,
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12,
              }}>
                <span style={{ color: '#1a56db' }}>+ 新しいブロックが {newBlockCount} 件追加されました</span>
                <button
                  onClick={toLatest}
                  style={{ fontSize: 11, color: '#1a56db', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
                >
                  最新を見る →
                </button>
              </div>
            )}

            {/* ブロック一覧 + ライブバッファ */}
            <div
              ref={blockScrollRef}
              onScroll={handleBlockScroll}
              style={{ maxHeight: 480, overflowY: 'auto', marginTop: 6, display: 'flex', flexDirection: 'column', gap: 8 }}
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
                />
              ))}

              {/* ライブバッファ（現在の区間）— 録音中のみ */}
              {phase === 'recording' && (liveBuf || liveInterim) && (
                <div style={{
                  background: '#f0f9ff', border: '0.5px dashed #93c5fd',
                  borderRadius: 10, padding: '12px 14px',
                }}>
                  <div style={{ fontSize: 10, color: '#1a56db', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: '#dc2626', animation: 'pulse 1.4s infinite' }} />
                    {fmtSec(liveBufStart)} 〜 書き起こし中（最大 {liveInterval}秒）
                  </div>
                  <div style={{ fontSize: 12, color: '#374151', lineHeight: 1.8 }}>
                    {liveBuf && <span>{liveBuf}</span>}
                    {liveInterim && <span style={{ color: '#9ca3af' }}>{liveBuf ? '　' : ''}{liveInterim}</span>}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

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

        {/* ── Meeting Info Card ── */}
        <MeetingInfoCard info={info} setField={setField} />

        {/* ── Preview Card ── */}
        {phase === 'preview' && displayMin && (
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
              <div style={{ display:'flex', gap:8 }}>
                <Btn onClick={() => { resetToIdle(); setBlobUrl('') }}>最初から</Btn>
                <Btn accent onClick={downloadDocx}>Word (.docx) 出力</Btn>
              </div>
            </div>
          </div>
        )}

        {/* ── Regenerate section ── */}
        {phase === 'preview' && (
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
        )}

        {/* ── Debug sections ── */}
        {isDebug && dbgTranscript && (
          <DebugSection title="文字起こし全文" content={dbgTranscript} />
        )}
        {isDebug && dbgStructured && (
          <DebugSection title="構造化抽出結果" content={JSON.stringify(dbgStructured, null, 2)} />
        )}

      </main>
    </>
  )
}

// ── Sub-components ──────────────────────────────────────────────────────────
function Card({ children }: { children: React.ReactNode }) {
  return <div style={{ background:'#fff', border:'0.5px solid #e8e8e8', borderRadius:12, overflow:'hidden', marginTop:0 }}>{children}</div>
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

function MeetingInfoCard({ info, setField }: { info: Info; setField: (k: keyof Info) => (e: React.ChangeEvent<HTMLInputElement>) => void }) {
  const [open, setOpen] = useState(true)
  return (
    <div style={{ marginTop:10, background:'#fff', border:'0.5px solid #e8e8e8', borderRadius:12, overflow:'hidden' }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ width:'100%', padding:'12px 18px', display:'flex', justifyContent:'space-between', alignItems:'center', background:'none', border:'none', cursor:'pointer', fontFamily:'inherit' }}>
        <span style={{ fontSize:13, fontWeight:500, color:'#374151' }}>会議情報</span>
        <span style={{ fontSize:10, color:'#9ca3af', transform: open ? 'rotate(180deg)' : 'none', transition:'transform .2s', display:'inline-block' }}>▼</span>
      </button>
      {open && (
        <div style={{ padding:'0 18px 18px', borderTop:'0.5px solid #f3f4f6' }}>
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
}

function LiveBlockCard({ block, isActive, memoOpen, onUpdate, onToggleMemo, onRetryFormat }: LiveBlockCardProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Gemini整文完了時（block.text更新）にテキストエリアを自動リサイズ
  useEffect(() => {
    if (textareaRef.current) {
      const el = textareaRef.current
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight}px`
    }
  }, [block.text])

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

const pauseBtnStyle = (mode: 'pause' | 'resume'): React.CSSProperties => ({
  padding: '8px 14px', borderRadius: 8, cursor: 'pointer',
  fontFamily: 'inherit', fontSize: 11, fontWeight: 600,
  border: `0.5px solid ${mode === 'pause' ? '#fde68a' : '#bbf7d0'}`,
  background: mode === 'pause' ? '#fffbeb' : '#f0fdf4',
  color: mode === 'pause' ? '#d97706' : '#16a34a',
})

const liveActionBtn = (active: boolean, color: string, activeBg: string, activeBorder: string): React.CSSProperties => ({
  fontSize: 11, padding: '3px 9px', borderRadius: 6, cursor: 'pointer',
  fontFamily: 'inherit', border: '0.5px solid',
  background: active ? activeBg : 'transparent',
  color: active ? color : '#6b7280',
  borderColor: active ? activeBorder : '#e5e7eb',
  whiteSpace: 'nowrap',
})
