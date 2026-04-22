# 議事録メーカー v3

録音 → Deepgram 文字起こし → Claude Haiku 構造化 → Word 出力

## アーキテクチャ

```
[ブラウザ] MediaRecorder で録音
    ↓
[/api/upload-audio]  Vercel Blob に保存（edge runtime）
    ↓ blob URL
[/api/transcribe]    Deepgram Nova-3 Multilingual で文字起こし
    ↓ transcript
[/api/generate]      Claude Haiku で議事録構造化（JSON）
    ↓
[ブラウザ] プレビュー表示 → 編集 → docx.js で Word 出力
```

## 必要な API キー（3つ）

| サービス | 用途 | 取得先 |
|---|---|---|
| Anthropic | Claude Haiku | https://console.anthropic.com |
| Deepgram | Nova-3 STT | https://console.deepgram.com |
| Vercel Blob | 音声保存 | Vercel ダッシュボード > Storage |

## セットアップ

```bash
npm install

cp .env.local.example .env.local
# → .env.local に上記3つのキーを記入

npm run dev
# → http://localhost:3000
```

## Vercel デプロイ

1. GitHub にプッシュ
2. Vercel でリポジトリをインポート
3. Storage タブで Blob ストアを作成してプロジェクトに紐付け
4. Environment Variables に ANTHROPIC_API_KEY と DEEPGRAM_API_KEY を追加
5. Deploy

> **注意**: 長時間の会議録音（30分以上）は文字起こしに時間がかかります。
> Vercel Pro プランで `maxDuration = 300`（5分）を設定しています。
> Hobby プランの場合は短い会議向けになります。

## UX フロー

1. 録音ボタンを押してすぐ録音開始（会議情報の入力は不要）
2. 録音前・中・後に会議名・出席者・場所などを入力（すべて任意）
3. 停止 → 自動で保存 → 文字起こし → 議事録生成
4. プレビューで確認・編集
5. Word (.docx) 出力（出力後も再編集・再出力可能）

## 設計の優先順位

1. **録音データが消えない** → Vercel Blob に先保存。処理失敗時もデータは残る
2. **操作が増えない** → 録音ファースト、会議情報はいつでも入力可
3. **議事録の品質** → Deepgram Nova-3（雑音・複数話者対応）+ Claude Haiku
