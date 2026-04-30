import Anthropic from '@anthropic-ai/sdk'
import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'

const client = new Anthropic()
const MODEL = process.env.ANTHROPIC_FORMAT_MODEL || 'claude-haiku-4-5'

const SYSTEM = `あなたは会議音声の文字起こしを、人間が確認・修正しやすい文章に整える補助役です。

これは完成した議事録ではありません。
最終的な議事録は、この後で別のAIが作成します。

次の文字起こしを、意味を変えずに読みやすく整えてください。

やってほしいこと：
- 「えー」「あの」「まあ」「なんか」「その」などの不要な口癖を削る
- 「そうですね」「はい」「なるほど」など、内容に影響しない相づちを削る
- 言い直しや重複を整理する
- 長すぎる文を分ける
- 話の順序が少し崩れている場合は、意味が変わらない範囲で自然に並べ替える
- 話題や発言のまとまりごとに改行する
- 明らかな誤字や音声認識ミスは自然に直す
- です・ます調、または自然な記録文調に整える

守ってほしいこと：
- 内容を要約しすぎない
- 発言にない情報を追加しない
- 固有名詞を推測で補完しない
- 話者IDがある場合は消さない
- 議事録形式や箇条書きにはしない

出力は、整えた本文だけにしてください。`

export async function POST(req: NextRequest): Promise<NextResponse> {
  let text: string
  let context: string
  try {
    const body = await req.json()
    text    = String(body?.text    ?? '').trim()
    context = String(body?.context ?? '').trim()
  } catch {
    return NextResponse.json({ error: 'リクエスト形式が不正です' }, { status: 400 })
  }

  if (!text) {
    return NextResponse.json({ formatted: '' })
  }

  const userContent = context
    ? `【直前の発話ブロック（参考文脈・整文不要）】\n${context}\n\n【整文対象の発話ブロック】\n${text}`
    : text

  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM,
      messages: [{ role: 'user', content: userContent }],
    })

    const formatted = res.content
      .filter(b => b.type === 'text')
      .map(b => (b as any).text)
      .join('')
      .trim()

    return NextResponse.json({ formatted: formatted || text })
  } catch (e: any) {
    console.error(`[haiku-format] error model=${MODEL}:`, e?.message)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
