import { put } from '@vercel/blob'
import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'edge'

export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get('content-type') || 'audio/webm'
    const ext = contentType.includes('mp4') ? 'm4a' : 'webm'
    const filename = `meeting-${Date.now()}.${ext}`

    const result = await put(filename, req.body!, {
      access: 'public',
      contentType,
    })

    return NextResponse.json({ url: result.url })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
