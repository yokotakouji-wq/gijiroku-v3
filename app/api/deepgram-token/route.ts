import { createClient } from '@deepgram/sdk'
import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

export async function GET() {
  if (!process.env.DEEPGRAM_API_KEY) {
    return NextResponse.json({ error: 'DEEPGRAM_API_KEY が設定されていません' }, { status: 500 })
  }
  try {
    const deepgram = createClient(process.env.DEEPGRAM_API_KEY)
    const { result, error } = await deepgram.auth.grantToken()
    if (error) throw error
    return NextResponse.json(
      { token: result.access_token, expiresIn: result.expires_in },
      { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
    )
  } catch (e: any) {
    const safeMsg = e?.err_code
      ? `${e.err_code} / ${e.err_msg ?? ''}`
      : String(e?.message ?? e)
    console.error('[deepgram-token] error:', safeMsg)
    return NextResponse.json(
      { error: 'Deepgram一時トークンの発行に失敗しました。Member以上の権限を持つAPIキーを設定してください。' },
      { status: 500 }
    )
  }
}
