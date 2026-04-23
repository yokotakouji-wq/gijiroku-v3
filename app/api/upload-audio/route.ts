import { handleUpload, type HandleUploadBody } from '@vercel/blob/client'
import { NextResponse } from 'next/server'

export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json()) as HandleUploadBody

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const expected = process.env.APP_UPLOAD_PASSWORD
        if (expected && clientPayload !== expected) {
          throw new Error('認証エラー: アップロードが許可されていません')
        }
        if (!pathname.startsWith('audio/')) {
          throw new Error('Invalid pathname')
        }
        return {
          allowedContentTypes: ['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/*', 'video/webm'],
          maximumSizeInBytes: 500 * 1024 * 1024,
        }
      },
      onUploadCompleted: async ({ blob }) => {
        console.log('Upload completed:', blob.url)
      },
    })

    return NextResponse.json(jsonResponse)
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 400 }
    )
  }
}
