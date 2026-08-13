import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockUpsertFriend = vi.hoisted(() => vi.fn())

vi.mock('@line-crm/db', () => ({
  upsertFriend: mockUpsertFriend,
}))

import { resolveEventApplicantFriendId } from './event-friend.js'

/** friends の SELECT 1回分だけを返す D1 モック */
function makeDb(row: { id: string; is_following: number } | null) {
  const first = vi.fn().mockResolvedValue(row)
  const bind = vi.fn().mockReturnValue({ first })
  const prepare = vi.fn().mockReturnValue({ bind })
  return { db: { prepare } as unknown as D1Database, prepare, bind, first }
}

const PROFILE = { userId: 'U123', displayName: '黒部誠規', pictureUrl: 'https://example.com/p.jpg' }

beforeEach(() => { vi.clearAllMocks() })

describe('resolveEventApplicantFriendId', () => {
  it('friends 行があってフォロー中の場合はその friend_id を返す', async () => {
    const { db } = makeDb({ id: 'friend-1', is_following: 1 })
    const lineClient = { getProfile: vi.fn() }

    const result = await resolveEventApplicantFriendId(db, 'U123', lineClient)

    expect(result).toBe('friend-1')
    // 既に friends 行があるなら LINE API は叩かない（無駄な外部呼び出しを避ける）
    expect(lineClient.getProfile).not.toHaveBeenCalled()
    expect(mockUpsertFriend).not.toHaveBeenCalled()
  })

  it('friends 行があってもフォロー解除済み（is_following=0）の場合は null を返す', async () => {
    const { db } = makeDb({ id: 'friend-1', is_following: 0 })
    const lineClient = { getProfile: vi.fn() }

    const result = await resolveEventApplicantFriendId(db, 'U123', lineClient)

    expect(result).toBeNull()
    expect(lineClient.getProfile).not.toHaveBeenCalled()
  })

  it('friends 行が無くても LINE 上は友だちなら upsert して friend_id を返す', async () => {
    const { db } = makeDb(null)
    const lineClient = { getProfile: vi.fn().mockResolvedValue(PROFILE) }
    mockUpsertFriend.mockResolvedValue({ id: 'friend-new' })

    const result = await resolveEventApplicantFriendId(db, 'U123', lineClient)

    expect(result).toBe('friend-new')
    expect(lineClient.getProfile).toHaveBeenCalledWith('U123')
    expect(mockUpsertFriend).toHaveBeenCalledWith(db, {
      lineUserId: 'U123',
      displayName: '黒部誠規',
      pictureUrl: 'https://example.com/p.jpg',
      statusMessage: null,
    })
  })

  it('friends 行が無く LINE 上も未友だち（profile API が 404）の場合は null を返す', async () => {
    const { db } = makeDb(null)
    const lineClient = {
      getProfile: vi.fn().mockRejectedValue(new Error('LINE API error: 404 Not Found — {}')),
    }

    const result = await resolveEventApplicantFriendId(db, 'U123', lineClient)

    expect(result).toBeNull()
    expect(mockUpsertFriend).not.toHaveBeenCalled()
  })

  it('lineClient が無い場合（トークン未設定）は upsert せず null を返す', async () => {
    const { db } = makeDb(null)

    const result = await resolveEventApplicantFriendId(db, 'U123', null)

    expect(result).toBeNull()
    expect(mockUpsertFriend).not.toHaveBeenCalled()
  })

  it('lineUserId が空文字の場合は DB を引かずに null を返す', async () => {
    const { db, prepare } = makeDb({ id: 'friend-1', is_following: 1 })

    const result = await resolveEventApplicantFriendId(db, '', { getProfile: vi.fn() })

    expect(result).toBeNull()
    expect(prepare).not.toHaveBeenCalled()
  })
})
