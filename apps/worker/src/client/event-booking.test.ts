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
  price?: number | null
}

const EVENT1: EventPublic = {
  id: 1, title: '無料セミナー', description: '初心者歓迎です',
  start_at: '2026-06-01T10:00:00+09:00', end_at: '2026-06-01T12:00:00+09:00',
  capacity: 10, participant_count: 3, remaining: 7, available: true, price: 3000,
}
const EVENT_FULL: EventPublic = {
  id: 2, title: '満席イベント', description: null,
  start_at: '2026-06-15T14:00:00+09:00', end_at: '2026-06-15T16:00:00+09:00',
  capacity: 5, participant_count: 5, remaining: 0, available: false,
}

import { buildEventListHtml, buildEventDetailHtml, startCheckoutSession, initEventBooking } from './event-booking.js'

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

  it('申込・決済ボタンが表示される', () => {
    const html = buildEventDetailHtml(EVENT1)
    expect(html).toContain('checkout-btn')
    expect(html).toContain('申込・決済へ進む')
  })
})

describe('startCheckoutSession', () => {
  it('checkout-session成功時にopenWindowが呼ばれる', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ success: true, data: { url: 'https://checkout.stripe.com/pay/test' } }),
    }))
    const mockOpenWindow = vi.fn()
    const result = await startCheckoutSession(1, 'U123', mockOpenWindow)
    expect(result.success).toBe(true)
    expect(mockOpenWindow).toHaveBeenCalledWith({
      url: 'https://checkout.stripe.com/pay/test',
      external: true,
    })
  })

  it('409（満席）の場合エラーを返しopenWindowは呼ばれない', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 409 }))
    const mockOpenWindow = vi.fn()
    const result = await startCheckoutSession(1, 'U123', mockOpenWindow)
    expect(result.success).toBe(false)
    expect(result.error).toContain('満席')
    expect(mockOpenWindow).not.toHaveBeenCalled()
  })

  it('その他のエラーの場合汎用エラーを返す', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }))
    const result = await startCheckoutSession(1, 'U123', vi.fn())
    expect(result.success).toBe(false)
    expect(result.error).toBeTruthy()
  })
})

describe('payment routing', () => {
  it('payment=success で完了画面が表示される', async () => {
    document.body.innerHTML = '<div id="app"></div>'
    await initEventBooking({ payment: 'success' })
    expect(document.getElementById('app')?.innerHTML).toContain('完了')
  })

  it('payment=cancel でキャンセル画面が表示される', async () => {
    document.body.innerHTML = '<div id="app"></div>'
    await initEventBooking({ payment: 'cancel' })
    expect(document.getElementById('app')?.innerHTML).toContain('キャンセル')
  })
})
