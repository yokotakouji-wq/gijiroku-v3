import { handleUpload, type HandleUploadBody } from '@vercel/blob/client'
import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json()) as HandleUploadBody

  try {
    const jsonResponse = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (_pathname) => ({
        allowedContentTypes: ['audio/*'],
        maximumSizeInBytes: 200 * 1024 * 1024,  // 200MB
      }),
      onUploadCompleted: async ({ blob }) => {
        console.log('[blob-token] upload completed:', blob.url)
      },
    })
    return NextResponse.json(jsonResponse)
  } catch (e: any) {
    console.error('[blob-token] error:', e.message)
    return NextResponse.json({ error: e.message }, { status: 400 })
  }
}
