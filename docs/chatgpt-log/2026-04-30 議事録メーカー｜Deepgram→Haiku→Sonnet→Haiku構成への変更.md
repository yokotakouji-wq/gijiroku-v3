

## 結論

議事録メーカーのパイプラインを、最終的に以下の構成へ近づけた。

Deepgram  
→ Haikuライブ整文  
→ 書記係が確認・修正  
→ Sonnet構造化抽出  
→ Haiku議事録本文生成  
→ Word出力

今回の最大の修正点は、録音中に整文・確認・修正された `liveBlocks[].text` が、最終議事録生成に使われていなかった問題を修正したこと。

これにより、書記係の確認・修正作業が最終成果物に反映される設計になった。

---

## もともとの問題

調査の結果、当初の実装では以下の構造になっていた。

録音中：
Deepgram → Gemini整文 → liveBlocks[].text → 画面表示・人間修正

停止後：
Deepgram生テキスト → Sonnet構造化 → 議事録生成

つまり、録音中に書記係が確認・修正した `liveBlocks[].text` は、最終議事録生成に使われていなかった。

これは「Deepgram生文字起こしだけでは実会議レベルで内容が足りないため、AI整文＋人間確認済みテキストをSonnetに渡す」という当初目的とズレていた。

---

## 修正1：liveBlocksを最終議事録生成へ接続

`app/page.tsx` を修正し、録音停止後に `liveBlocks[].text` を結合して Sonnet 構造化へ渡すようにした。

主な変更：
- `liveBlocksRef` を追加し、常に最新の `liveBlocks` を参照できるようにした
- `buildLiveBlocksTranscript()` を追加
- `block.text` を優先し、空の場合のみ `block.orig` にfallback
- `include: true` のブロックだけを最終生成対象にする
- `include` の初期値は true であることを確認

これにより、書記係が画面上で修正した内容が、最終議事録生成に反映されるようになった。

コミット：
`8ab42c4 connect live blocks and improve audio cleanup`

---

## 修正2：長時間会議対応と音声削除

長時間会議に対応するため、5分チャンク録音処理が入った。

主な変更：
- `AudioChunk` 型
- `CHUNK_DURATION_MS`
- `startChunkRecorder()`
- `rotateChunk()`
- `processAllChunks()`
- チャンク単位のアップロード・文字起こし
- `app/api/delete-audio/route.ts` によるBlob音声削除

`delete-audio` は単独機能ではなく、チャンク録音処理の一部として機能する。

---

## 修正3：本文生成をHaikuへ変更

調査時点では、構造化抽出も議事録本文生成も Sonnet を使っていた。

変更後：
- `/api/extract` は Sonnet のまま
- `/api/generate` は Haiku に変更
- 環境変数を分離

環境変数：
- `ANTHROPIC_EXTRACT_MODEL`
- `ANTHROPIC_GENERATE_MODEL`

目的：
Sonnetは判断力が必要な構造化に集中させ、詳細版・要約版の本文生成はHaikuに任せてコストを下げる。

コミット：
`43725a9 use haiku for minutes generation`

---

## 修正4：ライブ整文をGeminiからHaikuへ置き換え

Gemini Flash Lite を使っていたライブ整文処理を、Claude Haiku に置き換えた。

変更ファイル：
- `app/api/gemini-format/route.ts`

維持したもの：
- エンドポイント名 `/api/gemini-format`
- リクエスト形式 `{ text, context }`
- レスポンス形式 `{ formatted }`
- page.tsx 側の呼び出し

追加・変更：
- Gemini REST API fetch を Anthropic SDK `client.messages.create()` に置き換え
- `ANTHROPIC_FORMAT_MODEL` を使用
- 既存の整文プロンプト思想を維持
- 話題や発言のまとまりごとの改行を明示
- 明らかな誤字や音声認識ミスの自然な修正を明示

コミット：
`e28b2d1 replace gemini live formatting with haiku`

---

## 最終モデル構成

| 処理 | モデル | 環境変数 |
|---|---|---|
| ライブ整文 | Haiku | `ANTHROPIC_FORMAT_MODEL` |
| 構造化抽出 | Sonnet | `ANTHROPIC_EXTRACT_MODEL` |
| 議事録本文生成 | Haiku | `ANTHROPIC_GENERATE_MODEL` |

最終パイプライン：

Deepgram  
→ Haikuライブ整文  
→ 書記係が確認・修正  
→ Sonnet構造化抽出  
→ Haiku議事録本文生成  
→ Word出力

---

## 一時停止ボタンの調査

一時停止を押すと、以下が止まる。

- チャンク録音
- Deepgramへの音声送信
- 録音秒数タイマー
- Haiku整文区切りタイマー

再開すると、同じ会議の続きとして録音・文字起こし・整文が再開される。  
一時停止前後の `liveBlocks` は保持され、最終生成時にまとめて Sonnet に渡る。

ただし、長時間一時停止すると Deepgram WebSocket が切れる可能性がある。

運用判断：
- 短い中断は一時停止でよい
- 数分以上の休憩は、一時停止より録音継続＋マイクミュートの方が安定する可能性が高い
- 重要会議ではiPhone録音をバックアップとして同時に回す

---

## 残る確認事項

実会議デモで確認すること：

- 録音が最後まで続くか
- ライブ整文がHaikuで読みやすく表示されるか
- `[pipeline] Sonnet入力: liveBlocks由来` が出るか
- 書記係が修正した内容が最終Word議事録に反映されるか
- 詳細版・要約版の品質が実務で使える水準か
- コスト感が現実的か

---

## 今回の学び

今回の核心は、単なるモデル置き換えではない。

重要だったのは、書記係が確認・修正したテキストを、最終成果物に接続することだった。

AI整文は表示補助ではなく、書記係の判断と修正をSonnetへ渡すための中間工程として位置づける必要がある。

この設計により、議事録メーカーは「Deepgram生文字起こしから自動生成するだけのツール」ではなく、「AI整文＋人間確認＋AI構造化」の協働型ツールに近づいた。

- 議事録メーカー｜Deepgram→Haiku→Sonnet→Haiku構成
  - 最終パイプライン
    - Deepgramで文字起こし
    - Haikuでライブ整文
    - 書記係が確認・修正
    - Sonnetで構造化抽出
    - Haikuで本文生成
    - Word出力
  - 最大の修正点
    - liveBlocks[].text が最終議事録生成に使われていなかった
    - 書記係の修正内容が無視されていた
    - liveBlocks[].text を結合してSonnetへ渡すよう修正
  - モデル分担
    - Haiku：ライブ整文
    - Sonnet：会議全体の構造化
    - Haiku：詳細版・要約版の本文生成
  - 保存済みコミット
    - 43725a9 use haiku for minutes generation
    - 8ab42c4 connect live blocks and improve audio cleanup
    - e28b2d1 replace gemini live formatting with haiku
  - 一時停止の扱い
    - 短時間なら使用可
    - 長時間ではDeepgram WebSocket切断リスク
    - 長い休憩は録音継続＋マイクミュートが安定寄り
  - 実会議デモで見ること
    - Sonnet入力がliveBlocks由来になるか
    - ライブ整文が読みやすいか
    - 修正内容がWordに反映されるか
    - 詳細版・要約版が実務水準か