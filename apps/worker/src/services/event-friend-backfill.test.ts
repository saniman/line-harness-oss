import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockUpsertFriend = vi.hoisted(() => vi.fn())

vi.mock('@line-crm/db', () => ({
  upsertFriend: mockUpsertFriend,
  jstNow: () => '2026-08-14T09:00:00.000',
}))

import { backfillEventBookingFriends, BACKFILL_LIMIT } from './event-friend-backfill.js'

interface BookingRow { id: number; stripe_session_id: string | null; name: string }

/**
 * D1 モック。SQL の種類で応答を振り分ける。
 * - event_bookings の SELECT → 渡した bookings
 * - friends の SELECT        → friendsByLineUserId の一致
 * - UPDATE                   → 記録のみ
 */
function makeDb(bookings: BookingRow[], friendsByLineUserId: Record<string, string> = {}) {
  const updates: { sql: string; binds: unknown[] }[] = []
  const queries: string[] = []
  const db = {
    prepare: (sql: string) => ({
      bind: (...binds: unknown[]) => {
        queries.push(sql)
        if (/^\s*UPDATE/.test(sql)) updates.push({ sql, binds })
        return {
          all: async () => ({ results: bookings }),
          first: async () => {
            if (sql.includes('FROM friends')) {
              const id = friendsByLineUserId[binds[0] as string]
              return id ? { id } : null
            }
            return null
          },
          run: async () => ({ meta: {} }),
        }
      },
    }),
  } as unknown as D1Database
  return { db, updates, queries }
}

function makeStripe(metadataBySessionId: Record<string, Record<string, string> | null>) {
  const retrieve = vi.fn(async (id: string) => {
    if (!(id in metadataBySessionId)) throw new Error(`No such checkout session: ${id}`)
    return { metadata: metadataBySessionId[id] }
  })
  return { client: { checkout: { sessions: { retrieve } } }, retrieve }
}

const PROFILE = { userId: 'U1', displayName: '黒部誠規', pictureUrl: 'https://example.com/p.jpg' }
const NOT_FRIEND_ERROR = new Error('LINE API error: 404 Not Found — {}')

beforeEach(() => { vi.clearAllMocks() })

describe('backfillEventBookingFriends', () => {
  it('Stripe metadata の lineUserId から friends を作って booking に紐付ける（未友だちは is_following=0）', async () => {
    const { db, updates } = makeDb([{ id: 11, stripe_session_id: 'cs_1', name: '誠規 黒部' }])
    const { client } = makeStripe({ cs_1: { lineUserId: 'U1' } })
    const lineClient = { getProfile: vi.fn().mockRejectedValue(NOT_FRIEND_ERROR) }
    mockUpsertFriend.mockResolvedValue({ id: 'friend-new' })

    const result = await backfillEventBookingFriends(db, 1, client, lineClient, 'acc-1')

    expect(result).toEqual({ total: 1, linked: 1, created: 1, skipped: 0, truncated: false })
    // 未友だちなので is_following=0。表示名は Stripe の申込者名を使う（空欄だと誰か分からないため）
    expect(mockUpsertFriend).toHaveBeenCalledWith(db, {
      lineUserId: 'U1',
      displayName: '誠規 黒部',
      isFollowing: false,
      lineAccountId: 'acc-1',
    })
    expect(updates[0].sql).toContain('UPDATE event_bookings')
    expect(updates[0].binds).toEqual(['friend-new', 11])
  })

  it('LINE 上は友だちなら is_following=1 と LINE の表示名で作る', async () => {
    const { db } = makeDb([{ id: 11, stripe_session_id: 'cs_1', name: '誠規 黒部' }])
    const { client } = makeStripe({ cs_1: { lineUserId: 'U1' } })
    const lineClient = { getProfile: vi.fn().mockResolvedValue(PROFILE) }
    mockUpsertFriend.mockResolvedValue({ id: 'friend-new' })

    const result = await backfillEventBookingFriends(db, 1, client, lineClient, 'acc-1')

    expect(result.created).toBe(1)
    expect(mockUpsertFriend).toHaveBeenCalledWith(db, {
      lineUserId: 'U1',
      displayName: '黒部誠規',
      pictureUrl: 'https://example.com/p.jpg',
      statusMessage: null,
      isFollowing: true,
      lineAccountId: 'acc-1',
    })
  })

  it('friends に既に居る場合は upsert せず紐付けだけ行う', async () => {
    const { db, updates } = makeDb([{ id: 11, stripe_session_id: 'cs_1', name: 'x' }], { U1: 'friend-existing' })
    const { client } = makeStripe({ cs_1: { lineUserId: 'U1' } })
    const lineClient = { getProfile: vi.fn() }

    const result = await backfillEventBookingFriends(db, 1, client, lineClient, null)

    expect(result).toEqual({ total: 1, linked: 1, created: 0, skipped: 0, truncated: false })
    expect(mockUpsertFriend).not.toHaveBeenCalled()
    expect(lineClient.getProfile).not.toHaveBeenCalled()
    expect(updates[0].binds).toEqual(['friend-existing', 11])
  })

  it('stripe_session_id が無い申込（無料/現金）は skip する', async () => {
    const { db, updates } = makeDb([{ id: 12, stripe_session_id: null, name: 'x' }])
    const { client, retrieve } = makeStripe({})

    const result = await backfillEventBookingFriends(db, 1, client, { getProfile: vi.fn() }, null)

    expect(result).toEqual({ total: 1, linked: 0, created: 0, skipped: 1, truncated: false })
    expect(retrieve).not.toHaveBeenCalled()
    expect(updates).toHaveLength(0)
  })

  it('metadata に lineUserId が無ければ skip する', async () => {
    const { db } = makeDb([{ id: 13, stripe_session_id: 'cs_2', name: 'x' }])
    const { client } = makeStripe({ cs_2: { bookingId: '13' } })

    const result = await backfillEventBookingFriends(db, 1, client, { getProfile: vi.fn() }, null)

    expect(result.skipped).toBe(1)
    expect(result.linked).toBe(0)
  })

  it('Stripe API が失敗しても他の申込の処理を止めない', async () => {
    const { db } = makeDb([
      { id: 14, stripe_session_id: 'cs_missing', name: 'x' },
      { id: 15, stripe_session_id: 'cs_3', name: 'y' },
    ], { U2: 'friend-2' })
    const { client } = makeStripe({ cs_3: { lineUserId: 'U2' } })

    const result = await backfillEventBookingFriends(db, 1, client, { getProfile: vi.fn() }, null)

    expect(result).toEqual({ total: 2, linked: 1, created: 0, skipped: 1, truncated: false })
  })

  it('LINE の友だち判定が不能（429等）なら紐付けず skip する（次回の実行で再挑戦できる）', async () => {
    const { db, updates } = makeDb([{ id: 16, stripe_session_id: 'cs_4', name: 'x' }])
    const { client } = makeStripe({ cs_4: { lineUserId: 'U3' } })
    const lineClient = {
      getProfile: vi.fn().mockRejectedValue(new Error('LINE API error: 429 Too Many Requests — {}')),
    }

    const result = await backfillEventBookingFriends(db, 1, client, lineClient, null)

    expect(result.skipped).toBe(1)
    expect(mockUpsertFriend).not.toHaveBeenCalled()
    expect(updates).toHaveLength(0)
  })

  it('上限を超えたら truncated: true を返し、超過分は処理しない（黙って切り捨てない）', async () => {
    const bookings = Array.from({ length: BACKFILL_LIMIT + 3 }, (_, i) => ({
      id: i + 1, stripe_session_id: `cs_${i}`, name: 'x',
    }))
    const metadata = Object.fromEntries(bookings.map((b, i) => [`cs_${i}`, { lineUserId: 'U1' }]))
    const { db, updates } = makeDb(bookings, { U1: 'friend-1' })
    const { client } = makeStripe(metadata)

    const result = await backfillEventBookingFriends(db, 1, client, { getProfile: vi.fn() }, null)

    expect(result.total).toBe(BACKFILL_LIMIT + 3)
    expect(result.linked).toBe(BACKFILL_LIMIT)
    expect(result.truncated).toBe(true)
    expect(updates).toHaveLength(BACKFILL_LIMIT)
  })

  it('対象が無ければ何もしない（冪等：2回目の実行は total 0）', async () => {
    const { db, updates } = makeDb([])
    const { client, retrieve } = makeStripe({})

    const result = await backfillEventBookingFriends(db, 1, client, { getProfile: vi.fn() }, null)

    expect(result).toEqual({ total: 0, linked: 0, created: 0, skipped: 0, truncated: false })
    expect(retrieve).not.toHaveBeenCalled()
    expect(updates).toHaveLength(0)
  })

  it('Stripe クライアントが無ければ全件 skip する', async () => {
    const { db } = makeDb([{ id: 11, stripe_session_id: 'cs_1', name: 'x' }])

    const result = await backfillEventBookingFriends(db, 1, null, { getProfile: vi.fn() }, null)

    expect(result).toEqual({ total: 1, linked: 0, created: 0, skipped: 1, truncated: false })
  })

  it('確定していない申込（pending/キャンセル）は対象にしない', async () => {
    const { db, queries } = makeDb([])
    const { client } = makeStripe({})

    await backfillEventBookingFriends(db, 1, client, { getProfile: vi.fn() }, null)

    const select = queries.find((q) => q.includes('FROM event_bookings'))!
    expect(select).toContain("status = 'confirmed'")
  })

  it('復元不能な申込が先頭に溜まっていても上限に食われない（ヘッドブロックしない）', async () => {
    // 先頭に「セッション無し」を上限数だけ並べ、その後ろに復元可能な1件を置く
    const bookings: BookingRow[] = [
      ...Array.from({ length: BACKFILL_LIMIT }, (_, i) => ({
        id: i + 1, stripe_session_id: null, name: 'cash',
      })),
      { id: 999, stripe_session_id: 'cs_last', name: '黒部' },
    ]
    const { db, updates } = makeDb(bookings, { U9: 'friend-9' })
    const { client } = makeStripe({ cs_last: { lineUserId: 'U9' } })

    const result = await backfillEventBookingFriends(db, 1, client, { getProfile: vi.fn() }, null)

    expect(result.linked).toBe(1)
    expect(result.truncated).toBe(false)
    expect(updates[0].binds).toEqual(['friend-9', 999])
  })

  it('既存 friends 行の line_account_id が未設定なら補完する', async () => {
    const { db, updates } = makeDb([{ id: 11, stripe_session_id: 'cs_1', name: 'x' }], { U1: 'friend-existing' })
    const { client } = makeStripe({ cs_1: { lineUserId: 'U1' } })

    await backfillEventBookingFriends(db, 1, client, { getProfile: vi.fn() }, 'acc-1')

    const friendUpdate = updates.find((u) => u.sql.includes('UPDATE friends'))
    expect(friendUpdate?.sql).toContain('line_account_id IS NULL')
    expect(friendUpdate?.binds[0]).toBe('acc-1')
    expect(friendUpdate?.binds[2]).toBe('friend-existing')
  })

  it('1件が例外を投げても残りの申込は処理される', async () => {
    const { db, updates } = makeDb([
      { id: 21, stripe_session_id: 'cs_a', name: 'a' },
      { id: 22, stripe_session_id: 'cs_b', name: 'b' },
    ])
    const { client } = makeStripe({ cs_a: { lineUserId: 'UA' }, cs_b: { lineUserId: 'UB' } })
    const lineClient = { getProfile: vi.fn().mockRejectedValue(NOT_FRIEND_ERROR) }
    // 1件目の upsert だけ失敗させる
    mockUpsertFriend
      .mockRejectedValueOnce(new Error('D1 write failed'))
      .mockResolvedValueOnce({ id: 'friend-b' })

    const result = await backfillEventBookingFriends(db, 1, client, lineClient, null)

    expect(result.linked).toBe(1)
    expect(result.skipped).toBe(1)
    expect(updates.map((u) => u.binds)).toEqual([['friend-b', 22]])
  })

  it('skipped は total - linked と一致する', async () => {
    const { db } = makeDb([
      { id: 31, stripe_session_id: null, name: 'cash' },
      { id: 32, stripe_session_id: 'cs_x', name: 'paid' },
    ], { UX: 'friend-x' })
    const { client } = makeStripe({ cs_x: { lineUserId: 'UX' } })

    const result = await backfillEventBookingFriends(db, 1, client, { getProfile: vi.fn() }, null)

    expect(result.total).toBe(2)
    expect(result.linked).toBe(1)
    expect(result.skipped).toBe(1)
  })
})
