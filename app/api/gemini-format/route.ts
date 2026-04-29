import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

const GEMINI_MODEL = 'gemini-2.5-flash-lite'
// 上記が使えない場合のフォールバック候補: 'gemini-2.5-flash-lite-preview-06-17' / 'gemini-2.0-flash-lite'

const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`

const SYSTEM_PROMPT = `あなたは会議音声の文字起こしを、人間が確認・修正しやすい文章に整える補助役です。

これは完成した議事録ではありません。
最終的な議事録は、この後で別のAIが作成します。

次の文字起こしを、意味を変えずに読みやすく整えてください。

やってほしいこと：
- 「えー」「あの」「まあ」「なんか」「その」などの不要な口癖を削る
- 「そうですね」「はい」「なるほど」など、内容に影響しない相づちを削る
- 言い直しや重複を整理する
- 長すぎる文を分ける
- 話の順序が少し崩れている場合は、意味が変わらない範囲で自然に並べ替える
- です・ます調、または自然な記録文調に整える

守ってほしいこと：
- 内容を要約しすぎない
- 発言にない情報を追加しない
- 固有名詞を推測で補完しない
- 話者IDがある場合は消さない
- 議事録形式や箇条書きにはしない

出力は、整えた本文だけにしてください。`

export async function POST(request: Request): Promise<NextResponse> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    console.error('[gemini-format] GEMINI_API_KEY not set')
    return NextResponse.json({ error: 'GEMINI_API_KEY が設定されていません' }, { status: 500 })
  }

  let text: string
  let context: string
  try {
    const body = await request.json()
    text    = String(body?.text    ?? '').trim()
    context = String(body?.context ?? '').trim()
  } catch {
    return NextResponse.json({ error: 'リクエスト形式が不正です' }, { status: 400 })
  }

  if (!text) {
    return NextResponse.json({ formatted: '' })
  }

  // 直前ブロックを文脈として渡すことで約60秒分の文脈で整文
  const userText = context
    ? `${SYSTEM_PROMPT}\n\n【直前の発話ブロック（参考文脈・整文不要）】\n${context}\n\n【整文対象の発話ブロック】\n${text}`
    : `${SYSTEM_PROMPT}\n\n---\n${text}`

  try {
    const res = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: userText }] }],
        generationConfig: { temperature: 0.1 },
      }),
    })

    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      let errMsg = errBody.slice(0, 400)
      try {
        const parsed = JSON.parse(errBody)
        errMsg = parsed?.error?.message ?? errMsg
      } catch { /* ignore */ }
      console.error(`[gemini-format] API error status=${res.status} model=${GEMINI_MODEL} message=${errMsg}`)
      const returnStatus = res.status === 429 ? 429 : 502
      return NextResponse.json({ error: `Gemini API error: ${res.status}` }, { status: returnStatus })
    }

    const data = await res.json()
    const formatted: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
    return NextResponse.json({ formatted: formatted.trim() || text })
  } catch (e: any) {
    console.error(`[gemini-format] fetch exception model=${GEMINI_MODEL}:`, e?.message)
    return NextResponse.json({ error: 'Gemini APIへの接続に失敗しました' }, { status: 502 })
  }
}
