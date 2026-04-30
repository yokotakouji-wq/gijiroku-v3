import { del } from '@vercel/blob'
import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  try {
    const { urls } = await req.json()
    if (!Array.isArray(urls) || urls.length === 0) {
      return NextResponse.json({ ok: true })
    }
    await del(urls)
    console.log(`[delete-audio] deleted ${urls.length} blob(s)`)
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    console.error('[delete-audio] error:', e.message)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
