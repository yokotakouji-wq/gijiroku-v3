import { put } from '@vercel/blob'
import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

export async function POST(request: Request): Promise<NextResponse> {
  const tokenPresent = Boolean(process.env.BLOB_READ_WRITE_TOKEN)
  console.log('[upload-audio] BLOB_READ_WRITE_TOKEN present:', tokenPresent)
  if (!tokenPresent) {
    console.error('[upload-audio] BLOB_READ_WRITE_TOKEN is not set — upload will fail')
    return NextResponse.json({ error: 'サーバー設定エラー: BLOB_READ_WRITE_TOKEN が未設定です。Vercel環境変数を確認してください。' }, { status: 500 })
  }

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
    const msg: string = e?.message ?? ''
    console.error('[upload-audio] error name:', e?.name)
    console.error('[upload-audio] error message:', msg)
    console.error('[upload-audio] error status:', e?.status)
    console.error('[upload-audio] error stack:', e?.stack?.slice(0, 600))

    if (msg.includes('401') || msg.includes('Unauthorized') || msg.includes('token') || e?.status === 401) {
      console.error('[upload-audio] likely cause: BLOB_READ_WRITE_TOKEN is invalid or lacks permissions')
      return NextResponse.json({ error: 'Blob認証エラー (401): BLOB_READ_WRITE_TOKEN の権限または有効期限を確認してください' }, { status: 500 })
    }
    return NextResponse.json({ error: `アップロードに失敗しました: ${msg.slice(0, 120) || '不明なエラー'}` }, { status: 500 })
  }
}
