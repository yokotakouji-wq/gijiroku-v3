import { createClient } from '@deepgram/sdk'
import { NextRequest, NextResponse } from 'next/server'

// Vercel Pro が必要（60秒以上かかる場合に備えて300秒に設定）
export const maxDuration = 300

export async function POST(req: NextRequest) {
  try {
    const { url } = await req.json()
    if (!url) return NextResponse.json({ error: 'url が必要です' }, { status: 400 })

    const deepgram = createClient(process.env.DEEPGRAM_API_KEY!)

    const { result, error } = await deepgram.listen.prerecorded.transcribeUrl(
      { url },
      {
        model: 'nova-3',
        language: 'ja',
        smart_format: true,
        punctuate: true,
        diarize: true,
        utterances: true,
      }
    )

    if (error) throw new Error(error.message)

    // 話者分離あり → "話者1: ..." 形式にフォーマット
    // なければ通常テキスト
    let transcript = ''
    const utterances = result.results?.utterances
    if (utterances?.length) {
      transcript = utterances
        .map(u => `話者${(u.speaker ?? 0) + 1}: ${u.transcript}`)
        .join('\n')
    } else {
      transcript = result.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? ''
    }

    return NextResponse.json({ transcript })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
