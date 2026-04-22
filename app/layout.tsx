import type { Metadata } from 'next'
import Script from 'next/script'

export const metadata: Metadata = {
  title: '議事録メーカー',
  description: '録音 → 文字起こし → AI 議事録 → Word 出力',
  viewport: 'width=device-width, initial-scale=1, maximum-scale=1',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <head>
        <Script
          src="https://unpkg.com/docx@8.5.0/build/index.umd.js"
          strategy="beforeInteractive"
        />
      </head>
      <body style={{
        margin: 0, padding: 0,
        background: '#f0f2f5',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif',
        WebkitFontSmoothing: 'antialiased',
      }}>
        {children}
      </body>
    </html>
  )
}
