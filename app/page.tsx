'use client'

import { useState, useRef, useEffect } from 'react'
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
  todos: Todo[]
  next_meeting: string
  inferred_attendees?: string
}

// ── Utils ──────────────────────────────────────────────────────────────────
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

// ── Main Component ─────────────────────────────────────────────────────────
export default function App() {
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

  const mrRef        = useRef<MediaRecorder | null>(null)
  const chunksRef    = useRef<Blob[]>([])
  const timerRef     = useRef<ReturnType<typeof setInterval> | null>(null)
  const startWall    = useRef(0)
  const pausedMsRef  = useRef(0)
  const pauseStartRef = useRef(0)
  const lastBlobRef  = useRef<{ blob: Blob; mimeType: string } | null>(null)

  const setField = (k: keyof Info) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setInfo(p => ({ ...p, [k]: e.target.value }))

  useEffect(() => {
    if (phase === 'recording') {
      setIsPaused(false)
      pausedMsRef.current = 0
    }
  }, [phase])

  // ── Pause / Resume ─────────────────────────────────────────────────────
  function pauseRecording() {
    if (mrRef.current?.state === 'recording') {
      mrRef.current.pause()
      if (timerRef.current) clearInterval(timerRef.current)
      pauseStartRef.current = Date.now()
      setIsPaused(true)
    }
  }

  function resumeRecording() {
    if (mrRef.current?.state === 'paused') {
      mrRef.current.resume()
      pausedMsRef.current += Date.now() - pauseStartRef.current
      const elapsed = pausedMsRef.current
      timerRef.current = setInterval(
        () => setRecSec(Math.floor((Date.now() - startWall.current - elapsed) / 1000)), 500
      )
      setIsPaused(false)
    }
  }

  // ── Recording ──────────────────────────────────────────────────────────
  async function startRec() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = getMimeType()
      const mr = new MediaRecorder(stream, { mimeType })
      chunksRef.current = []
      mr.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      mr.onstop = () => { stream.getTracks().forEach(t => t.stop()); runPipeline(mimeType) }
      mr.start(1000)
      mrRef.current = mr
      startWall.current = Date.now()
      setInfo(p => ({ ...p, dateStart: fmtLocal(new Date()) }))
      setPhase('recording')
      setRecSec(0)
      timerRef.current = setInterval(
        () => setRecSec(Math.floor((Date.now() - startWall.current) / 1000)), 500
      )
    } catch {
      setErrMsg('マイクへのアクセスが許可されていません。ブラウザの設定を確認してください。')
      setPhase('error')
    }
  }

  function stopRec() {
    if (timerRef.current) clearInterval(timerRef.current)
    const dur = Date.now() - startWall.current
    const end = new Date(new Date(info.dateStart).getTime() + dur)
    setInfo(p => ({ ...p, dateEnd: fmtLocal(end) }))
    if (mrRef.current?.state === 'recording') mrRef.current.stop()
  }

  // ── Pipeline ───────────────────────────────────────────────────────────
  async function runPipeline(mimeType: string) {
    const audioBlob = new Blob(chunksRef.current, { type: mimeType })
    lastBlobRef.current = { blob: audioBlob, mimeType }

    const ext = mimeType.includes('mp4') ? 'm4a' : 'webm'
    const filename = `audio/meeting-${Date.now()}.${ext}`

    let url: string
    try {
      setPhase('uploading')
      setUploadProgress(0)
      setProcStep('音声データをアップロード中… 画面を閉じないでください')
      const result = await upload(filename, audioBlob, {
        access: 'public',
        handleUploadUrl: '/api/upload-audio',
        multipart: true,
        clientPayload: process.env.NEXT_PUBLIC_APP_UPLOAD_PASSWORD ?? '',
        onUploadProgress: ({ percentage }) => {
          setUploadProgress(percentage)
        },
      })
      url = result.url
      setBlobUrl(url)
    } catch (e: any) {
      setErrMsg('アップロードに失敗しました。ネットワーク接続を確認して「再試行」を押してください。（録音データは保持されています）')
      setPhase('error')
      return
    }

    await runFromTranscribe(url)
  }

  async function retryUpload() {
    const saved = lastBlobRef.current
    if (!saved) return
    setErrMsg('')
    const { blob, mimeType } = saved
    const ext = mimeType.includes('mp4') ? 'm4a' : 'webm'
    const filename = `audio/meeting-${Date.now()}.${ext}`
    let url: string
    try {
      setPhase('uploading')
      setUploadProgress(0)
      setProcStep('音声データをアップロード中… 画面を閉じないでください')
      const result = await upload(filename, blob, {
        access: 'public',
        handleUploadUrl: '/api/upload-audio',
        multipart: true,
        clientPayload: process.env.NEXT_PUBLIC_APP_UPLOAD_PASSWORD ?? '',
        onUploadProgress: ({ percentage }) => {
          setUploadProgress(percentage)
        },
      })
      url = result.url
      setBlobUrl(url)
    } catch (e: any) {
      setErrMsg('アップロードに失敗しました。ネットワーク接続を確認して「再試行」を押してください。（録音データは保持されています）')
      setPhase('error')
      return
    }
    await runFromTranscribe(url)
  }

  async function retryFromTranscribe() {
    if (!blobUrl) return
    setErrMsg('')
    await runFromTranscribe(blobUrl)
  }

  async function runFromTranscribe(url: string) {
    // 1. Transcribe
    let transcript: string
    try {
      setPhase('transcribing')
      setProcStep('文字起こし中… (Deepgram Nova-3)')
      const txRes = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      if (!txRes.ok) throw new Error((await txRes.json()).error || '文字起こしに失敗しました')
      ;({ transcript } = await txRes.json())
      setDbgTranscript(transcript)
    } catch (e: any) {
      setErrMsg(`文字起こしに失敗しました: ${e.message} — 「文字起こしから再試行」を押してください。`)
      setPhase('error')
      return
    }

    // 2. Extract structured data
    let structured: any
    try {
      setPhase('extracting')
      setProcStep('内容を整理中… (構造化抽出)')
      const exRes = await fetch('/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript, meetingInfo: info }),
      })
      if (!exRes.ok) throw new Error((await exRes.json()).error || '構造化抽出に失敗しました')
      ;({ structured } = await exRes.json())
      setDbgStructured(structured)
    } catch (e: any) {
      setErrMsg(`構造化抽出に失敗しました: ${e.message} — 「文字起こしから再試行」を押してください。`)
      setPhase('error')
      return
    }

    // 3. Generate detailed + summary
    try {
      setPhase('generating')
      setProcStep('詳細版・要約版を生成中… (Claude)')
      const genRes = await fetch('/api/generate', {
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
      setErrMsg(`議事録生成に失敗しました: ${e.message} — 「文字起こしから再試行」を押してください。`)
      setPhase('error')
    }
  }

  // ── Editing ────────────────────────────────────────────────────────────
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

  // ── Regenerate ─────────────────────────────────────────────────────────
  async function regenerate() {
    if (!dbgStructured) return
    setPrevDetailed(detailedMinutes)
    setPrevSummary(summaryMinutes)
    setIsRegenerating(true)
    setRegenErr('')
    setIsEditing(false)
    setEditBuf(null)
    try {
      const genRes = await fetch('/api/generate', {
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

  // ── Word Download ──────────────────────────────────────────────────────
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

    // ── Filename ──
    const sanitize = (s: string) =>
      s.replace(/[/\\:*?"<>|\n\r]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 50)
    const baseName = info.name
      ? `${sanitize(info.name)}_議事録_${tabLabel}`
      : `議事録_${tabLabel}`

    const ch: any[] = []

    // ── Title ──
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

    // ── Info table ──
    // 常に表示（空欄でも行を残す）: 開催日時・書記・出席者・作成日・版区分
    // 未入力なら行ごと削除: 開催場所・司会
    // 会議名はタイトルに入れるため非表示
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

    // ── ヘルパー ──
    const secTitle = (t: string) => new Paragraph({
      children: [new TextRun({ text: t, bold: true, size: 26, color: blue })],
      spacing: { before: 320, after: 120 },
    })

    const spacer = () => new Paragraph({ text: '', spacing: { after: 160 } })

    // 改行・箇条書き対応テキスト→Paragraph変換
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
        // 行頭の「・」「- 」「* 」のみ箇条書き扱い
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

    // ── 会議の概要 ──
    if (m.summary) {
      ch.push(secTitle('■ 会議の概要'))
      ch.push(...textToParas(m.summary))
      ch.push(spacer())
    }

    // ── 議題・議論内容 ──
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

    // ── 決定事項 ──
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

    // ── TODO ──
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

    // ── 次回会議 ──
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

  // ── Helpers ────────────────────────────────────────────────────────────
  const isProc = (['transcribing', 'extracting', 'generating'] as Phase[]).includes(phase)
  const currentMinutes = activeTab === 'detailed' ? detailedMinutes : summaryMinutes
  const displayMin = isEditing ? editBuf : currentMinutes

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
  }

  // ── Render ─────────────────────────────────────────────────────────────
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
            </div>
          )}

          {phase === 'recording' && (
            <div style={{ display:'flex', flexDirection:'column', alignItems:'center', padding:'36px 20px 28px', gap:14 }}>
              <div style={{ display:'flex', alignItems:'center', gap:16 }}>
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
              <div style={{ fontSize:28, fontWeight:600, color: isPaused ? '#d97706' : '#dc2626', letterSpacing:'0.08em', fontVariantNumeric:'tabular-nums' }}>
                {fmtSec(recSec)}
              </div>
              <p style={{ fontSize:11, color: isPaused ? '#d97706' : '#dc2626' }}>
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
              </div>
            </div>
          )}

          {isProc && (
            <div style={{ padding:'40px 20px', display:'flex', flexDirection:'column', alignItems:'center', gap:18 }}>
              <div style={{ width:38, height:38, borderRadius:'50%', border:'2.5px solid #e5e7eb', borderTopColor:'#1a56db', animation:'spin .7s linear infinite' }}/>
              <div style={{ textAlign:'center' }}>
                <div style={{ fontSize:13, fontWeight:500, marginBottom:10 }}>{procStep}</div>
                <ProcBar phase={phase}/>
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
              {blobUrl && (
                <p style={{ fontSize:11, color:'#6b7280', marginBottom:10 }}>
                  録音データは保存済みです。
                  <a href={blobUrl} target="_blank" style={{ color:'#1a56db', marginLeft:4 }}>ダウンロード</a>
                </p>
              )}
              <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
                <Btn onClick={() => { resetToIdle(); setErrMsg(''); setBlobUrl(''); lastBlobRef.current = null }}>最初から</Btn>
                {lastBlobRef.current && !blobUrl && (
                  <Btn accent onClick={retryUpload}>再試行（アップロード）</Btn>
                )}
                {blobUrl && (
                  <Btn accent onClick={retryFromTranscribe}>文字起こしから再試行</Btn>
                )}
              </div>
            </div>
          )}
        </Card>

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

// ── Sub-components ─────────────────────────────────────────────────────────
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

// ── Styles ─────────────────────────────────────────────────────────────────
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
