# 作業ログ：議事録メーカーのパイプライン変更

日付：2026-04-30
ブランチ：main
コミット：43725a9 / 8ab42c4 / e28b2d1

---

## 結論

録音中に書記係が確認・修正したテキスト（liveBlocks）を、最終的な議事録生成に正しく渡すように修正した。
あわせて長時間会議への対応（5分チャンク録音）と、AIモデルをGemini混在からClaude統一（Haiku/Sonnet）に切り替えた。

---

## こうじがやろうとしていたこと

議事録メーカーの品質向上とコスト最適化。
録音中に書記係がAI整文結果を確認・修正しているのに、それが最終議事録に反映されていなかった（ずっとDeepgramの生テキストだけで議事録が作られていた）。
この仕様ミスを直しつつ、長時間会議（60分〜）に耐えられる構造にし、GeminiへのAPI依存も除去したかった。

---

## Claude Codeが行ったこと

### 1. liveBlocks 接続の修正（最重要）

録音中、Deepgram WebSocketの生テキストは一定間隔でブロックに区切られ（`seal()`）、HaikuによるAI整文が行われて `liveBlocks[].text` に入っていた。
しかし停止後の議事録生成パイプラインは `liveBlocks` を無視し、別途Deepgram pre-recordedで取得した生テキスト（`fullTranscript`）を使っていた。

修正内容：
- `liveBlocksRef` を追加し、Reactステートと常に同期させた
- `buildLiveBlocksTranscript()` ヘルパーを追加
  - `include: true` のブロックのみ対象
  - `block.text`（Haiku整文・ユーザー修正済み）を使い、空なら `block.orig` にフォールバック
  - `[00:00〜05:00]` のタイムラベル付きで結合
- `processAllChunks()` 末尾でliveBlocksトランスクリプトを主入力として使うように変更
  - liveBlocksが空または全除外の場合のみDeepgram生テキストにフォールバック
- `dbgTranscript` にはSonnetへ実際に渡したテキストを保存（再試行・再生成でも同じテキストが使われる）

### 2. 長時間会議対応（5分チャンク録音）

- `AudioChunk` 型を追加（index / startedAt / endedAt / durationSec / blob / url / transcript / status / error）
- `CHUNK_DURATION_MS = 5 * 60 * 1000`（5分）で定数化
- `startChunkRecorder()` / `rotateChunk()` を追加
  - 5分ごとにMediaRecorderをstop→startする（同じstreamを維持しつつ）
  - stopして得られるBlobは独立した完全なWebMファイルとして扱える
  - バイト分割は行わない（壊れるため）
- `processAllChunks()` でチャンクごとにupload→transcribe→削除（ベストエフォート）
- `app/api/delete-audio/route.ts` を新規追加（全チャンク処理後にBlobをまとめて削除）

### 3. 議事録本文生成のHaiku化

- `/api/extract`（構造化抽出）: `ANTHROPIC_EXTRACT_MODEL || 'claude-sonnet-4-6'` → Sonnet維持
- `/api/generate`（本文生成）: `ANTHROPIC_GENERATE_MODEL || 'claude-haiku-4-5'` → Haikuに変更
- 共通の `ANTHROPIC_MODEL` 環境変数をルートごとに分離した

### 4. ライブ整文のGemini→Haiku置き換え

- `app/api/gemini-format/route.ts` の中身を完全置き換え
- エンドポイント名・リクエスト形式・レスポンス形式は維持（`page.tsx` 変更なし）
- `ANTHROPIC_FORMAT_MODEL || 'claude-haiku-4-5'` を追加
- プロンプトに「話題や発言のまとまりごとに改行する」「明らかな誤字や音声認識ミスは自然に直す」を追加

---

## 変更したファイル

| ファイル | 変更内容 |
|---|---|
| `app/page.tsx` | liveBlocksRef追加・buildLiveBlocksTranscript追加・5分チャンク録音全体・processAllChunks・エラーUI更新 |
| `app/api/delete-audio/route.ts` | 新規追加。Vercel Blobのチャンク削除（ベストエフォート） |
| `app/api/extract/route.ts` | MODEL定数を `ANTHROPIC_EXTRACT_MODEL` に変更 |
| `app/api/generate/route.ts` | MODEL定数を `ANTHROPIC_GENERATE_MODEL || 'claude-haiku-4-5'` に変更 |
| `app/api/gemini-format/route.ts` | Gemini実装を全面置き換え。AnthropicSDK + Haikuに変更 |

---

## 判断理由

**なぜバイト分割でなくMediaRecorder再起動でチャンク化したか**
WebMはコンテナ形式のため、途中からバイト切断すると再生不能になる。MediaRecorderをstop→startすると、各セッションが完全なWebMファイルとして出力されるため安全。

**なぜエンドポイント名 /api/gemini-format を維持したか**
`page.tsx` の呼び出し側を変えずに済み、影響範囲を最小化できるため。中身だけ置き換えるほうがリスクが低い。

**なぜliveBlocksが空のときDeepgram生テキストにフォールバックするか**
DeepgramのWebSocket接続が失敗した場合や、ユーザーが全ブロックを除外した場合に議事録生成が止まらないようにするため。

**なぜBlobの削除を全チャンク完了後にまとめてするか**
個別削除は複雑になる。失敗しても議事録生成を止めないベストエフォート方針に合っている。

---

## うまくいったこと

- TypeScriptチェック・Next.jsビルドがすべて通過した
- 3コミットがクリーンに分離できた（機能ごとに独立したコミット）
- `page.tsx` の他の機能（Word出力・編集・再生成・一時停止）は変更なし
- `/api/extract` が Sonnet、`/api/generate` が Haiku、ライブ整文が Haiku と、モデルが機能ごとに分離できた
- 一時停止中はchunkIntervalRefが動き続けるが、rotateChunk()内のガードで実害がないことを確認

---

## 失敗・未確認のこと

- **実録音テスト未実施**。コードが動くかどうかはまだ確認していない
- `[pipeline] Sonnet入力: liveBlocks由来` のログが実際に出るかは未確認
- Haikuのライブ整文の品質が実用レベルかは未確認（Geminiから変わって劣化している可能性もある）
- 書記係が修正した内容が最終Wordに実際に反映されるかは未確認
- Deepgram WebSocketが長時間一時停止でタイムアウトするかは未確認（設計上は問題ないと判断しているが実証できていない）
- 5分チャンク録音でチャンク境界をまたいだ発言がどう扱われるかは未確認
- 話者IDがチャンクをまたいでリセットされる問題は既知の制限として残っている（Phase 2対応予定）

---

## git status

コミット済みの変更：3件（43725a9 / 8ab42c4 / e28b2d1）がmainブランチに積まれており、originにはまだpushされていない。

未コミットの変更：`next-env.d.ts` と `tsconfig.tsbuildinfo` のみ（ビルド時に自動生成されるファイルで、コミット対象外）。

未追跡ファイル：`.claude/` 配下のコマンドファイル・Obsidian設定・docs配下のチャットログが残っているが、今回の作業対象外。

---

## git diff の要点

`next-env.d.ts` と `tsconfig.tsbuildinfo` のみ。Next.jsのビルドが自動更新するファイルで、コード上の変更は何もない。

---

## 次にやること

1. **実録音テスト**
   - 実際にマイクで録音して、停止後にコンソールログで `[pipeline] Sonnet入力: liveBlocks由来` が出るか確認する
   - ライブ整文がHaikuで表示されているか確認する

2. **書記係確認フローの検証**
   - ライブブロックを修正して議事録を生成し、修正内容がWordに反映されているか確認する

3. **短時間録音・長時間録音のテスト**
   - 3分録音（1チャンク）で正常動作するか
   - 7分録音（2チャンク）でチャンク分割・連結が正常か

4. **必要であれば品質調整**
   - Haikuの整文品質が低ければプロンプト調整またはSonnetに戻すことを検討

---

## ミナ・エリス・Claude Codeへ渡す用

---

今回のセッションで、議事録メーカーの処理パイプラインを大きく変更しました。

**変更の概要（一言）：**
録音中に書記係が確認・修正したテキストを、最終議事録生成に正しく渡すようにした。

**現在のパイプライン：**
1. Deepgram（WebSocket）でライブ文字起こし
2. Haikuがブロックごとに整文（旧：Gemini Flash Lite）
3. 書記係が画面で確認・修正
4. 録音停止後、確認済みテキストをSonnetで構造化抽出
5. Haikuで詳細版・要約版の議事録本文を生成（旧：Sonnet）
6. Word出力

**3つのコミットが積まれています（未push）：**
- `43725a9` use haiku for minutes generation
- `8ab42c4` connect live blocks and improve audio cleanup
- `e28b2d1` replace gemini live formatting with haiku

**未確認のこと：**
実録音テストをまだやっていません。コードは型チェック・ビルドが通っていますが、実際にマイクで録音して動くかどうかは次のセッションで確認が必要です。

**次にやること：**
実録音テストと、一時停止の挙動確認。
