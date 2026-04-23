import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  serverExternalPackages: ['@anthropic-ai/sdk', '@deepgram/sdk'],
}

export default nextConfig
