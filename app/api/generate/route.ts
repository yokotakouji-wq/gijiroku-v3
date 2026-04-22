import Anthropic from '@anthropic-ai/sdk'
import { NextRequest, NextResponse } from 'next/server'

const client = new Anthropic()

export async function POST(req: NextRequest) {
  try {
    const { transcript, meetingInfo } = await req.json()
    if (!transcript) return NextResponse.json({ error: 'transcript が必要です' }, { status: 400 })

    // 入力済みの会議情報をコンテキストとして渡す
    const ctxLines: string[] = []
    if (meetingInfo?.name)  ctxLines.push(`会議名：${meetingInfo.name}`)
    if (meetingInfo?.att)   ctxLines.push(`出席者：${meetingInfo.att}`)
    if (meetingInfo?.place) ctxLines.push(`場所：${meetingInfo.place}`)
    const ctx = ctxLines.length ? ctxLines.join('\n') + '\n\n' : ''

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      system: `あなたは会議の書記アシスタントです。文字起こしから構造化された議事録をJSON形式で作成してください。

以下のJSON形式のみで返答してください（Markdownコードブロックなし）:
{
  "summary": "会議全体の要約（2〜3文）",
  "agenda_items": [{"title": "議題タイトル", "discussion": "議論内容の要約"}],
  "decisions": ["決定事項"],
  "todos": [{"task": "タスク内容", "assignee": "担当者（不明は未定）", "deadline": "期限（不明は空）"}],
  "next_meeting": "次回会議の予定（なければ空）",
  "inferred_attendees": "文字起こしから推測される出席者名カンマ区切り（不明は空）"
}

ルール：
- 議題が明示されていなければ会話の流れから自然に推測する
- 決定事項とTODOは明確に言及されたものだけ抽出する
- 話者番号（話者1:, 話者2:）が含まれる場合は発言者を区別して整理する
- 会議情報が提供されている場合はそれを優先する`,
      messages: [{
        role: 'user',
        content: `${ctx}【文字起こし】\n${transcript}`,
      }],
    })

    const text = message.content
      .filter(b => b.type === 'text')
      .map(b => (b as any).text)
      .join('')

    const data = JSON.parse(text.replace(/```json|```/g, '').trim())
    return NextResponse.json(data)
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
