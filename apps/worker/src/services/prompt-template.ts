import type { LineClient } from '@line-crm/line-sdk'
import { createBroadcast, updateBroadcastStatus } from '@line-crm/db'

const THEMES = [
  { label: '集客・SNS投稿文', emoji: '📣' },
  { label: '採用・求人票', emoji: '👥' },
  { label: '顧客対応・返信文', emoji: '💬' },
  { label: '経営計画・アイデア出し', emoji: '💡' },
] as const

type Theme = (typeof THEMES)[number]

export function getWeeklyTheme(): Theme {
  const weekIndex = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000)) % THEMES.length
  return THEMES[weekIndex]
}

export async function generatePromptWithClaude(theme: Theme, apiKey: string): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [
        {
          role: 'user',
          content: `沖縄の中小企業経営者が今日すぐChatGPTやClaudeに貼り付けて使えるプロンプトを1本作ってください。

テーマ：${theme.label}

出力フォーマット（必ずこの形式のみ）：

[TITLE]
（15字以内のタイトル）

[PROMPT]
（実際に貼り付けて使えるプロンプト。80〜150字。入力が必要な箇所は【　】で示す）

[POINT]
（使い方のコツ1文。40字以内）

余計な説明不要。上記フォーマットのみ出力。`,
        },
      ],
    }),
  })
  if (!res.ok) throw new Error(`Claude API error: ${res.status}`)
  const data = (await res.json()) as { content: Array<{ type: string; text: string }> }
  return data.content[0]?.text ?? ''
}

export interface ParsedTemplate {
  title: string
  prompt: string
  point: string
}

export function parseTemplateOutput(raw: string): ParsedTemplate {
  const titleMatch = raw.match(/\[TITLE\]\s*([\s\S]*?)(?=\[PROMPT\]|$)/)
  const promptMatch = raw.match(/\[PROMPT\]\s*([\s\S]*?)(?=\[POINT\]|$)/)
  const pointMatch = raw.match(/\[POINT\]\s*([\s\S]*?)$/)
  return {
    title: titleMatch?.[1]?.trim() || 'AIプロンプト',
    prompt: promptMatch?.[1]?.trim() || '',
    point: pointMatch?.[1]?.trim() || '',
  }
}

export function buildPromptTemplateFlexMessage(parsed: ParsedTemplate, theme: Theme): object {
  return {
    type: 'flex',
    altText: `今週のAIプロンプト ─ ${theme.label}`,
    contents: {
      type: 'bubble',
      size: 'giga',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#1a1a2e',
        paddingAll: '20px',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              { type: 'text', text: '✨', size: 'sm', flex: 0 },
              { type: 'text', text: '今週のAIプロンプト', size: 'sm', color: '#8b949e', margin: 'sm', flex: 1 },
              { type: 'text', text: '毎週木曜', size: 'sm', color: '#8b949e', align: 'end', flex: 0 },
            ],
          },
          {
            type: 'text',
            text: `${theme.emoji} ${theme.label}`,
            size: 'xl',
            weight: 'bold',
            color: '#ffffff',
            margin: 'md',
          },
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#16213e',
            cornerRadius: '8px',
            paddingAll: '12px',
            margin: 'md',
            contents: [
              {
                type: 'text',
                text: parsed.title,
                size: 'sm',
                weight: 'bold',
                color: '#e2e8f0',
                wrap: true,
              },
            ],
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '16px',
        spacing: 'md',
        contents: [
          {
            type: 'text',
            text: '📋 このまま貼り付けて使えます',
            size: 'xs',
            weight: 'bold',
            color: '#8b949e',
          },
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#f8fafc',
            cornerRadius: '8px',
            paddingAll: '14px',
            contents: [
              {
                type: 'text',
                text: parsed.prompt,
                size: 'sm',
                color: '#333333',
                wrap: true,
              },
            ],
          },
          { type: 'separator' },
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'sm',
            contents: [
              { type: 'text', text: '💡', size: 'sm', flex: 0 },
              { type: 'text', text: parsed.point, size: 'sm', color: '#555555', wrap: true, flex: 1 },
            ],
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '12px',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#06C755',
            action: {
              type: 'message',
              label: 'AI活用について相談する',
              text: 'AI活用の相談がしたい',
            },
          },
        ],
      },
    },
  }
}

export async function processWeeklyPromptTemplate(
  db: D1Database,
  lineClient: LineClient,
  apiKey: string,
): Promise<void> {
  const theme = getWeeklyTheme()
  const raw = await generatePromptWithClaude(theme, apiKey)
  const parsed = parseTemplateOutput(raw)
  const flexMessage = buildPromptTemplateFlexMessage(parsed, theme)

  const dateLabel = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(new Date())
    .replace(/\//g, '-')

  const broadcast = await createBroadcast(db, {
    title: `AIプロンプト週次 ${dateLabel}`,
    messageType: 'flex',
    messageContent: JSON.stringify(flexMessage),
    targetType: 'all',
  })

  try {
    await lineClient.broadcast([flexMessage as Parameters<typeof lineClient.broadcast>[0][number]])
    await updateBroadcastStatus(db, broadcast.id, 'sent')
    console.log('[prompt-template] 配信完了 broadcastId:', broadcast.id)
  } catch (err) {
    await updateBroadcastStatus(db, broadcast.id, 'draft')
    throw err
  }
}
