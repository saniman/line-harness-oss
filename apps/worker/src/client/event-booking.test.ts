// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'

interface EventPublic {
  id: number
  title: string
  description: string | null
  start_at: string
  end_at: string
  capacity: number
  participant_count: number
  remaining: number
  available: boolean
}

const EVENT1: EventPublic = {
  id: 1, title: '無料セミナー', description: '初心者歓迎です',
  start_at: '2026-06-01T10:00:00+09:00', end_at: '2026-06-01T12:00:00+09:00',
  capacity: 10, participant_count: 3, remaining: 7, available: true,
}
const EVENT_FULL: EventPublic = {
  id: 2, title: '満席イベント', description: null,
  start_at: '2026-06-15T14:00:00+09:00', end_at: '2026-06-15T16:00:00+09:00',
  capacity: 5, participant_count: 5, remaining: 0, available: false,
}

import { buildEventListHtml, buildEventDetailHtml, submitJoin } from './event-booking.js'

afterEach(() => { vi.unstubAllGlobals() })

describe('renderEventList', () => {
  it('公開イベント一覧が表示される', () => {
    const html = buildEventListHtml([EVENT1])
    expect(html).toContain('無料セミナー')
  })

  it('残席数が表示される', () => {
    const html = buildEventListHtml([EVENT1])
    expect(html).toContain('7')
  })

  it('満席イベントはボタンがdisabledになる', () => {
    const html = buildEventListHtml([EVENT_FULL])
    expect(html).toContain('disabled')
    expect(html).toContain('満席')
  })

  it('イベントがない場合「現在募集中のイベントはありません」と表示', () => {
    const html = buildEventListHtml([])
    expect(html).toContain('現在募集中のイベントはありません')
  })
})

describe('renderEventDetail', () => {
  it('イベント詳細（タイトル・日時・残席）が表示される', () => {
    const html = buildEventDetailHtml(EVENT1)
    expect(html).toContain('無料セミナー')
    expect(html).toContain('7')
  })

  it('参加フォーム（名前・メール）が表示される', () => {
    const html = buildEventDetailHtml(EVENT1)
    expect(html).toContain('join-name')
    expect(html).toContain('join-email')
    expect(html).toContain('join-submit')
  })
})

describe('submitJoin', () => {
  it('名前・メール入力後に申込できる', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 201,
      json: async () => ({ success: true, data: {} }),
    }))
    const result = await submitJoin(1, '山田太郎', 'test@example.com')
    expect(result.success).toBe(true)
  })

  it('名前が空の場合バリデーションエラー', async () => {
    const result = await submitJoin(1, '', 'test@example.com')
    expect(result.success).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('メール形式が不正の場合バリデーションエラー', async () => {
    const result = await submitJoin(1, '山田太郎', 'invalid-email')
    expect(result.success).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('満席（409）の場合エラーメッセージを表示', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 409 }))
    const result = await submitJoin(1, '山田太郎', 'test@example.com')
    expect(result.success).toBe(false)
    expect(result.error).toContain('満席')
  })

  it('申込成功後に完了画面を表示（success=trueを返す）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 201,
      json: async () => ({ success: true, data: {} }),
    }))
    const result = await submitJoin(1, '山田太郎', 'test@example.com')
    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
  })
})
