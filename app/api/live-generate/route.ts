import Anthropic from '@anthropic-ai/sdk'
import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const maxDuration = 300

const client = new Anthropic()
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'
const MAX_TOKENS = 4096

const SYSTEM = `あなたは会議の議事録作成専門家です。以下のルールで議事録をMarkdown形式で作成してください：

- include: false のセグメントは除外する（内容にも言及しない）
- status: "pending" のセグメントは内容の末尾に「※要確認」と明記する
- important: true のセグメントは決定事項・重要事項として強調する
- memo がある場合は関連する箇所に「[補足: ...]」として組み込む
- 会話に出ていない内容を補完・推測しない
- Markdown形式、日本語で記述する
- 構成：## 会議の概要、## 議題・要点（議題ごとに分ける）、## 決定事項、## 課題・TODO、## 次回会議（情報があれば）

【禁止】
- 情報の推測・補完
- 決定事項と検討中事項の混同
- 担当者・期限の創作`

export async function POST(req: NextRequest) {
  try {
    const { segments } = await req.json()
    if (!segments?.length) {
      return NextResponse.json({ error: 'segments が必要です' }, { status: 400 })
    }

    const res = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: `以下の確認済みtranscriptセグメントから議事録を作成してください：\n\n${JSON.stringify(segments, null, 2)}`,
      }],
    })

    const text = res.content.filter(b => b.type === 'text').map(b => (b as any).text).join('')
    console.log('[live-generate] success', JSON.stringify({ model: MODEL, outputChars: text.length }))

    return NextResponse.json({ text })
  } catch (e: any) {
    console.error('[live-generate] error:', e.message)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
