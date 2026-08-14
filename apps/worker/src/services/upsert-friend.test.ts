/**
 * packages/db の upsertFriend の回帰テスト。
 *
 * packages/db 側には vitest の設定が無く、worker の vitest は `src/**` しか拾わないため、
 * 実装（packages/db/src/friends.ts）を直接 import してここでテストする。
 * worker は `@line-crm/db` を src 直参照しているので、モックなしで実体が読み込まれる。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { upsertFriend } from '@line-crm/db'

type Row = Record<string, unknown> | null

/**
 * D1 モック。SELECT は渡した行を順に返し、UPDATE/INSERT は sql と bind を記録する。
 */
function makeDb(selectResults: Row[]) {
  const calls: { sql: string; binds: unknown[] }[] = []
  const selects = [...selectResults]
  const db = {
    prepare: (sql: string) => ({
      bind: (...binds: unknown[]) => {
        calls.push({ sql, binds })
        return {
          first: async () => (sql.trim().startsWith('SELECT') ? (selects.shift() ?? null) : null),
          run: async () => ({ meta: {} }),
        }
      },
    }),
  } as unknown as D1Database
  const write = () => calls.find((c) => /^(UPDATE|INSERT)/.test(c.sql.trim()))!
  return { db, calls, write }
}

const EXISTING = {
  id: 'friend-1', line_user_id: 'U123', display_name: '既存', picture_url: null,
  status_message: null, is_following: 1, line_account_id: 'acc-1',
}

beforeEach(() => { vi.clearAllMocks() })

describe('upsertFriend', () => {
  describe('新規作成（friends 行が無い）', () => {
    it('isFollowing を省略すると is_following = 1 で作られる（従来動作）', async () => {
      // SELECT(既存なし) → INSERT → SELECT(作成後の取得)
      const { db, write } = makeDb([null, { ...EXISTING, id: 'new' }])
      await upsertFriend(db, { lineUserId: 'U123', displayName: '山田' })
      const { sql, binds } = write()
      expect(sql).toContain('INSERT INTO friends')
      // (id, line_user_id, display_name, picture_url, status_message, is_following, line_account_id, ...)
      expect(binds[5]).toBe(1)
    })

    it('isFollowing: false なら is_following = 0 で作られる', async () => {
      const { db, write } = makeDb([null, { ...EXISTING, id: 'new' }])
      await upsertFriend(db, { lineUserId: 'U123', isFollowing: false })
      expect(write().binds[5]).toBe(0)
    })

    it('lineAccountId を渡すと line_account_id に入る', async () => {
      const { db, write } = makeDb([null, { ...EXISTING, id: 'new' }])
      await upsertFriend(db, { lineUserId: 'U123', lineAccountId: 'acc-9' })
      expect(write().binds[6]).toBe('acc-9')
    })

    it('lineAccountId を省略すると null で作られる', async () => {
      const { db, write } = makeDb([null, { ...EXISTING, id: 'new' }])
      await upsertFriend(db, { lineUserId: 'U123' })
      expect(write().binds[6]).toBeNull()
    })
  })

  describe('更新（friends 行がある）', () => {
    it('isFollowing を省略すると is_following = 1 に戻す（再フォロー時の従来動作）', async () => {
      const { db, write } = makeDb([{ ...EXISTING, is_following: 0 }, EXISTING])
      await upsertFriend(db, { lineUserId: 'U123', displayName: '山田' })
      const { sql, binds } = write()
      expect(sql).toContain('UPDATE friends')
      // CASE WHEN ? = 1 THEN 1 ELSE is_following END に渡る値
      expect(binds[3]).toBe(1)
    })

    it('isFollowing: false でも既存の is_following を引き下げない', async () => {
      const { db, write } = makeDb([EXISTING, EXISTING])
      await upsertFriend(db, { lineUserId: 'U123', isFollowing: false })
      const { sql, binds } = write()
      // 0 を渡すと SQL 側の CASE が既存値を維持する
      expect(binds[3]).toBe(0)
      expect(sql).toContain('CASE WHEN ? = 1 THEN 1 ELSE is_following END')
    })

    it('line_account_id は COALESCE で既存値を優先する（上書きしない）', async () => {
      const { db, write } = makeDb([EXISTING, EXISTING])
      await upsertFriend(db, { lineUserId: 'U123', lineAccountId: 'acc-9' })
      const { sql, binds } = write()
      expect(sql).toContain('line_account_id = COALESCE(line_account_id, ?)')
      expect(binds[4]).toBe('acc-9')
    })

    it('lineAccountId 省略時は null を渡し既存値が維持される', async () => {
      const { db, write } = makeDb([EXISTING, EXISTING])
      await upsertFriend(db, { lineUserId: 'U123' })
      expect(write().binds[4]).toBeNull()
    })
  })
})
