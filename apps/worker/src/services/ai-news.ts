import type { LineClient } from '@line-crm/line-sdk';
import { createBroadcast, updateBroadcastStatus } from '@line-crm/db';

export interface NewsItem {
  title: string
  link: string
  pubDate: string
  description: string
  source: string
}

const RSS_FEEDS = [
  { url: 'https://hnrss.org/newest?q=AI+OR+LLM+OR+Claude+OR+GPT+OR+Gemini&points=100&count=20', source: 'Hacker News' },
  { url: 'https://techcrunch.com/category/artificial-intelligence/feed/', source: 'TechCrunch' },
  { url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', source: 'The Verge' },
  { url: 'https://rss.itmedia.co.jp/rss/2.0/aiplus.xml', source: 'ITmedia AI+' },
  { url: 'https://aismiley.co.jp/feed/', source: 'AIsmiley' },
]

const SYSTEM_PROMPT = `あなたはAI・テクノロジー専門のキュレーターです。
提供されたニュース記事リストから、以下の基準で日本語の週次ダイジェストを作成してください。

【選定基準（優先順）】
1. 大手LLMのリリース・重要アップデート（GPT、Claude、Gemini、Llama等）
2. 国内企業・行政のAI活用・規制動向
3. 研究成果（実用化に近いブレークスルー）
4. 開発者向けツール・APIの変更
5. 重複・類似トピックは最も情報量が多い1件のみ選択

【出力フォーマット（厳守）】
📰 AI週次ダイジェスト（MM/DD週）
読了時間：約1分

絵文字 タイトル（日本語・25字以内）
→ 要点を1文で（60字以内）

（5〜7件繰り返し）

💡 今週のまとめ
（全体を通じた1〜2文のインサイト）

絵文字の使い分け：🤖=LLMリリース 🇯🇵=国内ニュース 🔬=研究 🛠️=開発ツール ⚡=速報 📊=統計
URLは含めないこと。先頭の挨拶・後書き不要。`

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
  return `週：${weekLabel}週\n\n以下の${items.length}件から5〜7件を選んでダイジェストを作成してください：\n\n${list}`
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

export function buildAiNewsFlexMessage(summary: string): object {
  return {
    type: 'flex',
    altText: 'AI週次ニュース ─ 今週のAIハイライトをお届けします',
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '20px',
        backgroundColor: '#0d1117',
        contents: [
          { type: 'text', text: '🤖 今週のAIニュース', color: '#ffffff', weight: 'bold', size: 'xl' },
          { type: 'text', text: '毎週月曜配信', color: '#8b949e', size: 'xs', margin: 'sm' },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '20px',
        contents: [
          {
            type: 'text',
            text: summary,
            wrap: true,
            size: 'sm',
            color: '#24292f',
            lineSpacing: '6px',
          },
        ],
      },
    },
  }
}

export async function processWeeklyAiNewsBroadcast(
  db: D1Database,
  lineClient: LineClient,
  apiKey: string,
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

  const flexMessage = buildAiNewsFlexMessage(summary)

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
