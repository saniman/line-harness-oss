import { describe, it, expect, vi, afterEach } from 'vitest'
import { isTokenExpiringSoon, isSlotOverlapping, generateSlots, buildCreateEventParams, getValidAccessToken, getFreeBusyWithRefresh } from './google-calendar.js'

describe('スロット生成', () => {
  it('10:00〜18:00で8枠生成される', () => {
    const slots = generateSlots('2025-05-01', 10, 18, 60)
    expect(slots).toHaveLength(8)
  })

  it('9:00〜18:00で9枠生成される', () => {
    const slots = generateSlots('2025-05-01', 9, 18, 60)
    expect(slots).toHaveLength(9)
  })

  it('各スロットの開始・終了が60分ずつになっている', () => {
    const slots = generateSlots('2025-05-01', 10, 12, 60)
    expect(slots).toHaveLength(2)
    const diff0 = slots[0].endAt.getTime() - slots[0].startAt.getTime()
    const diff1 = slots[1].endAt.getTime() - slots[1].startAt.getTime()
    expect(diff0).toBe(60 * 60 * 1000)
    expect(diff1).toBe(60 * 60 * 1000)
  })

  it('連続するスロットの終了時刻と次の開始時刻が一致する', () => {
    const slots = generateSlots('2025-05-01', 10, 13, 60)
    expect(slots[0].endAt.getTime()).toBe(slots[1].startAt.getTime())
    expect(slots[1].endAt.getTime()).toBe(slots[2].startAt.getTime())
  })
})

describe('FreeBusy の重複チェック', () => {
  it('スロットと予定が完全に重なっていればtrue', () => {
    // slot: 10:00〜11:00, busy: 10:00〜11:00
    const slot = { start: new Date('2025-05-01T10:00:00+09:00'), end: new Date('2025-05-01T11:00:00+09:00') }
    const busy = { start: new Date('2025-05-01T10:00:00+09:00'), end: new Date('2025-05-01T11:00:00+09:00') }
    expect(isSlotOverlapping(slot.start.getTime(), slot.end.getTime(), busy.start.getTime(), busy.end.getTime())).toBe(true)
  })

  it('予定がスロット内に収まっていればtrue', () => {
    // slot: 10:00〜11:00, busy: 10:15〜10:45
    const slot = { start: new Date('2025-05-01T10:00:00+09:00'), end: new Date('2025-05-01T11:00:00+09:00') }
    const busy = { start: new Date('2025-05-01T10:15:00+09:00'), end: new Date('2025-05-01T10:45:00+09:00') }
    expect(isSlotOverlapping(slot.start.getTime(), slot.end.getTime(), busy.start.getTime(), busy.end.getTime())).toBe(true)
  })

  it('予定がスロットの直後ならfalse（境界は重複しない）', () => {
    // slot: 10:00〜11:00, busy: 11:00〜12:00
    const slot = { start: new Date('2025-05-01T10:00:00+09:00'), end: new Date('2025-05-01T11:00:00+09:00') }
    const busy = { start: new Date('2025-05-01T11:00:00+09:00'), end: new Date('2025-05-01T12:00:00+09:00') }
    expect(isSlotOverlapping(slot.start.getTime(), slot.end.getTime(), busy.start.getTime(), busy.end.getTime())).toBe(false)
  })

  it('予定がスロットの直前ならfalse（境界は重複しない）', () => {
    // slot: 11:00〜12:00, busy: 10:00〜11:00
    const slot = { start: new Date('2025-05-01T11:00:00+09:00'), end: new Date('2025-05-01T12:00:00+09:00') }
    const busy = { start: new Date('2025-05-01T10:00:00+09:00'), end: new Date('2025-05-01T11:00:00+09:00') }
    expect(isSlotOverlapping(slot.start.getTime(), slot.end.getTime(), busy.start.getTime(), busy.end.getTime())).toBe(false)
  })

  it('予定がスロットと無関係ならfalse', () => {
    // slot: 10:00〜11:00, busy: 14:00〜15:00
    const slot = { start: new Date('2025-05-01T10:00:00+09:00'), end: new Date('2025-05-01T11:00:00+09:00') }
    const busy = { start: new Date('2025-05-01T14:00:00+09:00'), end: new Date('2025-05-01T15:00:00+09:00') }
    expect(isSlotOverlapping(slot.start.getTime(), slot.end.getTime(), busy.start.getTime(), busy.end.getTime())).toBe(false)
  })
})

describe('token_expires_at の期限切れ判定', () => {
  it('expiresAt が null ならリフレッシュ対象', () => {
    expect(isTokenExpiringSoon(null)).toBe(true)
  })

  it('トークンが5分以内に期限切れならリフレッシュ対象', () => {
    const soonExpiry = new Date(Date.now() + 4 * 60 * 1000) // 4分後
    expect(isTokenExpiringSoon(soonExpiry)).toBe(true)
  })

  it('トークンがちょうど5分後に切れる場合はリフレッシュ対象（境界値）', () => {
    const boundary = new Date(Date.now() + 5 * 60 * 1000 - 1) // 5分-1ms後
    expect(isTokenExpiringSoon(boundary)).toBe(true)
  })

  it('トークンが十分残っていればリフレッシュ不要', () => {
    const futureExpiry = new Date(Date.now() + 60 * 60 * 1000) // 1時間後
    expect(isTokenExpiringSoon(futureExpiry)).toBe(false)
  })

  it('トークンが5分超残っている場合はリフレッシュ不要', () => {
    const justOver = new Date(Date.now() + 5 * 60 * 1000 + 1000) // 5分+1秒後
    expect(isTokenExpiringSoon(justOver)).toBe(false)
  })

  it('トークンが既に期限切れならリフレッシュ対象', () => {
    const expired = new Date(Date.now() - 1000) // 1秒前
    expect(isTokenExpiringSoon(expired)).toBe(true)
  })
})

describe('createEvent', () => {
  it('guestEmailがある場合はattendeesに含まれる', () => {
    const params = buildCreateEventParams({
      title: 'テスト',
      startAt: '2026-04-25T10:00:00+09:00',
      endAt: '2026-04-25T11:00:00+09:00',
      guestEmail: 'test@example.com',
    })
    expect(params.attendees).toEqual([{ email: 'test@example.com' }])
    expect(params.sendUpdates).toBe('all')
  })

  it('guestEmailがない場合はattendeesはundefined', () => {
    const params = buildCreateEventParams({
      title: 'テスト',
      startAt: '2026-04-25T10:00:00+09:00',
      endAt: '2026-04-25T11:00:00+09:00',
    })
    expect(params.attendees).toBeUndefined()
    expect(params.sendUpdates).toBeUndefined()
  })
})

describe('getValidAccessToken', () => {
  const CONN_ID = 'conn-test-1'
  const ENV = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret' } as unknown as Parameters<typeof getValidAccessToken>[0]

  function makeStmt(firstVal: unknown) {
    return {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(firstVal),
      run: vi.fn().mockResolvedValue({}),
    }
  }
  function makeDb(...stmts: ReturnType<typeof makeStmt>[]) {
    const prepare = vi.fn()
    stmts.forEach(s => prepare.mockReturnValueOnce(s))
    return { prepare } as unknown as D1Database
  }

  afterEach(() => { vi.restoreAllMocks() })

  it('トークンが有効期限内ならリフレッシュしない', async () => {
    const futureDate = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const db = makeDb(makeStmt({ access_token: 'valid-token', refresh_token: 'rf', token_expires_at: futureDate }))
    const result = await getValidAccessToken(ENV, db, CONN_ID)

    expect(result).toBe('valid-token')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('トークンが5分以内に期限切れならリフレッシュする', async () => {
    const soonDate = new Date(Date.now() + 3 * 60 * 1000).toISOString()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ access_token: 'new-token', expires_in: 3600 }),
    }))

    const updateStmt = makeStmt(null)
    const db = makeDb(
      makeStmt({ access_token: 'old-token', refresh_token: 'rf', token_expires_at: soonDate }),
      updateStmt,
    )

    const result = await getValidAccessToken(ENV, db, CONN_ID)
    expect(result).toBe('new-token')
    expect(updateStmt.run).toHaveBeenCalled()
  })

  it('refresh_tokenがNULLなら再認証エラーを返す', async () => {
    const db = makeDb(makeStmt({ access_token: 'token', refresh_token: null, token_expires_at: null }))
    await expect(getValidAccessToken(ENV, db, CONN_ID)).rejects.toThrow('REAUTH_REQUIRED')
  })

  it('リフレッシュ成功後にD1のトークンが更新される', async () => {
    const expiredDate = new Date(Date.now() - 1000).toISOString()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ access_token: 'refreshed-token', expires_in: 3600 }),
    }))

    const updateStmt = makeStmt(null)
    const db = makeDb(
      makeStmt({ access_token: 'expired-token', refresh_token: 'rf', token_expires_at: expiredDate }),
      updateStmt,
    )

    await getValidAccessToken(ENV, db, CONN_ID)
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('UPDATE google_calendar_connections'))
    expect(updateStmt.run).toHaveBeenCalled()
  })
})

describe('getFreeBusyWithRefresh', () => {
  const CONN_ID = 'conn-fb-1'
  const ENV = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret' } as unknown as Parameters<typeof getValidAccessToken>[0]

  function makeStmt(firstVal: unknown) {
    return {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(firstVal),
      run: vi.fn().mockResolvedValue({}),
    }
  }
  function makeDb(...stmts: ReturnType<typeof makeStmt>[]) {
    const prepare = vi.fn()
    stmts.forEach(s => prepare.mockReturnValueOnce(s))
    return { prepare } as unknown as D1Database
  }

  afterEach(() => { vi.restoreAllMocks() })

  it('getValidAccessTokenを経由してFreeBusy APIを呼び出す', async () => {
    const futureDate = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    const db = makeDb(makeStmt({ access_token: 'valid-token', refresh_token: 'rf', token_expires_at: futureDate }))

    const freeBusyResponse = {
      calendars: { 'primary': { busy: [{ start: '2026-05-01T10:00:00Z', end: '2026-05-01T11:00:00Z' }] } }
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(freeBusyResponse),
    }))

    const result = await getFreeBusyWithRefresh(ENV, db, CONN_ID, 'primary', '2026-05-01T09:00:00+09:00', '2026-05-01T18:00:00+09:00')
    expect(result).toHaveLength(1)
    expect(result[0].start).toBe('2026-05-01T10:00:00Z')
  })

  it('トークンが期限切れでもリフレッシュしてFreeBusy APIを呼び出す', async () => {
    const expiredDate = new Date(Date.now() - 1000).toISOString()
    const updateStmt = makeStmt(null)
    const db = makeDb(
      makeStmt({ access_token: 'expired-token', refresh_token: 'rf', token_expires_at: expiredDate }),
      updateStmt,
    )

    const fetchMock = vi.fn()
      // 1回目: refresh token呼び出し
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ access_token: 'new-token', expires_in: 3600 }) })
      // 2回目: FreeBusy API呼び出し
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ calendars: { 'primary': { busy: [] } } }) })
    vi.stubGlobal('fetch', fetchMock)

    const result = await getFreeBusyWithRefresh(ENV, db, CONN_ID, 'primary', '2026-05-01T09:00:00+09:00', '2026-05-01T18:00:00+09:00')
    expect(result).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // 1回目がトークンリフレッシュ、2回目がFreeBusy
    expect(fetchMock.mock.calls[0][0]).toContain('oauth2.googleapis.com/token')
    expect(fetchMock.mock.calls[1][0]).toContain('freeBusy')
  })
})
