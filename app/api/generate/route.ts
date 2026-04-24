import Anthropic from '@anthropic-ai/sdk'
import { NextRequest, NextResponse } from 'next/server'

export const maxDuration = 300

const client = new Anthropic()
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'
const MAX_TOKENS = 8192

const estimateTokens = (text: string) => Math.ceil(text.length / 1.5)

const OUTPUT_SCHEMA = `以下のJSON形式のみで返答してください（Markdownコードブロックなし）:
{
  "summary": "会議全体の要約",
  "agenda_items": [{"title": "議題タイトル", "discussion": "議論内容の詳細"}],
  "decisions": ["決定事項"],
  "todos": [{"task": "タスク内容", "assignee": "担当者（不明は未定）", "deadline": "期限（不明は空）"}],
  "next_meeting": "次回会議の予定（なければ空）",
  "inferred_attendees": "推測される出席者名カンマ区切り（不明は空）"
}`

const DETAILED_SYSTEM = `あなたの役割は、会議内容を短く要約することではなく、実務で後から確認できる議事録を作成することです。

【最重要方針】
- 情報を省略・圧縮しすぎないこと
- 話された内容を、可能な限り忠実に反映すること
- 短く整えることよりも、内容の網羅性を優先すること
- 不明な情報は推測せず、「不明」「確認できず」と記載すること
- 会話に出ていない内容を補完しないこと

【必ず拾う情報】
- 議題 / 背景 / 議論の経緯 / 主な意見
- 確認された事実 / 決定事項 / 未決事項 / 懸念点
- 担当者 / 期限 / 次回確認事項 / 次のアクション

【介護施設・カンファレンスの場合に必ず拾う情報】
- 利用者名 / 現在の状態 / 状態変化
- 食事・水分・排泄・睡眠・痛み・ADL・認知面の変化
- 医療・看護・介護間の連携事項
- 家族対応に関する内容 / ケア方針 / リスク
- 記録・申し送りが必要な事項 / 誰が何をいつまでに行うか

【表現ルール】
「〜という意見が出た」「〜が確認された」「〜については未決」「〜は今後確認する」
など、会議での扱いが分かる表現にすること。

【禁止】
- 重要な発言を一般論に丸めること
- 決定事項と検討事項を混同すること
- 担当者や期限を勝手に作ること
- 内容を美化・補完すること

${OUTPUT_SCHEMA}`

const SUMMARY_SYSTEM = `あなたは会議議事録の要約を作成するアシスタントです。
構造化抽出結果をもとに、Word2枚程度（約800〜1200字）の要約版議事録を作成してください。

【要約版のルール】
- 詳細版の構造を維持する
- 背景や議論の経緯は圧縮する
- 決定事項・担当者・期限・次のアクションは省略しない
- 情報が不明な場合は推測しない
- 重要な懸念点・リスクは残す

${OUTPUT_SCHEMA}`

function parseMinutes(text: string, label: string): any {
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error(`${label}のJSONが見つかりませんでした`)
  return JSON.parse(jsonMatch[0])
}

export async function POST(req: NextRequest) {
  try {
    const { structured, meetingInfo } = await req.json()
    if (!structured) return NextResponse.json({ error: 'structured が必要です' }, { status: 400 })

    const ctxLines: string[] = []
    if (meetingInfo?.name)  ctxLines.push(`会議名：${meetingInfo.name}`)
    if (meetingInfo?.att)   ctxLines.push(`出席者：${meetingInfo.att}`)
    if (meetingInfo?.place) ctxLines.push(`場所：${meetingInfo.place}`)
    const ctx = ctxLines.length ? ctxLines.join('\n') + '\n\n' : ''

    const structuredStr = JSON.stringify(structured, null, 2)
    const userContent = `${ctx}【構造化抽出結果】\n${structuredStr}`
    const inputCharCount = userContent.length

    const [detailedRes, summaryRes] = await Promise.all([
      client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: DETAILED_SYSTEM,
        messages: [{ role: 'user', content: userContent }],
      }),
      client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SUMMARY_SYSTEM,
        messages: [{ role: 'user', content: userContent }],
      }),
    ])

    const detailedText = detailedRes.content.filter(b => b.type === 'text').map(b => (b as any).text).join('')
    const summaryText  = summaryRes.content.filter(b => b.type === 'text').map(b => (b as any).text).join('')

    const detailed = parseMinutes(detailedText, '詳細版')
    const summary  = parseMinutes(summaryText,  '要約版')

    console.log('[generate] success', JSON.stringify({
      model: MODEL,
      maxTokens: MAX_TOKENS,
      inputCharCount,
      inputTokenEstimate: estimateTokens(userContent),
      detailedOutputCharCount: detailedText.length,
      summaryOutputCharCount: summaryText.length,
      outputTokenEstimate: estimateTokens(detailedText + summaryText),
    }))

    return NextResponse.json({ detailed, summary })
  } catch (e: any) {
    console.error('[generate] error:', e.message)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
