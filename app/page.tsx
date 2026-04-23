'use client'

import { useState, useRef, useEffect } from 'react'

// ── Types ──────────────────────────────────────────────────────────────────
type Phase =
  | 'idle'
  | 'recording'
  | 'uploading'
  | 'transcribing'
  | 'generating'
  | 'preview'
  | 'error'

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
  const [minutes, setMinutes]   = useState<Minutes | null>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [editBuf, setEditBuf]   = useState<Minutes | null>(null)
  const [errMsg, setErrMsg]     = useState('')
  const [blobUrl, setBlobUrl]   = useState('')
  const [inferredAtt, setInferredAtt] = useState('')
  const [isPaused, setIsPaused] = useState(false)

  const mrRef        = useRef<MediaRecorder | null>(null)
  const chunksRef    = useRef<Blob[]>([])
  const timerRef     = useRef<ReturnType<typeof setInterval> | null>(null)
  const startWall    = useRef(0)
  const pausedMsRef  = useRef(0)
  const pauseStartRef = useRef(0)

  // Field setter
  const setField = (k: keyof Info) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setInfo(p => ({ ...p, [k]: e.target.value }))

  // 録音開始時に一時停止状態をリセット
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
    try {
      // 1. Upload (Vercel Blob) ─ 録音データを最優先で保存
      setPhase('uploading')
      setProcStep('音声データを安全に保存中…')
      const upRes = await fetch('/api/upload-audio', {
        method: 'POST',
        headers: { 'Content-Type': mimeType },
        body: audioBlob,
      })
      if (!upRes.ok) throw new Error('音声の保存に失敗しました')
      const { url } = await upRes.json()
      setBlobUrl(url)

      // 2. Transcribe (Deepgram)
      setPhase('transcribing')
      setProcStep('文字起こし中… (Deepgram Nova-3)')
      const txRes = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      if (!txRes.ok) throw new Error((await txRes.json()).error || '文字起こしに失敗しました')
      const { transcript } = await txRes.json()

      // 3. Generate (Claude Haiku)
      setPhase('generating')
      setProcStep('議事録を作成中… (Claude Haiku)')
      const genRes = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript, meetingInfo: info }),
      })
      if (!genRes.ok) throw new Error((await genRes.json()).error || '議事録生成に失敗しました')
      const data: Minutes = await genRes.json()

      // 出席者未入力 && AIが推測した場合はバナーで提案
      if (data.inferred_attendees && !info.att) setInferredAtt(data.inferred_attendees)

      setMinutes(data)
      setPhase('preview')
    } catch (e: any) {
      setErrMsg(e.message)
      setPhase('error')
    }
  }

  // ── Editing ────────────────────────────────────────────────────────────
  function startEdit() {
    setEditBuf(JSON.parse(JSON.stringify(minutes)))
    setIsEditing(true)
  }
  function saveEdit() { setMinutes(editBuf); setIsEditing(false) }
  function cancelEdit() { setEditBuf(null); setIsEditing(false) }

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
    if (!docx || !minutes) { alert('docx ライブラリが読み込まれていません'); return }
    const {
      Document, Paragraph, TextRun, Table, TableRow, TableCell,
      WidthType, AlignmentType, Packer,
    } = docx
    const blue = '185FA5', gray = '4A4540', white = 'FFFFFF'
    const ch: any[] = []

    // Title
    ch.push(new Paragraph({
      children: [new TextRun({ text: '議　事　録', bold: true, size: 40, color: '1A1714' })],
      alignment: AlignmentType.CENTER, spacing: { after: 400, before: 200 },
    }))

    // Meta table
    const dateStr = info.dateStart
      ? fmtDT(info.dateStart) + (info.dateEnd ? ' 〜 ' + fmtT(info.dateEnd) : '')
      : '—'
    const meta = [
      ['会議名',   info.name  || '（未設定）'],
      ['開催日時', dateStr],
      ['開催場所', info.place || '—'],
      ['司会',     info.facil || '—'],
      ['書記',     info.sec   || '—'],
      ['出席者',   info.att   || '—'],
    ]
    ch.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: meta.map(([k, v]) => new TableRow({ children: [
        new TableCell({ width: { size: 18, type: WidthType.PERCENTAGE },
          children: [new Paragraph({ children: [new TextRun({ text: k, bold: true, size: 21, color: blue })] })],
          margins: { top: 80, bottom: 80, left: 100, right: 100 } }),
        new TableCell({ width: { size: 82, type: WidthType.PERCENTAGE },
          children: [new Paragraph({ children: [new TextRun({ text: v, size: 21 })] })],
          margins: { top: 80, bottom: 80, left: 100, right: 100 } }),
      ] })),
    }))
    ch.push(new Paragraph({ text: '', spacing: { after: 240 } }))

    const sec = (t: string) => new Paragraph({
      children: [new TextRun({ text: t, bold: true, size: 24, color: blue })],
      spacing: { before: 200, after: 100 },
    })

    if (minutes.summary) {
      ch.push(sec('■ 会議の概要'))
      ch.push(new Paragraph({ children: [new TextRun({ text: minutes.summary, size: 21, color: gray })], spacing: { after: 200 } }))
    }
    if (minutes.agenda_items?.length) {
      ch.push(sec('■ 議題・議論内容'))
      minutes.agenda_items.forEach((a, i) => {
        ch.push(new Paragraph({ children: [new TextRun({ text: `${i+1}. ${a.title}`, bold: true, size: 22 })], spacing: { before: 140, after: 60 } }))
        ch.push(new Paragraph({ children: [new TextRun({ text: a.discussion, size: 21, color: gray })], spacing: { after: 120 }, indent: { left: 280 } }))
      })
    }
    if (minutes.decisions?.length) {
      ch.push(sec('■ 決定事項'))
      minutes.decisions.forEach(d =>
        ch.push(new Paragraph({ children: [new TextRun({ text: '・' + d, size: 21 })], spacing: { after: 60 }, indent: { left: 200 } }))
      )
    }
    if (minutes.todos?.length) {
      ch.push(sec('■ TODO・アクションアイテム'))
      ch.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({ children: ['タスク内容', '担当者', '期限'].map(h => new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, size: 20, color: white })] })],
            shading: { fill: blue }, margins: { top: 80, bottom: 80, left: 100, right: 100 },
          })) }),
          ...minutes.todos.map(t => new TableRow({ children: [t.task, t.assignee, t.deadline || '—'].map(v => new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: v, size: 20 })] })],
            margins: { top: 80, bottom: 80, left: 100, right: 100 },
          })) })),
        ],
      }))
    }
    if (minutes.next_meeting) {
      ch.push(sec('■ 次回会議'))
      ch.push(new Paragraph({ children: [new TextRun({ text: minutes.next_meeting, size: 21 })], spacing: { after: 160 } }))
    }

    const doc = new Document({ sections: [{ properties: { page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } }, children: ch }] })
    const blob = await Packer.toBlob(doc)
    const objUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = objUrl
    a.download = `議事録_${(info.name || '未設定').replace(/[/\\:*?"<>|]/g, '_')}.docx`
    a.click()
    URL.revokeObjectURL(objUrl)
  }

  // ── Helpers ────────────────────────────────────────────────────────────
  const isProc = (['uploading', 'transcribing', 'generating'] as Phase[]).includes(phase)
  const displayMin = isEditing ? editBuf : minutes

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
              <div style={{ display:'flex', gap:8 }}>
                <Btn onClick={() => { setPhase('idle'); setErrMsg(''); setBlobUrl('') }}>最初から</Btn>
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
            {/* Preview header */}
            <div style={{ padding:'12px 18px', borderBottom:'0.5px solid #e8e8e8', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
              <span style={{ fontSize:13, fontWeight:500, color:'#374151' }}>議事録プレビュー</span>
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
                          <div style={{ fontSize:12, color:'#6b7280', lineHeight:1.75 }}>{a.discussion}</div>
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
                <Btn onClick={() => { setPhase('idle'); setMinutes(null); setIsEditing(false) }}>最初から</Btn>
                <Btn accent onClick={downloadDocx}>Word (.docx) 出力</Btn>
              </div>
            </div>
          </div>
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
  const steps: [Phase, string][] = [['uploading','保存'], ['transcribing','文字起こし'], ['generating','議事録生成']]
  const cur = steps.findIndex(([p]) => p === phase)
  return (
    <div style={{ display:'flex', alignItems:'center', gap:6 }}>
      {steps.map(([, label], i) => (
        <div key={label} style={{ display:'flex', alignItems:'center', gap:5 }}>
          <div style={{ width:7, height:7, borderRadius:'50%', background: i < cur ? '#16a34a' : i === cur ? '#1a56db' : '#e5e7eb', transition:'background .3s' }}/>
          <span style={{ fontSize:10, color: i < cur ? '#16a34a' : i === cur ? '#1a56db' : '#9ca3af' }}>{label}</span>
          {i < 2 && <span style={{ color:'#d1d5db', fontSize:10 }}>→</span>}
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
