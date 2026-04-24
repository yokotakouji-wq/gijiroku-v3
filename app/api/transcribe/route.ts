import { createClient } from '@deepgram/sdk'
import { NextRequest, NextResponse } from 'next/server'

export const maxDuration = 300

const estimateTokens = (text: string) => Math.ceil(text.length / 1.5)

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

    let transcript = ''
    const utterances = result.results?.utterances
    if (utterances?.length) {
      transcript = utterances
        .map(u => `話者${(u.speaker ?? 0) + 1}: ${u.transcript}`)
        .join('\n')
    } else {
      transcript = result.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? ''
    }

    const charCount = transcript.length
    const tokenEstimate = estimateTokens(transcript)
    const audioDuration = result.metadata?.duration

    console.log('[transcribe] success', JSON.stringify({
      charCount,
      tokenEstimate,
      audioDurationSec: audioDuration != null ? Math.round(audioDuration) : null,
    }))

    if (process.env.NODE_ENV === 'development' && process.env.DEBUG_MINUTES_SERVER === 'true') {
      console.log('[transcribe] transcript:', transcript)
    }

    return NextResponse.json({ transcript, charCount, tokenEstimate })
  } catch (e: any) {
    console.error('[transcribe] error:', e.message)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
