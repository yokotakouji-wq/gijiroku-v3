import { put } from '@vercel/blob'
import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

export async function POST(request: Request): Promise<NextResponse> {
  console.log('[upload-audio] BLOB_READ_WRITE_TOKEN present:', Boolean(process.env.BLOB_READ_WRITE_TOKEN))

  try {
    const { searchParams } = new URL(request.url)
    const filename    = searchParams.get('filename')
    const contentType = searchParams.get('type')
      || request.headers.get('content-type')
      || 'audio/webm'

    console.log('[upload-audio] filename:', filename)
    console.log('[upload-audio] contentType:', contentType)
    console.log('[upload-audio] content-length header:', request.headers.get('content-length'))

    if (!filename) {
      return NextResponse.json({ error: 'filename パラメータが必要です' }, { status: 400 })
    }

    // ReadableStream を直接 put() に渡すと multipart 時に問題が出るケースがあるため
    // ArrayBuffer として受け取ってから渡す
    const arrayBuffer = await request.arrayBuffer()
    console.log('[upload-audio] body byteLength:', arrayBuffer.byteLength)

    if (arrayBuffer.byteLength === 0) {
      console.error('[upload-audio] body is empty')
      return NextResponse.json({ error: '音声データが空です' }, { status: 400 })
    }

    console.log('[upload-audio] calling put()...')
    const result = await put(filename, arrayBuffer, {
      access: 'public',
      contentType,
      multipart: arrayBuffer.byteLength > 4 * 1024 * 1024, // 4MB超のみ multipart
    })

    console.log('[upload-audio] upload succeeded')
    return NextResponse.json({ url: result.url })
  } catch (e: any) {
    console.error('[upload-audio] error name:', e?.name)
    console.error('[upload-audio] error message:', e?.message)
    return NextResponse.json({ error: 'アップロードに失敗しました' }, { status: 500 })
  }
}
