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

const EVENT_PAID: EventPublic = {
  id: 1, title: '有料セミナー', description: '初心者歓迎です',
  start_at: '2026-06-01T10:00:00+09:00', end_at: '2026-06-01T12:00:00+09:00',
  capacity: 10, participant_count: 3, remaining: 7, available: true, price: 3000,
}
const EVENT_FREE: EventPublic = {
  id: 2, title: '無料セミナー', description: null,
  start_at: '2026-06-15T14:00:00+09:00', end_at: '2026-06-15T16:00:00+09:00',
  capacity: 20, participant_count: 5, remaining: 15, available: true, price: null,
}
const EVENT1 = EVENT_PAID
const EVENT_FULL: EventPublic = {
  id: 3, title: '満席イベント', description: null,
  start_at: '2026-06-15T14:00:00+09:00', end_at: '2026-06-15T16:00:00+09:00',
  capacity: 5, participant_count: 5, remaining: 0, available: false, price: null,
}

import { buildEventListHtml, buildEventDetailHtml, startCheckoutSession, joinFreeEvent, joinCashEvent, initEventBooking } from './event-booking.js'

afterEach(() => { vi.unstubAllGlobals() })

describe('renderEventList', () => {
  it('公開イベント一覧が表示される', () => {
    const html = buildEventListHtml([EVENT_PAID, EVENT_FREE])
    expect(html).toContain('有料セミナー')
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
    const html = buildEventDetailHtml(EVENT_PAID)
    expect(html).toContain('有料セミナー')
    expect(html).toContain('7')
  })

  it('有料イベントは「申込・決済へ進む 💳」ボタンが表示される', () => {
    const html = buildEventDetailHtml(EVENT_PAID)
    expect(html).toContain('checkout-btn')
    expect(html).toContain('申込・決済へ進む')
    expect(html).not.toContain('free-join-form')
  })

  it('有料イベントは「当日現金の方はこちら」ボタンが表示される', () => {
    const html = buildEventDetailHtml(EVENT_PAID)
    expect(html).toContain('cash-join-btn')
    expect(html).toContain('当日現金の方はこちら')
  })

  it('無料イベントは当日現金ボタンが表示されない', () => {
    const html = buildEventDetailHtml(EVENT_FREE)
    expect(html).not.toContain('cash-join-btn')
  })

  it('無料イベント（price=null）はワンクリック申し込みボタンが表示される', () => {
    const html = buildEventDetailHtml(EVENT_FREE)
    expect(html).toContain('free-join-btn')
    expect(html).not.toContain('join-name')
    expect(html).not.toContain('join-email')
    expect(html).not.toContain('id="checkout-btn"')
  })

  it('無料イベントは「申し込む（無料）」ボタンが表示される', () => {
    const html = buildEventDetailHtml(EVENT_FREE)
    expect(html).toContain('申し込む（無料）')
  })

  it('参加費が表示される（有料）', () => {
    const html = buildEventDetailHtml(EVENT_PAID)
    expect(html).toContain('3,000')
  })
})

const ID_TOKEN = 'dummy.id.token'

describe('startCheckoutSession', () => {
  it('checkout-session成功時にopenWindowが呼ばれる', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ success: true, data: { url: 'https://checkout.stripe.com/pay/test' } }),
    }))
    const mockOpenWindow = vi.fn()
    const result = await startCheckoutSession(1, ID_TOKEN, mockOpenWindow)
    expect(result.success).toBe(true)
    expect(mockOpenWindow).toHaveBeenCalledWith({
      url: 'https://checkout.stripe.com/pay/test',
      external: true,
    })
  })

  it('Authorization: Bearer <idToken> を送る', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ success: true, data: { url: 'https://checkout.stripe.com/pay/test' } }),
    })
    vi.stubGlobal('fetch', mockFetch)
    await startCheckoutSession(1, ID_TOKEN, vi.fn())
    expect(mockFetch.mock.calls[0][1].headers['Authorization']).toBe(`Bearer ${ID_TOKEN}`)
  })

  it('409（満席）の場合エラーを返しopenWindowは呼ばれない', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 409 }))
    const mockOpenWindow = vi.fn()
    const result = await startCheckoutSession(1, ID_TOKEN, mockOpenWindow)
    expect(result.success).toBe(false)
    expect(result.error).toContain('満席')
    expect(mockOpenWindow).not.toHaveBeenCalled()
  })

  it('403（友だち未登録）の場合 friendRequired: true を返す', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }))
    const result = await startCheckoutSession(1, ID_TOKEN, vi.fn())
    expect(result.success).toBe(false)
    expect(result.friendRequired).toBe(true)
    expect(result.error).toContain('友だち追加')
  })

  it('503（友だち判定不能）は friendRequired にせず再試行を促す', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))
    const result = await startCheckoutSession(1, ID_TOKEN, vi.fn())
    expect(result.success).toBe(false)
    expect(result.friendRequired).toBeFalsy()
    expect(result.error).toContain('しばらくして')
  })

  it('その他のエラーの場合汎用エラーを返す', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }))
    const result = await startCheckoutSession(1, ID_TOKEN, vi.fn())
    expect(result.success).toBe(false)
    expect(result.error).toBeTruthy()
    expect(result.friendRequired).toBeFalsy()
  })
})

describe('joinFreeEvent', () => {
  it('無料申込成功時に success: true を返す', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 201,
      json: async () => ({ success: true, data: { id: 10 } }),
    }))
    const result = await joinFreeEvent(2, ID_TOKEN, '山田太郎')
    expect(result.success).toBe(true)
  })

  it('Authorization: Bearer <idToken> を送り、lineUserId は body に含めない', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true, status: 201,
      json: async () => ({ success: true, data: { id: 10 } }),
    })
    vi.stubGlobal('fetch', mockFetch)
    await joinFreeEvent(2, ID_TOKEN, '山田太郎')
    expect(mockFetch.mock.calls[0][1].headers['Authorization']).toBe(`Bearer ${ID_TOKEN}`)
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.lineUserId).toBeUndefined()
    expect(body.name).toBe('山田太郎')
  })

  it('409（満席）の場合エラーを返す', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 409 }))
    const result = await joinFreeEvent(2, '', '山田太郎')
    expect(result.success).toBe(false)
    expect(result.error).toContain('満席')
  })

  it('403（友だち未登録）の場合 friendRequired: true を返す', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }))
    const result = await joinFreeEvent(2, ID_TOKEN, '山田太郎')
    expect(result.friendRequired).toBe(true)
  })

  it('その他のエラーの場合汎用エラーを返す', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }))
    const result = await joinFreeEvent(2, '', '山田太郎')
    expect(result.success).toBe(false)
    expect(result.error).toBeTruthy()
  })
})

describe('joinCashEvent', () => {
  it('現金申込成功時に success: true を返す', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 201,
      json: async () => ({ success: true, data: { id: 10 } }),
    }))
    const result = await joinCashEvent(1, ID_TOKEN, '山田太郎')
    expect(result.success).toBe(true)
  })

  it('リクエストボディに paymentMethod: cash が含まれる', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true, status: 201,
      json: async () => ({ success: true, data: { id: 10 } }),
    })
    vi.stubGlobal('fetch', mockFetch)
    await joinCashEvent(1, ID_TOKEN, '山田太郎')
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.paymentMethod).toBe('cash')
    expect(mockFetch.mock.calls[0][1].headers['Authorization']).toBe(`Bearer ${ID_TOKEN}`)
  })

  it('409（満席）の場合エラーを返す', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 409 }))
    const result = await joinCashEvent(1, '', '山田太郎')
    expect(result.success).toBe(false)
    expect(result.error).toContain('満席')
  })

  it('403（友だち未登録）の場合 friendRequired: true を返す', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }))
    const result = await joinCashEvent(1, ID_TOKEN, '山田太郎')
    expect(result.friendRequired).toBe(true)
  })
})

describe('友だち登録必須ゲート（403 friend_required）', () => {
  it('申込が403なら onFriendRequired が呼ばれ、エラー文言は出さない', async () => {
    document.body.innerHTML = '<div id="app"></div>'
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true, data: [EVENT_FREE] }) })
      .mockResolvedValueOnce({ ok: false, status: 403 })
    vi.stubGlobal('fetch', mockFetch)
    const onFriendRequired = vi.fn()

    await initEventBooking({ idToken: ID_TOKEN, eventId: EVENT_FREE.id, onFriendRequired })
    const btn = document.getElementById('free-join-btn') as HTMLButtonElement | null
    expect(btn).not.toBeNull()
    btn!.click()

    await vi.waitFor(() => { expect(onFriendRequired).toHaveBeenCalled() })
    expect(document.querySelector('.form-error')).toBeNull()
  })

  it('onFriendRequired が false を返したら（誘導しなかったら）エラー文言を出す', async () => {
    document.body.innerHTML = '<div id="app"></div>'
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true, data: [EVENT_FREE] }) })
      .mockResolvedValueOnce({ ok: false, status: 403 })
    vi.stubGlobal('fetch', mockFetch)
    const onFriendRequired = vi.fn().mockReturnValue(false)

    await initEventBooking({ idToken: ID_TOKEN, eventId: EVENT_FREE.id, onFriendRequired })
    ;(document.getElementById('free-join-btn') as HTMLButtonElement).click()

    await vi.waitFor(() => { expect(document.querySelector('.form-error')).not.toBeNull() })
    expect(onFriendRequired).toHaveBeenCalled()
  })

  it('403以外の失敗では onFriendRequired を呼ばずエラー文言を出す', async () => {
    document.body.innerHTML = '<div id="app"></div>'
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true, data: [EVENT_FREE] }) })
      .mockResolvedValueOnce({ ok: false, status: 409 })
    vi.stubGlobal('fetch', mockFetch)
    const onFriendRequired = vi.fn()

    await initEventBooking({ idToken: ID_TOKEN, eventId: EVENT_FREE.id, onFriendRequired })
    ;(document.getElementById('free-join-btn') as HTMLButtonElement).click()

    await vi.waitFor(() => { expect(document.querySelector('.form-error')).not.toBeNull() })
    expect(onFriendRequired).not.toHaveBeenCalled()
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
