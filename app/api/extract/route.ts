import Anthropic from '@anthropic-ai/sdk'
import { NextRequest, NextResponse } from 'next/server'

export const maxDuration = 300

const client = new Anthropic()
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'
const MAX_TOKENS = 8192
const CHUNK_SIZE = 6000

const estimateTokens = (text: string) => Math.ceil(text.length / 1.5)

function splitChunks(text: string): string[] {
  if (text.length <= CHUNK_SIZE) return [text]
  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    let end = start + CHUNK_SIZE
    if (end < text.length) {
      const lastNl = text.lastIndexOf('\n', end)
      if (lastNl > start + 1000) end = lastNl + 1
    }
    chunks.push(text.slice(start, end))
    start = end
  }
  return chunks
}

function mergeStructured(results: any[]): any {
  if (results.length === 1) return results[0]
  const base = { ...results[0] }
  for (let i = 1; i < results.length; i++) {
    const r = results[i]
    if (r.agendaItems?.length) base.agendaItems = [...(base.agendaItems || []), ...r.agendaItems]
    if (r.conferenceItems?.length) base.conferenceItems = [...(base.conferenceItems || []), ...r.conferenceItems]
    if (!base.meetingTitle && r.meetingTitle) base.meetingTitle = r.meetingTitle
    if (!base.meetingDate && r.meetingDate) base.meetingDate = r.meetingDate
    if (!base.participants?.length && r.participants?.length) base.participants = r.participants
  }
  return base
}

const SYSTEM = `あなたは会議の書記アシスタントです。文字起こしから構造化データをJSON形式で抽出してください。

以下のJSON形式のみで返答してください（Markdownコードブロックなし）:
{
  "meetingTitle": "会議名（不明は空文字）",
  "meetingDate": "開催日時（不明は空文字）",
  "participants": ["参加者名"],
  "agendaItems": [
    {
      "title": "議題タイトル",
      "background": "背景・経緯",
      "discussion": "議論内容（複数行可）",
      "confirmedFacts": "確認された事実（複数行可）",
      "decisions": "決定事項（複数行可）",
      "unresolvedIssues": "未決事項（複数行可）",
      "concerns": "懸念点（複数行可）",
      "todos": [{ "task": "", "owner": "", "dueDate": "" }]
    }
  ],
  "conferenceItems": [
    {
      "residentName": "利用者名",
      "currentStatus": "現在の状態",
      "changes": "状態変化",
      "careIssues": "介護課題（食事・水分・排泄・睡眠・痛み・ADL・認知面）",
      "medicalNursingNotes": "医療・看護・介護連携事項",
      "familyCommunication": "家族対応",
      "risks": "リスク",
      "carePlan": "ケア方針",
      "requiredRecords": "記録・申し送り事項",
      "nextActions": [{ "task": "", "owner": "", "dueDate": "" }]
    }
  ]
}

ルール：
- 情報を省略・圧縮しすぎないこと
- 話された内容を可能な限り忠実に反映すること
- 不明な情報は推測せず空文字または空配列にすること
- conferenceItemsは介護施設のカンファレンスの場合のみ記入する（通常会議は空配列）
- 話者番号（話者1:, 話者2:）が含まれる場合は発言者を区別して整理する`

export async function POST(req: NextRequest) {
  try {
    const { transcript, meetingInfo } = await req.json()
    if (!transcript) return NextResponse.json({ error: 'transcript が必要です' }, { status: 400 })

    const ctxLines: string[] = []
    if (meetingInfo?.name)  ctxLines.push(`会議名：${meetingInfo.name}`)
    if (meetingInfo?.att)   ctxLines.push(`出席者：${meetingInfo.att}`)
    if (meetingInfo?.place) ctxLines.push(`場所：${meetingInfo.place}`)
    const ctx = ctxLines.length ? ctxLines.join('\n') + '\n\n' : ''

    const chunks = splitChunks(transcript)
    const inputCharCount = transcript.length
    const inputTokenEstimate = estimateTokens(transcript)

    const results: any[] = []
    let totalOutputCharCount = 0

    for (let i = 0; i < chunks.length; i++) {
      const chunkLabel = chunks.length > 1 ? `\n[チャンク ${i + 1}/${chunks.length}]\n` : ''
      const res = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM,
        messages: [{
          role: 'user',
          content: `${ctx}${chunkLabel}【文字起こし】\n${chunks[i]}`,
        }],
      })
      const text = res.content.filter(b => b.type === 'text').map(b => (b as any).text).join('')
      totalOutputCharCount += text.length
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      if (!jsonMatch) throw new Error(chunks.length > 1 ? `チャンク${i + 1}の構造化抽出に失敗しました` : '構造化抽出のJSONが見つかりませんでした')
      results.push(JSON.parse(jsonMatch[0]))
    }

    const structured = mergeStructured(results)

    console.log('[extract] success', JSON.stringify({
      model: MODEL,
      maxTokens: MAX_TOKENS,
      chunks: chunks.length,
      inputCharCount,
      inputTokenEstimate,
      outputCharCount: totalOutputCharCount,
      outputTokenEstimate: estimateTokens(JSON.stringify(structured)),
    }))

    return NextResponse.json({ structured })
  } catch (e: any) {
    console.error('[extract] error:', e.message)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
