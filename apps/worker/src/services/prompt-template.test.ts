import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  getWeeklyTheme,
  parseTemplateOutput,
  buildPromptTemplateFlexMessage,
  generatePromptWithClaude,
} from './prompt-template.js'

vi.mock('@line-crm/db', () => ({
  createBroadcast: vi.fn().mockResolvedValue({ id: 'broadcast-1' }),
  updateBroadcastStatus: vi.fn().mockResolvedValue(undefined),
}))

describe('getWeeklyTheme', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('4週でテーマがローテーションする', () => {
    const weekMs = 7 * 24 * 60 * 60 * 1000
    vi.setSystemTime(new Date(0))
    const theme0 = getWeeklyTheme()
    vi.setSystemTime(new Date(4 * weekMs))
    const theme4 = getWeeklyTheme()
    expect(theme0.label).toBe(theme4.label)
  })

  it('4種類のテーマが全て存在する', () => {
    const weekMs = 7 * 24 * 60 * 60 * 1000
    const labels = new Set<string>()
    for (let i = 0; i < 4; i++) {
      vi.setSystemTime(new Date(i * weekMs))
      labels.add(getWeeklyTheme().label)
    }
    expect(labels.size).toBe(4)
  })
})

describe('parseTemplateOutput', () => {
  it('正しいフォーマットを解析できる', () => {
    const raw = `[TITLE]
SNS投稿文の生成

[PROMPT]
【商品名】のInstagram投稿文を作成してください。

[POINT]
【】を具体的に埋めるほど精度が上がります`

    const result = parseTemplateOutput(raw)
    expect(result.title).toBe('SNS投稿文の生成')
    expect(result.prompt).toContain('Instagram投稿文')
    expect(result.point).toContain('【】を具体的に')
  })

  it('フォーマットが崩れていてもクラッシュしない', () => {
    const result = parseTemplateOutput('壊れた出力')
    expect(result.title).toBe('AIプロンプト')
    expect(result.prompt).toBe('')
    expect(result.point).toBe('')
  })
})

describe('buildPromptTemplateFlexMessage', () => {
  it('typeがflexになる', () => {
    const parsed = { title: 'タイトル', prompt: 'プロンプト内容', point: 'コツ' }
    const theme = { label: '集客・SNS投稿文', emoji: '📣' } as const
    const msg = buildPromptTemplateFlexMessage(parsed, theme) as { type: string }
    expect(msg.type).toBe('flex')
  })

  it('altTextにテーマ名が含まれる', () => {
    const parsed = { title: 'タイトル', prompt: 'プロンプト内容', point: 'コツ' }
    const theme = { label: '採用・求人票', emoji: '👥' } as const
    const msg = buildPromptTemplateFlexMessage(parsed, theme) as { altText: string }
    expect(msg.altText).toContain('採用・求人票')
  })
})

describe('generatePromptWithClaude', () => {
  it('Claude APIが200を返すと文字列を返す', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: '[TITLE]\nテスト\n[PROMPT]\nプロンプト\n[POINT]\nコツ' }],
      }),
    }))

    const theme = { label: '集客・SNS投稿文', emoji: '📣' } as const
    const result = await generatePromptWithClaude(theme, 'test-key')
    expect(result).toContain('[TITLE]')
  })

  it('Claude APIがエラーを返すと例外を投げる', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }))

    const theme = { label: '集客・SNS投稿文', emoji: '📣' } as const
    await expect(generatePromptWithClaude(theme, 'test-key')).rejects.toThrow('Claude API error: 500')
  })
})
