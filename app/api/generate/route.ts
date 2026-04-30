import Anthropic from '@anthropic-ai/sdk'
import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const maxDuration = 300

const client = new Anthropic()
const MODEL = process.env.ANTHROPIC_GENERATE_MODEL || 'claude-haiku-4-5'
const MAX_TOKENS = 8192

const estimateTokens = (text: string) => Math.ceil(text.length / 1.5)

const OUTPUT_SCHEMA = `以下のJSON形式のみで返答してください（Markdownコードブロックなし）:
{
  "summary": "会議全体の要約（3〜5文）",
  "agenda_items": [{"title": "議題タイトル（近い内容は統合）", "discussion": "3〜6文程度の整理された本文"}],
  "decisions": ["実際に決まったことのみ"],
  "unresolved_items": ["未決事項・検討事項（まだ決まっていないこと、方針検討中のこと）"],
  "todos": [{"task": "タスク内容", "assignee": "担当者（不明は未定）", "deadline": "期限（不明は空）"}],
  "next_meeting": "次回確認事項・次回会議の予定（なければ空）",
  "inferred_attendees": "推測される出席者名カンマ区切り（不明は空）"
}`

const ADDITIONAL_INSTRUCTION_RULES = `
【追加指示について】
ユーザーから追加指示がある場合は、その指示を優先して表現・詳細度・構成を調整すること。
ただし、以下の基本ルールは追加指示より常に優先する：
- 会話に出ていない内容を補完しない
- 担当者・期限を勝手に作らない
- 決定事項と未決事項を混同しない
- 既存のJSON構造を壊さない`

const DETAILED_SYSTEM = `あなたは会議の「構造化議事録」を作成するアシスタントです。
逐語録の再現ではなく、会議内容を後から把握できる程度に整理した議事録を作成してください。

【詳細版の定義】
各議題について「何が議題か・何が確認されたか・何が決まったか・何が未決か」を整理します。
発言の細かい再現・話者ごとの言い回し・雑談・言い直し・重複は削除してください。

【議題（agenda_items）の書き方】
- 1議題あたり3〜6文程度の本文段落として整理する
- 必要に応じて箇条書きを使う
- 内容が近い議題は統合する（例：服装・着替え・洗濯 → 衣類・身だしなみ・洗濯管理）
- 話者番号（話者1より、話者2より）は原則使用しない
  - 発言者が特定の役職・立場として重要な場合のみ記載する
  - 通常は「会議全体の確認内容」として自然に整理する

【分量の目安】
- 1議題あたり3〜6文程度を基本とする
  - 短い議題：100〜250字程度でよい
  - 重要な議題のみ：300〜500字程度まで許容する
- agenda_itemsのdiscussion合計の目安：
  - 標準：1,000〜1,600字程度（30分会議相当）
  - 議題・決定事項・未決事項が多い場合：1,600〜2,500字程度
  - 内容が非常に多い場合のみ最大3,000字程度まで許容
- 文字数は会議時間ではなく、議題数・決定事項・未決事項・TODOの量に応じて調整する
  - 60分会議でも議題が少なければ1,600字前後でよい
  - 30分会議でも重要な論点が多ければ1,600字程度まで許容
- 内容が少ない場合は無理に長くしない
- 内容が多い場合でも逐語録の再現には戻らない
- 議論の経緯・確認事項・未決事項・次の対応が後から分かる程度の情報量を残す

【決定事項（decisions）】
- 実際に決まったことのみを記載する
- 検討中・方針未定のものは含めない
- 該当がなければ空配列 [] にする

【未決事項・検討事項（unresolved_items）】
- まだ決まっていないこと・方針検討中のことを記載する
- 担当者・期限が未定のアクションもここに入れる
- 該当がなければ空配列 [] にする

【TODO（todos）】
- 担当者または期限が明確なものだけを入れる
- 「担当者：未定・期限：なし」のものはtodosに入れず unresolved_items へ
- 該当がなければ空配列 [] にする

【絶対に出力しないもの】
- 「未決事項：記録なし」「決定事項：なし」「特になし」「該当なし」
- 各項目の中身がない場合は、その項目ごと空配列にする

【介護施設・カンファレンスの場合に必ず拾う情報】
- 利用者の状態変化（食事・水分・排泄・睡眠・痛み・ADL・認知面）
- ケア方針・医療・看護・介護間の連携事項
- 家族対応・リスクに関する内容
- 記録・申し送りが必要な事項

【禁止】
- 決定事項と検討事項を混同すること
- 担当者や期限を勝手に作ること
- 会話に出ていない内容を補完すること
- 内容を美化・一般論に丸めること
${ADDITIONAL_INSTRUCTION_RULES}

${OUTPUT_SCHEMA}`

const SUMMARY_SYSTEM = `あなたは会議議事録の要約を作成するアシスタントです。
構造化抽出結果をもとに、Word2枚程度（約800〜1200字）の要約版議事録を作成してください。

【要約版のルール】
- 詳細版の構造を維持する
- 背景や議論の経緯は圧縮する
- 決定事項・未決事項・担当者・期限・次のアクションは省略しない
- 情報が不明な場合は推測しない
- 重要な懸念点・リスクは残す
- 「特になし」「記録なし」は出力しない（該当なければ空配列）
${ADDITIONAL_INSTRUCTION_RULES}

${OUTPUT_SCHEMA}`

function parseMinutes(text: string, label: string): any {
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error(`${label}のJSONが見つかりませんでした`)
  return JSON.parse(jsonMatch[0])
}

export async function POST(req: NextRequest) {
  try {
    const { structured, meetingInfo, transcript, additionalInstruction } = await req.json()
    if (!structured) return NextResponse.json({ error: 'structured が必要です' }, { status: 400 })

    const ctxLines: string[] = []
    if (meetingInfo?.name)  ctxLines.push(`会議名：${meetingInfo.name}`)
    if (meetingInfo?.att)   ctxLines.push(`出席者：${meetingInfo.att}`)
    if (meetingInfo?.place) ctxLines.push(`場所：${meetingInfo.place}`)
    const ctx = ctxLines.length ? ctxLines.join('\n') + '\n\n' : ''

    const structuredStr = JSON.stringify(structured, null, 2)
    let userContent = `${ctx}【構造化抽出結果】\n${structuredStr}`
    if (transcript) {
      userContent += `\n\n【文字起こし全文（補助参照）】\n${transcript}`
    }
    if (additionalInstruction?.trim()) {
      userContent += `\n\n【追加指示】\n${additionalInstruction.trim()}`
    }
    const inputCharCount = userContent.length

    const [detailedRes, summaryRes] = await Promise.all([
      client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: DETAILED_SYSTEM,
        messages: [{ role: 'user', content: userContent }],
      }),
      client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SUMMARY_SYSTEM,
        messages: [{ role: 'user', content: userContent }],
      }),
    ])

    const detailedText = detailedRes.content.filter(b => b.type === 'text').map(b => (b as any).text).join('')
    const summaryText  = summaryRes.content.filter(b => b.type === 'text').map(b => (b as any).text).join('')

    const detailed = parseMinutes(detailedText, '詳細版')
    const summary  = parseMinutes(summaryText,  '要約版')

    console.log('[generate] success', JSON.stringify({
      model: MODEL,
      maxTokens: MAX_TOKENS,
      inputCharCount,
      inputTokenEstimate: estimateTokens(userContent),
      detailedOutputCharCount: detailedText.length,
      summaryOutputCharCount: summaryText.length,
      outputTokenEstimate: estimateTokens(detailedText + summaryText),
    }))

    return NextResponse.json({ detailed, summary })
  } catch (e: any) {
    console.error('[generate] error:', e.message)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
