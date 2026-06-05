import type { LineClient } from '@line-crm/line-sdk';
import { createBroadcast, updateBroadcastStatus } from '@line-crm/db';

export interface NewsItem {
  title: string
  link: string
  pubDate: string
  description: string
  source: string
}

export interface ParsedAiNews {
  summary: string
  items: { emoji: string; title: string; point: string }[]
}

const RSS_FEEDS = [
  { url: 'https://hnrss.org/newest?q=AI+OR+LLM+OR+Claude+OR+GPT+OR+Gemini&points=100&count=20', source: 'Hacker News' },
  { url: 'https://techcrunch.com/category/artificial-intelligence/feed/', source: 'TechCrunch' },
  { url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', source: 'The Verge' },
  { url: 'https://rss.itmedia.co.jp/rss/2.0/aiplus.xml', source: 'ITmedia AI+' },
  { url: 'https://aismiley.co.jp/feed/', source: 'AIsmiley' },
]

const SYSTEM_PROMPT = `あなたはAI・テクノロジー専門のキュレーターです。
提供されたニュース記事から日本語の週次ダイジェストを以下のフォーマットで作成してください。

【出力フォーマット（厳守）】

[SUMMARY]
今週全体を通じたインサイト1〜2文。最後の1文は「私たちが引き続きAI活用を自分ごととしてキャッチアップしていくことが大切」という趣旨を自然な言葉で添える。「WALOVERとしては」等の自社宣伝的な表現は使わない。80字以内。

[NEWS]
絵文字|タイトル（日本語・20字以内）|要点を1文で（50字以内）
（5件、1行1件、|区切り）

【絵文字の使い分け】
🤖=LLMリリース 🇯🇵=国内ニュース 🔬=研究 🛠️=開発ツール ⚡=速報 📊=統計

【選定基準（優先順）】
1. 大手LLMのリリース・重要アップデート
2. 国内企業・行政のAI活用・規制動向
3. 研究成果（実用化に近いもの）
4. 開発者向けツール・APIの変更

先頭の挨拶・後書き・URLは含めないこと。`

function extractTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`, 'i'))
  return m ? m[1].trim() : ''
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim()
}

export function parseRssItems(xml: string, source: string): NewsItem[] {
  try {
    const items: NewsItem[] = []

    // RSS 2.0 の <item> タグ
    const itemRegex = /<item>([\s\S]*?)<\/item>/g
    let m: RegExpExecArray | null
    while ((m = itemRegex.exec(xml)) !== null) {
      const block = m[1]
      const title = stripHtml(extractTag(block, 'title'))
      const link = extractTag(block, 'link') || extractTag(block, 'guid')
      const pubDate = extractTag(block, 'pubDate') || extractTag(block, 'dc:date')
      const description = stripHtml(extractTag(block, 'description'))
      if (title && link) items.push({ title, link, pubDate, description, source })
    }

    // Atom の <entry> タグ（The Verge 等）
    if (items.length === 0) {
      const entryRegex = /<entry>([\s\S]*?)<\/entry>/g
      while ((m = entryRegex.exec(xml)) !== null) {
        const block = m[1]
        const title = stripHtml(extractTag(block, 'title'))
        const linkMatch = block.match(/<link[^>]+href="([^"]+)"/)
        const link = linkMatch ? linkMatch[1] : ''
        const pubDate = extractTag(block, 'published') || extractTag(block, 'updated')
        const description = stripHtml(extractTag(block, 'summary') || extractTag(block, 'content'))
        if (title && link) items.push({ title, link, pubDate, description, source })
      }
    }

    return items
  } catch {
    return []
  }
}

export function deduplicateNews(items: NewsItem[], limit: number): NewsItem[] {
  const seenLinks = new Set<string>()
  const result: NewsItem[] = []
  for (const item of items) {
    if (seenLinks.has(item.link)) continue
    seenLinks.add(item.link)
    result.push(item)
    if (result.length >= limit) break
  }
  return result
}

export async function fetchAiNewsItems(count = 30): Promise<NewsItem[]> {
  const results = await Promise.allSettled(
    RSS_FEEDS.map(async ({ url, source }) => {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'LineHarness-AINews/1.0 (Cloudflare Workers)' },
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) throw new Error(`${source} fetch failed: ${res.status}`)
      const xml = await res.text()
      return parseRssItems(xml, source)
    }),
  )

  const allItems: NewsItem[] = []
  for (const r of results) {
    if (r.status === 'fulfilled') allItems.push(...r.value)
    else console.warn('[ai-news] RSS fetch error:', r.reason)
  }

  return deduplicateNews(allItems, count)
}

export function buildSummarizePrompt(items: NewsItem[]): string {
  const list = items
    .map((item, i) => `[${i + 1}] ${item.title} (${item.source})\n${item.description.slice(0, 150)}`)
    .join('\n\n')
  const now = new Date()
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000)
  const weekLabel = `${String(jst.getUTCMonth() + 1).padStart(2, '0')}/${String(jst.getUTCDate()).padStart(2, '0')}`
  return `週：${weekLabel}週\n\n以下の${items.length}件から5件を選んでダイジェストを作成してください：\n\n${list}`
}

export async function summarizeNewsWithClaude(items: NewsItem[], apiKey: string): Promise<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: buildSummarizePrompt(items) }],
    }),
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`Anthropic API error ${response.status}: ${err}`)
  }

  const data = await response.json() as { content: Array<{ type: string; text: string }> }
  return data.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

export function parseAiNewsSections(raw: string): ParsedAiNews {
  const summaryMatch = raw.match(/\[SUMMARY\]\n([\s\S]*?)(?=\[NEWS\]|$)/)
  const newsMatch = raw.match(/\[NEWS\]\n([\s\S]*)$/)

  const summary = summaryMatch ? summaryMatch[1].trim() : raw.trim()

  const items = newsMatch
    ? newsMatch[1]
        .trim()
        .split('\n')
        .filter(l => l.includes('|'))
        .slice(0, 5)
        .map(l => {
          const parts = l.split('|')
          return {
            emoji: parts[0]?.trim() ?? '',
            title: parts[1]?.trim() ?? '',
            point: parts[2]?.trim() ?? '',
          }
        })
    : []

  return { summary, items }
}

export function buildAiNewsFlexMessage(summary: string, liffUrl = ''): object {
  const parsed = parseAiNewsSections(summary)
  const bookUrl = liffUrl ? `${liffUrl}?page=book` : ''

  const newsComponents = parsed.items.flatMap((item, i) => {
    const block = {
      type: 'box',
      layout: 'vertical',
      spacing: 'xs',
      contents: [
        {
          type: 'box',
          layout: 'horizontal',
          spacing: 'sm',
          contents: [
            { type: 'text', text: item.emoji, size: 'sm', flex: 0 },
            { type: 'text', text: item.title, size: 'sm', weight: 'bold', color: '#24292f', wrap: true, flex: 1 },
          ],
        },
        {
          type: 'text',
          text: `→ ${item.point}`,
          size: 'xs',
          color: '#666666',
          wrap: true,
          margin: 'xs',
        },
      ],
    }
    if (i > 0) {
      return [{ type: 'separator', margin: 'md', color: '#f0f0f0' }, block]
    }
    return [block]
  })

  // パース失敗時はプレーンテキストにフォールバック
  const bodyContents = parsed.items.length > 0
    ? newsComponents
    : [{ type: 'text', text: summary, wrap: true, size: 'sm', color: '#24292f', lineSpacing: '6px' }]

  return {
    type: 'flex',
    altText: 'AI週次ニュース ─ 今週のAIハイライトをお届けします',
    contents: {
      type: 'bubble',
      size: 'giga',
      header: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '20px',
        backgroundColor: '#0d1117',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              { type: 'text', text: '🤖 今週のAIニュース', color: '#ffffff', weight: 'bold', size: 'md', flex: 1 },
              { type: 'text', text: '毎週月曜', color: '#8b949e', size: 'xs', flex: 0, align: 'end' },
            ],
          },
          {
            type: 'box',
            layout: 'vertical',
            margin: 'md',
            paddingAll: '12px',
            backgroundColor: '#1c2128',
            cornerRadius: '8px',
            contents: [
              { type: 'text', text: '💡 今週のまとめ', color: '#f0c040', size: 'xs', weight: 'bold' },
              {
                type: 'text',
                text: parsed.summary,
                color: '#e6edf3',
                size: 'sm',
                wrap: true,
                margin: 'sm',
                lineSpacing: '4px',
              },
            ],
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '16px',
        contents: bodyContents as never[],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '12px',
        backgroundColor: '#f8fafc',
        contents: [
          {
            type: 'button',
            action: bookUrl
              ? { type: 'uri', label: '無料相談を予約する', uri: bookUrl }
              : { type: 'message', label: '無料相談を予約する', text: '無料相談予約' },
            style: 'primary',
            height: 'sm',
            color: '#06C755',
          },
        ],
      },
    } as never,
  }
}

export async function processWeeklyAiNewsBroadcast(
  db: D1Database,
  lineClient: LineClient,
  apiKey: string,
  liffUrl = '',
): Promise<void> {
  console.log('[ai-news] 週次AIニュース配信開始')

  const items = await fetchAiNewsItems(30)
  if (items.length === 0) {
    console.warn('[ai-news] ニュースアイテムが取得できませんでした')
    return
  }
  console.log(`[ai-news] ${items.length}件取得`)

  const summary = await summarizeNewsWithClaude(items, apiKey)
  console.log('[ai-news] Claude要約完了, length:', summary.length)

  const flexMessage = buildAiNewsFlexMessage(summary, liffUrl)

  const now = new Date()
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000)
  const dateLabel = `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, '0')}-${String(jst.getUTCDate()).padStart(2, '0')}`

  const broadcast = await createBroadcast(db, {
    title: `AI週次ニュース ${dateLabel}`,
    messageType: 'flex',
    messageContent: JSON.stringify(flexMessage),
    targetType: 'all',
  })

  try {
    await lineClient.broadcast([flexMessage as Parameters<typeof lineClient.broadcast>[0][number]])
    await updateBroadcastStatus(db, broadcast.id, 'sent')
    console.log('[ai-news] 配信完了 broadcastId:', broadcast.id)
  } catch (err) {
    await updateBroadcastStatus(db, broadcast.id, 'draft')
    throw err
  }
}
