import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockUpsertFriend = vi.hoisted(() => vi.fn())

vi.mock('@line-crm/db', () => ({
  upsertFriend: mockUpsertFriend,
}))

import { resolveEventApplicant, probeFriendship } from './event-friend.js'

/** friends の SELECT 1回分だけを返す D1 モック */
function makeDb(row: { id: string; is_following: number } | null) {
  const first = vi.fn().mockResolvedValue(row)
  const bind = vi.fn().mockReturnValue({ first })
  const prepare = vi.fn().mockReturnValue({ bind })
  return { db: { prepare } as unknown as D1Database, prepare, bind, first }
}

const PROFILE = { userId: 'U123', displayName: '黒部誠規', pictureUrl: 'https://example.com/p.jpg' }

/** LineClient.request() が投げるエラー形式（未友だちは 404） */
const NOT_FRIEND_ERROR = new Error('LINE API error: 404 Not Found — {"message":"Not found"}')

beforeEach(() => { vi.clearAllMocks() })

describe('resolveEventApplicant', () => {
  it('friends 行があってフォロー中の場合はその friend_id を返す', async () => {
    const { db } = makeDb({ id: 'friend-1', is_following: 1 })
    const lineClient = { getProfile: vi.fn() }

    const result = await resolveEventApplicant(db, 'U123', lineClient)

    expect(result).toEqual({ status: 'ok', friendId: 'friend-1' })
    // 既に友だちと分かっているなら LINE API は叩かない（無駄な外部呼び出しを避ける）
    expect(lineClient.getProfile).not.toHaveBeenCalled()
    expect(mockUpsertFriend).not.toHaveBeenCalled()
  })

  it('friends 行が無くても LINE 上は友だちなら upsert して ok を返す', async () => {
    const { db } = makeDb(null)
    const lineClient = { getProfile: vi.fn().mockResolvedValue(PROFILE) }
    mockUpsertFriend.mockResolvedValue({ id: 'friend-new' })

    const result = await resolveEventApplicant(db, 'U123', lineClient)

    expect(result).toEqual({ status: 'ok', friendId: 'friend-new' })
    expect(lineClient.getProfile).toHaveBeenCalledWith('U123')
    expect(mockUpsertFriend).toHaveBeenCalledWith(db, {
      lineUserId: 'U123',
      displayName: '黒部誠規',
      pictureUrl: 'https://example.com/p.jpg',
      statusMessage: null,
      lineAccountId: null,
    })
  })

  it('lineAccountId を渡すと救済 upsert に引き継がれる', async () => {
    const { db } = makeDb(null)
    const lineClient = { getProfile: vi.fn().mockResolvedValue(PROFILE) }
    mockUpsertFriend.mockResolvedValue({ id: 'friend-new' })

    await resolveEventApplicant(db, 'U123', lineClient, 'acc-1')

    expect(mockUpsertFriend).toHaveBeenCalledWith(db, expect.objectContaining({ lineAccountId: 'acc-1' }))
  })

  it('is_following=0 でも LINE 上は友だちなら救済して ok を返す（再フォローの取りこぼし対策）', async () => {
    const { db } = makeDb({ id: 'friend-stale', is_following: 0 })
    const lineClient = { getProfile: vi.fn().mockResolvedValue(PROFILE) }
    mockUpsertFriend.mockResolvedValue({ id: 'friend-stale' })

    const result = await resolveEventApplicant(db, 'U123', lineClient)

    expect(result).toEqual({ status: 'ok', friendId: 'friend-stale' })
    // upsertFriend が is_following を 1 に戻すため、DB が実態に追従する
    expect(mockUpsertFriend).toHaveBeenCalled()
  })

  it('is_following=0 かつ LINE 上もブロック中（404）なら not_friend を返す', async () => {
    const { db } = makeDb({ id: 'friend-blocked', is_following: 0 })
    const lineClient = { getProfile: vi.fn().mockRejectedValue(NOT_FRIEND_ERROR) }

    const result = await resolveEventApplicant(db, 'U123', lineClient)

    expect(result).toEqual({ status: 'not_friend' })
    expect(mockUpsertFriend).not.toHaveBeenCalled()
  })

  it('friends 行が無く LINE 上も未友だち（404）なら not_friend を返す', async () => {
    const { db } = makeDb(null)
    const lineClient = { getProfile: vi.fn().mockRejectedValue(NOT_FRIEND_ERROR) }

    const result = await resolveEventApplicant(db, 'U123', lineClient)

    expect(result).toEqual({ status: 'not_friend' })
    expect(mockUpsertFriend).not.toHaveBeenCalled()
  })

  it('LINE API が 404 以外のエラーなら unavailable を返す（403 に丸めるとループするため）', async () => {
    const { db } = makeDb(null)
    const lineClient = {
      getProfile: vi.fn().mockRejectedValue(new Error('LINE API error: 500 Internal Server Error — {}')),
    }

    const result = await resolveEventApplicant(db, 'U123', lineClient)

    expect(result).toEqual({ status: 'unavailable' })
    expect(mockUpsertFriend).not.toHaveBeenCalled()
  })

  it('ネットワーク例外でも unavailable を返す', async () => {
    const { db } = makeDb(null)
    const lineClient = { getProfile: vi.fn().mockRejectedValue(new TypeError('fetch failed')) }

    const result = await resolveEventApplicant(db, 'U123', lineClient)

    expect(result).toEqual({ status: 'unavailable' })
  })

  it('lineClient が無い（トークン未設定）場合は unavailable を返す', async () => {
    const { db } = makeDb(null)

    const result = await resolveEventApplicant(db, 'U123', null)

    expect(result).toEqual({ status: 'unavailable' })
    expect(mockUpsertFriend).not.toHaveBeenCalled()
  })

  it('lineUserId が空文字の場合は DB を引かずに not_friend を返す', async () => {
    const { db, prepare } = makeDb({ id: 'friend-1', is_following: 1 })

    const result = await resolveEventApplicant(db, '', { getProfile: vi.fn() })

    expect(result).toEqual({ status: 'not_friend' })
    expect(prepare).not.toHaveBeenCalled()
  })
})

describe('probeFriendship', () => {
  it('profile が取れたら friend を返す', async () => {
    const lineClient = { getProfile: vi.fn().mockResolvedValue(PROFILE) }
    const result = await probeFriendship(lineClient, 'U123')
    expect(result).toEqual({ status: 'friend', profile: PROFILE })
  })

  it('404 なら not_friend を返す', async () => {
    const lineClient = { getProfile: vi.fn().mockRejectedValue(NOT_FRIEND_ERROR) }
    expect(await probeFriendship(lineClient, 'U123')).toEqual({ status: 'not_friend' })
  })

  it('404 以外のエラーは unknown を返す（未友だちと誤断定しない）', async () => {
    const lineClient = {
      getProfile: vi.fn().mockRejectedValue(new Error('LINE API error: 429 Too Many Requests — {}')),
    }
    expect(await probeFriendship(lineClient, 'U123')).toEqual({ status: 'unknown' })
  })

  it('lineClient が無い場合は unknown を返す', async () => {
    expect(await probeFriendship(null, 'U123')).toEqual({ status: 'unknown' })
  })

  it('lineUserId が空なら LINE を叩かず not_friend を返す', async () => {
    const lineClient = { getProfile: vi.fn() }
    expect(await probeFriendship(lineClient, '')).toEqual({ status: 'not_friend' })
    expect(lineClient.getProfile).not.toHaveBeenCalled()
  })
})
