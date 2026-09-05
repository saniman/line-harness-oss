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
  application_closed?: boolean
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
// 締切（開始1時間前を過ぎた）イベント。空席はあるが申し込めない。
const EVENT_CLOSED: EventPublic = {
  id: 4, title: '締切イベント', description: null,
  start_at: '2026-06-20T19:00:00+09:00', end_at: '2026-06-20T21:00:00+09:00',
  capacity: 10, participant_count: 2, remaining: 8, available: true, price: 3000,
  application_closed: true,
}
const EVENT_CLOSED_FREE: EventPublic = { ...EVENT_CLOSED, id: 5, price: null }
const EVENT_CLOSED_AND_FULL: EventPublic = {
  ...EVENT_CLOSED, id: 6, participant_count: 10, remaining: 0, available: false,
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

  it('締切前のイベントはボタンが押せる（デグレ防止）', () => {
    const html = buildEventListHtml([EVENT_PAID])
    expect(html).not.toContain('disabled')
    expect(html).not.toContain('締めきられました')
  })

  it('締切後のイベントは「締めきられました」と表示されボタンがdisabledになる', () => {
    const html = buildEventListHtml([EVENT_CLOSED])
    expect(html).toContain('締めきられました')
    expect(html).toContain('disabled')
    // 空席はあるので「満席」と誤表示してはいけない
    expect(html).not.toContain('満席')
  })

  it('満席かつ締切後は締切表示を優先する（満席は空きを期待させるため）', () => {
    const html = buildEventListHtml([EVENT_CLOSED_AND_FULL])
    expect(html).toContain('締めきられました')
    expect(html).toContain('disabled')
    expect(html).not.toContain('満席')
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

/** exp を持つダミーの ID トークン（JWT 形式） */
function makeIdToken(expSeconds: number): string {
  const b64url = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${b64url({ alg: 'HS256' })}.${b64url({ exp: expSeconds, sub: 'U1' })}.sig`
}

describe('ID トークン期限切れの扱い（#28）', () => {
  it('401 + id_token_expired なら sessionExpired: true を返す', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 401,
      json: async () => ({ success: false, error: 'id_token_expired' }),
    }))
    const result = await startCheckoutSession(1, ID_TOKEN, vi.fn())
    expect(result.success).toBe(false)
    expect(result.sessionExpired).toBe(true)
  })

  it('401 でも期限切れ以外なら sessionExpired を立てない', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 401,
      json: async () => ({ success: false, error: 'unauthorized' }),
    }))
    const result = await startCheckoutSession(1, ID_TOKEN, vi.fn())
    expect(result.success).toBe(false)
    expect(result.sessionExpired).toBeFalsy()
  })

  it('期限切れのトークンはサーバーに送らず sessionExpired を返す（無駄な往復をしない）', async () => {
    const mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)
    const expired = makeIdToken(Date.now() / 1000 - 60)

    const result = await startCheckoutSession(1, expired, vi.fn())

    expect(result.sessionExpired).toBe(true)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('現金申込も期限切れなら sessionExpired を返す（決済ボタンと同じ経路のため）', async () => {
    const mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)
    const expired = makeIdToken(Date.now() / 1000 - 60)

    const result = await joinCashEvent(1, expired, '山田太郎')

    expect(result.sessionExpired).toBe(true)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('無料申込も期限切れなら sessionExpired を返す', async () => {
    const mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)
    const expired = makeIdToken(Date.now() / 1000 - 60)

    const result = await joinFreeEvent(2, expired, '山田太郎')

    expect(result.sessionExpired).toBe(true)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('有効期限内のトークンは通常どおり送信する', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) })
    vi.stubGlobal('fetch', mockFetch)
    const fresh = makeIdToken(Date.now() / 1000 + 3600)

    const result = await joinFreeEvent(2, fresh, '山田太郎')

    expect(result.success).toBe(true)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})

describe('renderEventDetail（申込締切）', () => {
  it('締切後は「このイベントの申し込みは締めきられました」と表示する', () => {
    const html = buildEventDetailHtml(EVENT_CLOSED)
    expect(html).toContain('このイベントの申し込みは締めきられました')
  })

  it('有料イベントは決済ボタンと当日現金ボタンの両方が押せなくなる', () => {
    const html = buildEventDetailHtml(EVENT_CLOSED)
    const checkout = html.match(/<button id="checkout-btn"[^>]*>/)?.[0] ?? ''
    const cash = html.match(/<button id="cash-join-btn"[^>]*>/)?.[0] ?? ''
    expect(checkout).toContain('disabled')
    expect(cash).toContain('disabled')
  })

  it('無料イベントも締切後は申し込めない', () => {
    const html = buildEventDetailHtml(EVENT_CLOSED_FREE)
    const free = html.match(/<button id="free-join-btn"[^>]*>/)?.[0] ?? ''
    expect(free).toContain('disabled')
    expect(html).toContain('このイベントの申し込みは締めきられました')
  })

  it('締切前は両方のボタンが押せる（デグレ防止）', () => {
    const html = buildEventDetailHtml(EVENT_PAID)
    const checkout = html.match(/<button id="checkout-btn"[^>]*>/)?.[0] ?? ''
    const cash = html.match(/<button id="cash-join-btn"[^>]*>/)?.[0] ?? ''
    expect(checkout).not.toContain('disabled')
    expect(cash).not.toContain('disabled')
    expect(html).not.toContain('締めきられました')
  })
})

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

describe('409 の区別（満席 / 締切）', () => {
  const closed409 = () => ({
    ok: false, status: 409, json: async () => ({ success: false, error: 'application_closed' }),
  })

  it('409 application_closed は締切の文言を返す（満席と混同しない）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(closed409()))
    const result = await joinFreeEvent(2, ID_TOKEN, '山田太郎')
    expect(result.success).toBe(false)
    expect(result.error).toContain('締めきられました')
    expect(result.error).not.toContain('満席')
  })

  it('当日現金の 409 application_closed も締切の文言になる', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(closed409()))
    const result = await joinCashEvent(1, ID_TOKEN, '山田太郎')
    expect(result.error).toContain('締めきられました')
  })

  it('決済の 409 application_closed も締切の文言になり openWindow を呼ばない', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(closed409()))
    const openWindow = vi.fn()
    const result = await startCheckoutSession(1, ID_TOKEN, openWindow)
    expect(result.error).toContain('締めきられました')
    expect(openWindow).not.toHaveBeenCalled()
  })

  it('error コードのない 409 は従来どおり満席として扱う', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 409 }))
    const result = await joinFreeEvent(2, ID_TOKEN, '山田太郎')
    expect(result.error).toContain('満席')
  })
})

describe('画面を開いたまま締切をまたいだとき', () => {
  const closed409 = () => ({
    ok: false, status: 409, json: async () => ({ success: false, error: 'application_closed' }),
  })

  /** 一覧取得は成功、その後の申込リクエストは締切 409 を返す */
  const fetchThenClosed = (event: EventPublic) => vi.fn()
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true, data: [event] }) })
    .mockResolvedValue(closed409())

  it('無料申込が締切409なら、ボタンは無効のままで押し続けられない', async () => {
    document.body.innerHTML = '<div id="app"></div>'
    vi.stubGlobal('fetch', fetchThenClosed(EVENT_FREE))

    await initEventBooking({ idToken: ID_TOKEN, eventId: EVENT_FREE.id })
    const btn = document.getElementById('free-join-btn') as HTMLButtonElement
    btn.click()

    await vi.waitFor(() => {
      expect(document.getElementById('app')?.innerHTML).toContain('このイベントの申し込みは締めきられました')
    })
    // 「処理中...」のまま固まらせず、締切として無効化する
    const after = document.getElementById('free-join-btn') as HTMLButtonElement
    expect(after.disabled).toBe(true)
    expect(after.textContent).not.toContain('申し込む（無料）')
  })

  it('決済が締切409なら、当日現金ボタンも一緒に無効になる（裏口を残さない）', async () => {
    document.body.innerHTML = '<div id="app"></div>'
    vi.stubGlobal('fetch', fetchThenClosed(EVENT_PAID))

    await initEventBooking({ idToken: ID_TOKEN, eventId: EVENT_PAID.id })
    ;(document.getElementById('checkout-btn') as HTMLButtonElement).click()

    await vi.waitFor(() => {
      expect(document.getElementById('app')?.innerHTML).toContain('このイベントの申し込みは締めきられました')
    })
    expect((document.getElementById('checkout-btn') as HTMLButtonElement).disabled).toBe(true)
    // 押されたボタンだけ止めても、もう一方の経路から申し込めてしまう
    expect((document.getElementById('cash-join-btn') as HTMLButtonElement).disabled).toBe(true)
  })

  it('当日現金が締切409なら、決済ボタンも一緒に無効になる', async () => {
    document.body.innerHTML = '<div id="app"></div>'
    vi.stubGlobal('fetch', fetchThenClosed(EVENT_PAID))

    await initEventBooking({ idToken: ID_TOKEN, eventId: EVENT_PAID.id })
    ;(document.getElementById('cash-join-btn') as HTMLButtonElement).click()

    await vi.waitFor(() => {
      expect(document.getElementById('app')?.innerHTML).toContain('このイベントの申し込みは締めきられました')
    })
    expect((document.getElementById('cash-join-btn') as HTMLButtonElement).disabled).toBe(true)
    expect((document.getElementById('checkout-btn') as HTMLButtonElement).disabled).toBe(true)
  })

  it('満席の409では従来どおりボタンが戻る（締切と混同しない）', async () => {
    document.body.innerHTML = '<div id="app"></div>'
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true, data: [EVENT_FREE] }) })
      .mockResolvedValue({ ok: false, status: 409 }))

    await initEventBooking({ idToken: ID_TOKEN, eventId: EVENT_FREE.id })
    ;(document.getElementById('free-join-btn') as HTMLButtonElement).click()

    await vi.waitFor(() => { expect(document.querySelector('.form-error')).not.toBeNull() })
    const btn = document.getElementById('free-join-btn') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    expect(btn.textContent).toContain('申し込む（無料）')
  })
})

describe('締切後も友だち追加の導線を潰さない（要件の肝）', () => {
  it('締切イベントでも申込画面は描画される（友だち追加後の戻り先が消えない）', async () => {
    document.body.innerHTML = '<div id="app"></div>'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ success: true, data: [EVENT_CLOSED] }),
    }))

    await initEventBooking({ idToken: ID_TOKEN, eventId: EVENT_CLOSED.id })

    // 締切でもエラー画面にせず申込画面を出す。友だち追加 → onFriendAdded で
    // ここへ戻ってくる導線（main.ts の initEventFlow）が成立しなくなるため。
    const html = document.getElementById('app')?.innerHTML ?? ''
    expect(html).toContain(EVENT_CLOSED.title)
    expect(html).toContain('このイベントの申し込みは締めきられました')
    expect(document.querySelector('.form-error')).toBeNull()
  })

  it('締切イベントは一覧のカードを押しても詳細に進めない（ボタンが無効）', async () => {
    document.body.innerHTML = '<div id="app"></div>'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ success: true, data: [EVENT_CLOSED] }),
    }))

    await initEventBooking({ idToken: ID_TOKEN })

    const btn = document.querySelector('.event-join-btn') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
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

describe('領収書の宛名欄（#66）', () => {
  it('有料イベントには宛名の入力欄が出る', () => {
    const html = buildEventDetailHtml(EVENT_PAID, 'あきひさ')
    expect(html).toContain('receipt-name-input')
    expect(html).toContain('領収書の宛名')
  })

  it('無料イベントには宛名の入力欄を出さない', () => {
    // 領収書を出すのは当日現金の経路だけ。無料に置いても使い道が無く、
    // 申込のハードルだけ上がる
    const html = buildEventDetailHtml(EVENT_FREE, 'あきひさ')
    expect(html).not.toContain('receipt-name-input')
  })

  it('入力は任意だと分かる表記になっている', () => {
    const html = buildEventDetailHtml(EVENT_PAID, 'あきひさ')
    expect(html).toContain('任意')
  })

  it('【重要】未入力時に何になるかを、実際の表示名で見せる', () => {
    // 「LINEの表示名になります」だけでは自分の表示名を思い出せない。
    // 実物を出せば、ニックネーム登録の人がその場で気づける。
    const html = buildEventDetailHtml(EVENT_PAID, 'あきひさ')
    expect(html).toContain('あきひさ')
  })

  it('【重要】表示名が取れないときこそ、入力を促す警告を出す', () => {
    // 表示名が空 = サーバー側のフォールバックも空になるケース。
    // ここで黙ると、一番警告が要る人に何も出ないことになる。
    const html = buildEventDetailHtml(EVENT_PAID, '')
    expect(html).toContain('receipt-name-input')
    expect(html).not.toContain('が宛名になります')
    expect(html).toContain('お名前を取得できませんでした')
  })

  it('表示名を HTML エスケープする', () => {
    // LINE の表示名は自由文字列。エスケープしないと画面が壊れる
    const html = buildEventDetailHtml(EVENT_PAID, '<script>alert(1)</script>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('宛名を渡さない既存の呼び出しでも壊れない（後方互換）', () => {
    const html = buildEventDetailHtml(EVENT_PAID)
    expect(html).toContain('checkout-btn')
  })
})

describe('joinCashEvent の宛名送信', () => {
  const ID_TOKEN_FRESH = ID_TOKEN

  it('宛名を渡すと receiptName として送る', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) })
    vi.stubGlobal('fetch', fetchMock)

    await joinCashEvent(2, ID_TOKEN_FRESH, '山田太郎', '株式会社サンプル')

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.receiptName).toBe('株式会社サンプル')
    expect(body.paymentMethod).toBe('cash')
  })

  it('宛名を渡さなければ receiptName を送らない（後方互換）', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) })
    vi.stubGlobal('fetch', fetchMock)

    await joinCashEvent(2, ID_TOKEN_FRESH, '山田太郎')

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.receiptName).toBeUndefined()
  })
})

describe('宛名欄と決済ボタンの関係（#68 レビュー⑥）', () => {
  it('宛名欄は当日現金ボタンの直前に置く（決済ボタンから離す）', () => {
    // 宛名を読むのは現金フローだけ。決済ボタンの真上にあると、
    // 入力してから決済を押した人の入力が黙って消える。
    const html = buildEventDetailHtml(EVENT_PAID, 'あきひさ')
    const receiptIdx = html.indexOf('receipt-name-input')
    const checkoutIdx = html.indexOf('checkout-btn')
    const cashIdx = html.indexOf('cash-join-btn')
    expect(receiptIdx).toBeGreaterThan(checkoutIdx)
    expect(receiptIdx).toBeLessThan(cashIdx)
  })

  it('宛名が現金専用だと分かる文言になっている', () => {
    // ⚠️ '当日現金' だけだと既存ボタンの「当日現金の方はこちら 💴」で通ってしまい、
    //    宛名欄を丸ごと消しても緑のままになる。ラベル固有の文言で確認する。
    const html = buildEventDetailHtml(EVENT_PAID, 'あきひさ')
    expect(html).toContain('当日現金でお支払いの方のみ')
  })
})
