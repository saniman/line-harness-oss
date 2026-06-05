import { describe, it, expect, vi, afterEach } from 'vitest'
import { parseRssItems, deduplicateNews, buildAiNewsFlexMessage, buildSummarizePrompt, parseAiNewsSections } from './ai-news.js'

afterEach(() => { vi.unstubAllGlobals() })

const SAMPLE_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Feed</title>
    <item>
      <title><![CDATA[OpenAI releases GPT-5]]></title>
      <link>https://example.com/gpt5</link>
      <pubDate>Mon, 02 Jun 2026 10:00:00 +0000</pubDate>
      <description><![CDATA[OpenAI has released GPT-5 with improved reasoning.]]></description>
    </item>
    <item>
      <title>Claude 4 Opus announced</title>
      <link>https://example.com/claude4</link>
      <pubDate>Sun, 01 Jun 2026 08:00:00 +0000</pubDate>
      <description>Anthropic announced Claude 4 Opus.</description>
    </item>
  </channel>
</rss>`

const ATOM_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Gemini 2.0 Update</title>
    <link href="https://example.com/gemini2"/>
    <published>2026-06-01T09:00:00Z</published>
    <summary>Google updates Gemini.</summary>
  </entry>
</feed>`

describe('parseRssItems', () => {
  it('RSS 2.0から NewsItem を抽出できる', () => {
    const items = parseRssItems(SAMPLE_RSS, 'TestFeed')
    expect(items).toHaveLength(2)
    expect(items[0].title).toBe('OpenAI releases GPT-5')
    expect(items[0].link).toBe('https://example.com/gpt5')
    expect(items[0].source).toBe('TestFeed')
  })

  it('CDATAセクションを正しく除去する', () => {
    const items = parseRssItems(SAMPLE_RSS, 'TestFeed')
    expect(items[0].title).not.toContain('CDATA')
    expect(items[0].description).not.toContain('CDATA')
  })

  it('Atomフィードから NewsItem を抽出できる', () => {
    const items = parseRssItems(ATOM_RSS, 'TheVerge')
    expect(items).toHaveLength(1)
    expect(items[0].title).toBe('Gemini 2.0 Update')
  })

  it('item が 0 件の RSS で空配列を返す', () => {
    const items = parseRssItems('<rss><channel></channel></rss>', 'Empty')
    expect(items).toHaveLength(0)
  })

  it('壊れた XML でも例外を投げず空配列を返す', () => {
    const items = parseRssItems('this is not xml at all <<<', 'Broken')
    expect(items).toHaveLength(0)
  })
})

describe('deduplicateNews', () => {
  const items = [
    { title: 'GPT-5 release', link: 'https://tc.com/a', pubDate: '', description: '', source: 'TechCrunch' },
    { title: 'GPT-5 launch', link: 'https://verge.com/a', pubDate: '', description: '', source: 'The Verge' },
    { title: 'Claude 4 update', link: 'https://tc.com/b', pubDate: '', description: '', source: 'TechCrunch' },
    { title: 'Gemini news', link: 'https://hn.com/c', pubDate: '', description: '', source: 'HN' },
    { title: 'Extra item', link: 'https://hn.com/d', pubDate: '', description: '', source: 'HN' },
  ]

  it('上限件数でスライスする', () => {
    const result = deduplicateNews(items, 3)
    expect(result.length).toBeLessThanOrEqual(3)
  })

  it('同一URLの記事を重複除去する', () => {
    const dupes = [
      { title: 'A', link: 'https://same.com/1', pubDate: '', description: '', source: 'S1' },
      { title: 'B', link: 'https://same.com/1', pubDate: '', description: '', source: 'S2' },
    ]
    const result = deduplicateNews(dupes, 10)
    expect(result).toHaveLength(1)
  })
})

describe('parseAiNewsSections', () => {
  const STRUCTURED = `[SUMMARY]
今週はLLMの精度向上が目立った。WALOVERでは導入支援を行っています。

[NEWS]
🤖|GPT-5がリリース|推論能力が大幅向上した
🇯🇵|国内企業がAI導入|○○社が業務自動化を発表
🔬|新研究が公開|マルチモーダル性能が向上`

  it('[SUMMARY]セクションをsummaryとして抽出する', () => {
    const result = parseAiNewsSections(STRUCTURED)
    expect(result.summary).toContain('LLMの精度向上')
    expect(result.summary).not.toContain('[SUMMARY]')
  })

  it('[NEWS]セクションをitemsとして分解する', () => {
    const result = parseAiNewsSections(STRUCTURED)
    expect(result.items).toHaveLength(3)
    expect(result.items[0].emoji).toBe('🤖')
    expect(result.items[0].title).toBe('GPT-5がリリース')
    expect(result.items[0].point).toBe('推論能力が大幅向上した')
  })

  it('5件を超えるNEWSは5件にスライスする', () => {
    const many = `[SUMMARY]\nまとめ\n\n[NEWS]\n🤖|A|aaa\n🤖|B|bbb\n🤖|C|ccc\n🤖|D|ddd\n🤖|E|eee\n🤖|F|fff`
    const result = parseAiNewsSections(many)
    expect(result.items).toHaveLength(5)
  })

  it('[SUMMARY]/[NEWS]がない場合はrawをsummaryとして返す', () => {
    const result = parseAiNewsSections('プレーンテキストのまとめです')
    expect(result.summary).toBe('プレーンテキストのまとめです')
    expect(result.items).toHaveLength(0)
  })
})

describe('buildAiNewsFlexMessage', () => {
  const STRUCTURED_SUMMARY = `[SUMMARY]
今週はGPT-5が話題を席巻した。

[NEWS]
🤖|GPT-5がリリース|推論能力が大幅向上`

  it('type="flex" のメッセージを返す', () => {
    const msg = buildAiNewsFlexMessage(STRUCTURED_SUMMARY)
    expect((msg as { type: string }).type).toBe('flex')
  })

  it('altText に「AI週次ニュース」が含まれる', () => {
    const msg = buildAiNewsFlexMessage(STRUCTURED_SUMMARY)
    expect((msg as { altText: string }).altText).toContain('AI週次ニュース')
  })

  it('summary テキストが header に含まれる', () => {
    const msg = buildAiNewsFlexMessage(STRUCTURED_SUMMARY)
    expect(JSON.stringify(msg)).toContain('GPT-5')
  })

  it('liffUrl がある場合フッターに予約ボタンのURIが含まれる', () => {
    const msg = buildAiNewsFlexMessage(STRUCTURED_SUMMARY, 'https://liff.line.me/test')
    expect(JSON.stringify(msg)).toContain('https://liff.line.me/test?page=book')
  })

  it('liffUrl がない場合メッセージアクションにフォールバックする', () => {
    const msg = buildAiNewsFlexMessage(STRUCTURED_SUMMARY, '')
    const json = JSON.stringify(msg)
    expect(json).toContain('message')
    expect(json).not.toContain('?page=book')
  })
})

describe('buildSummarizePrompt', () => {
  const items = [
    { title: 'GPT-5 release', link: 'https://tc.com/a', pubDate: '2026-06-01', description: 'New model', source: 'TechCrunch' },
    { title: 'Claude 4', link: 'https://an.com/b', pubDate: '2026-06-02', description: 'Anthropic update', source: 'AIsmiley' },
  ]

  it('全アイテムのタイトルが含まれる', () => {
    const prompt = buildSummarizePrompt(items)
    expect(prompt).toContain('GPT-5 release')
    expect(prompt).toContain('Claude 4')
  })

  it('ソース名が含まれる', () => {
    const prompt = buildSummarizePrompt(items)
    expect(prompt).toContain('TechCrunch')
  })
})
