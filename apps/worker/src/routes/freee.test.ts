import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

const mockGetFreeeAuthUrl = vi.hoisted(() => vi.fn())
const mockExchangeCodeForTokens = vi.hoisted(() => vi.fn())
const mockCreateOAuthState = vi.hoisted(() => vi.fn())
const mockVerifyOAuthState = vi.hoisted(() => vi.fn())
const mockFetchCompanyName = vi.hoisted(() => vi.fn())

vi.mock('../services/freee-oauth.js', () => ({
  getFreeeAuthUrl: mockGetFreeeAuthUrl,
  exchangeCodeForTokens: mockExchangeCodeForTokens,
  createOAuthState: mockCreateOAuthState,
  verifyOAuthState: mockVerifyOAuthState,
  fetchFreeeCompanyName: mockFetchCompanyName,
}))

import { freee } from './freee.js'

type Role = 'owner' | 'admin' | 'staff'

/**
 * 認証済みコンテキストを模したアプリ。
 * 本番では authMiddleware が c.set('staff', ...) する。
 */
function makeAppWithRole(role: Role) {
  const app = new Hono<{ Bindings: Record<string, unknown> }>()
  app.use('*', async (c, next) => {
    // @ts-expect-error テスト用に staff を注入する
    c.set('staff', { id: 's1', name: 'テスト', role })
    await next()
  })
  app.route('/', freee)
  return app
}

function makeStmt(firstResult: unknown = null) {
  return {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
    first: vi.fn().mockResolvedValue(firstResult),
    all: vi.fn().mockResolvedValue({ results: [] }),
  }
}

let stmts: ReturnType<typeof makeStmt>[]
let sqls: string[]

/** @param upsertResult UPSERT の RETURNING が返す行（既存接続の再認可を模す） */
function makeApp(upsertResult: unknown = { id: 'conn-new', is_active: 0 }) {
  stmts = []
  sqls = []
  const db = {
    prepare: vi.fn().mockImplementation((sql: string) => {
      sqls.push(sql)
      const s = makeStmt(upsertResult)
      stmts.push(s)
      return s
    }),
  } as unknown as D1Database

  const app = makeAppWithRole('owner')
  const env = {
    DB: db,
    FREEE_CLIENT_ID: 'client-abc',
    FREEE_CLIENT_SECRET: 'super-secret-value',
  }
  return { app, env, db }
}

/** その PR で流した SQL 全体（大文字小文字を無視して部分一致を見る） */
function allSql(): string {
  return sqls.join('\n')
}

/** bind に渡した値をすべて平坦化して集める */
function allBound(): unknown[] {
  return stmts.flatMap((s) => (s.bind as ReturnType<typeof vi.fn>).mock.calls.flat())
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetFreeeAuthUrl.mockReturnValue('https://accounts.secure.freee.co.jp/public_api/authorize?x=1')
  mockCreateOAuthState.mockResolvedValue('signed-state')
  mockVerifyOAuthState.mockResolvedValue(true)
  mockFetchCompanyName.mockResolvedValue('WALOVER合同会社')
})

describe('GET /api/integrations/freee/auth', () => {
  it('認可URLをJSONで返す', async () => {
    const { app, env } = makeApp()
    const res = await app.request('/api/integrations/freee/auth', {}, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { success: boolean; data: { url: string } }
    expect(body.success).toBe(true)
    expect(body.data.url).toContain('accounts.secure.freee.co.jp')
  })

  it('署名付き state を発行して認可URLに渡す', async () => {
    const { app, env } = makeApp()
    await app.request('/api/integrations/freee/auth', {}, env)
    expect(mockCreateOAuthState).toHaveBeenCalled()
    expect(mockGetFreeeAuthUrl.mock.calls[0][1]).toBe('signed-state')
  })

  it('認可URLの組み立てが失敗したら 500 を返す（設定漏れ）', async () => {
    mockGetFreeeAuthUrl.mockImplementation(() => { throw new Error('FREEE_CLIENT_ID が未設定です') })
    const { app, env } = makeApp()
    const res = await app.request('/api/integrations/freee/auth', {}, env)
    expect(res.status).toBe(500)
  })

  it('redirect=1 でもリダイレクトせず JSON を返す（state オラクル化を防ぐため廃止）', async () => {
    const { app, env } = makeApp()
    const res = await app.request('/api/integrations/freee/auth?redirect=1', {}, env)
    expect(res.status).toBe(200)
  })
})

describe('GET /api/integrations/freee/callback', () => {
  const TOKENS = {
    access_token: 'at-1',
    refresh_token: 'rt-1',
    expires_in: 21600,
    company_id: 1234567,
  }

  it('code が無ければ 400 を返す', async () => {
    const { app, env } = makeApp()
    const res = await app.request('/api/integrations/freee/callback', {}, env)
    expect(res.status).toBe(400)
    expect(mockExchangeCodeForTokens).not.toHaveBeenCalled()
  })

  it('error パラメータが来たら 400 を返す（ユーザーが認可を拒否した場合）', async () => {
    const { app, env } = makeApp()
    const res = await app.request('/api/integrations/freee/callback?error=access_denied', {}, env)
    expect(res.status).toBe(400)
    expect(mockExchangeCodeForTokens).not.toHaveBeenCalled()
  })

  it('code をトークンに交換して freee_accounts に保存する', async () => {
    mockExchangeCodeForTokens.mockResolvedValue(TOKENS)
    const { app, env, db } = makeApp()

    const res = await app.request('/api/integrations/freee/callback?code=the-code&state=signed-state', {}, env)

    expect(res.status).toBe(200)
    expect(mockExchangeCodeForTokens).toHaveBeenCalledWith(expect.anything(), 'the-code')
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO freee_accounts'))
  })

  it('refresh_token を必ず保存する（freeeのリフレッシュトークンは1回限り・保存漏れで連携が死ぬ）', async () => {
    mockExchangeCodeForTokens.mockResolvedValue(TOKENS)
    const { app, env } = makeApp()

    await app.request('/api/integrations/freee/callback?code=the-code&state=signed-state', {}, env)

    expect(allBound()).toContain('rt-1')
    expect(allBound()).toContain('at-1')
  })

  it('company_id を保存する', async () => {
    mockExchangeCodeForTokens.mockResolvedValue(TOKENS)
    const { app, env } = makeApp()

    await app.request('/api/integrations/freee/callback?code=the-code&state=signed-state', {}, env)

    expect(allBound()).toContain(1234567)
  })

  it('トークン交換が失敗したら 500 を返し DB に書かない', async () => {
    mockExchangeCodeForTokens.mockRejectedValue(new Error('invalid_grant'))
    const { app, env, db } = makeApp()

    const res = await app.request('/api/integrations/freee/callback?code=bad&state=signed-state', {}, env)

    expect(res.status).toBe(500)
    expect(db.prepare).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO freee_accounts'))
  })

  it('エラー画面に client_secret を出さない', async () => {
    mockExchangeCodeForTokens.mockRejectedValue(new Error('boom super-secret-value'))
    const { app, env } = makeApp()

    const res = await app.request('/api/integrations/freee/callback?code=bad&state=signed-state', {}, env)
    const html = await res.text()
    expect(html).not.toContain('super-secret-value')
  })

  it('成功画面にアクセストークンを出さない', async () => {
    mockExchangeCodeForTokens.mockResolvedValue(TOKENS)
    const { app, env } = makeApp()

    const res = await app.request('/api/integrations/freee/callback?code=the-code&state=signed-state', {}, env)
    const html = await res.text()
    expect(html).not.toContain('at-1')
    expect(html).not.toContain('rt-1')
  })

  // ── state 検証（レビュー指摘②）──────────────────────────────
  // 「state を作るだけで検証しない」= CSRF 対策が名目だけ、を防ぐ

  it('state が無いリクエストは 400 で拒否しトークン交換もしない', async () => {
    const { app, env } = makeApp()
    const res = await app.request('/api/integrations/freee/callback?code=the-code', {}, env)
    expect(res.status).toBe(400)
    expect(mockExchangeCodeForTokens).not.toHaveBeenCalled()
  })

  it('署名が通らない state は 400 で拒否しトークン交換もしない', async () => {
    mockVerifyOAuthState.mockResolvedValue(false)
    const { app, env, db } = makeApp()

    const res = await app.request(
      '/api/integrations/freee/callback?code=the-code&state=attacker-made-this', {}, env,
    )

    expect(res.status).toBe(400)
    expect(mockExchangeCodeForTokens).not.toHaveBeenCalled()
    expect(db.prepare).not.toHaveBeenCalled()
  })

  it('state の検証はトークン交換より前に行う（無駄に認可コードを消費しない）', async () => {
    mockVerifyOAuthState.mockResolvedValue(false)
    const { app, env } = makeApp()
    await app.request('/api/integrations/freee/callback?code=the-code&state=bad', {}, env)
    expect(mockVerifyOAuthState).toHaveBeenCalled()
    expect(mockExchangeCodeForTokens).not.toHaveBeenCalled()
  })

  // ── is_active=0 で保留（レビュー指摘①）─────────────────────
  // 公開エンドポイントなので、誰かが自分の事業所を登録できてしまう。
  // 自動で有効化しないことで、登録できても使われない状態にする。

  it('新規接続は is_active = 0（保留）で保存する', async () => {
    mockExchangeCodeForTokens.mockResolvedValue(TOKENS)
    const { app, env } = makeApp()

    await app.request('/api/integrations/freee/callback?code=the-code&state=signed-state', {}, env)

    const insertSql = allSql()
    expect(insertSql).toContain('INSERT INTO freee_accounts')
    // is_active に 1 を立てていないこと
    expect(insertSql).not.toMatch(/is_active[^)]*\b1\b/)
  })

  it('保留であることを画面で伝える（管理画面での有効化が必要）', async () => {
    mockExchangeCodeForTokens.mockResolvedValue(TOKENS)
    const { app, env } = makeApp()

    const res = await app.request('/api/integrations/freee/callback?code=the-code&state=signed-state', {}, env)
    const html = await res.text()
    expect(html).toContain('有効化')
  })

  // ── company_id で UPSERT（レビュー指摘③）───────────────────
  // 再認可は90日ごとの正常運用。INSERT し続けると死んだ refresh_token を持つ
  // 古い行が残り、is_active=1 の検索がそれを拾ってしまう。

  it('SELECT してから INSERT せず、1文の UPSERT で保存する（同時実行で行が重複しないため）', async () => {
    mockExchangeCodeForTokens.mockResolvedValue(TOKENS)
    const { app, env, db } = makeApp()

    await app.request('/api/integrations/freee/callback?code=the-code&state=signed-state', {}, env)

    // SELECT→INSERT の2文だと、同時に再認可が走ったとき両方 INSERT されうる
    expect(db.prepare).toHaveBeenCalledTimes(1)
    expect(allSql()).toContain('INSERT INTO freee_accounts')
    expect(allSql()).toContain('ON CONFLICT')
    expect(allSql()).not.toContain('SELECT ')
  })

  it('再認可では is_active を上書きしない（稼働中の連携を止めない）', async () => {
    mockExchangeCodeForTokens.mockResolvedValue(TOKENS)
    const { app, env } = makeApp({ id: 'existing-1', is_active: 1 })

    await app.request('/api/integrations/freee/callback?code=the-code&state=signed-state', {}, env)

    // DO UPDATE SET 節（RETURNING より前）に is_active を含めない
    const setClause = (allSql().split('DO UPDATE SET')[1] ?? '').split('RETURNING')[0]
    expect(setClause).not.toContain('is_active')
    // トークンは差し替える
    expect(setClause).toContain('access_token')
    expect(setClause).toContain('refresh_token')
  })

  it('既に有効な接続の再認可なら「保留」と案内しない', async () => {
    mockExchangeCodeForTokens.mockResolvedValue(TOKENS)
    const { app, env } = makeApp({ id: 'existing-1', is_active: 1 })

    const res = await app.request('/api/integrations/freee/callback?code=the-code&state=signed-state', {}, env)
    const html = await res.text()
    expect(html).not.toContain('有効化')
  })

  it('company_id が返らなければ保存せずエラーにする', async () => {
    // company_id が NULL だと部分UNIQUEの対象外になり UPSERT が効かず、
    // 再認可のたびに行が増える。さらに company_name も空なので、
    // #44 の有効化画面で自分の接続と第三者の接続を見分けられなくなる。
    mockExchangeCodeForTokens.mockResolvedValue({ ...TOKENS, company_id: undefined })
    const { app, env, db } = makeApp()

    const res = await app.request('/api/integrations/freee/callback?code=the-code&state=signed-state', {}, env)

    expect(res.status).toBe(500)
    expect(db.prepare).not.toHaveBeenCalled()
  })

  it('事業所名を取得して保存する（管理画面で見分けるため）', async () => {
    mockExchangeCodeForTokens.mockResolvedValue(TOKENS)
    const { app, env } = makeApp()

    await app.request('/api/integrations/freee/callback?code=the-code&state=signed-state', {}, env)

    expect(mockFetchCompanyName).toHaveBeenCalledWith('at-1', 1234567)
    expect(allBound()).toContain('WALOVER合同会社')
  })

  it('事業所名が取れなくても連携は成功させる（ベストエフォート）', async () => {
    mockExchangeCodeForTokens.mockResolvedValue(TOKENS)
    mockFetchCompanyName.mockResolvedValue(null)
    const { app, env } = makeApp()

    const res = await app.request('/api/integrations/freee/callback?code=the-code&state=signed-state', {}, env)

    expect(res.status).toBe(200)
    expect(allSql()).toContain('INSERT INTO freee_accounts')
  })

  it('company_id が無いときのエラー画面は原因を名指しする', async () => {
    mockExchangeCodeForTokens.mockResolvedValue({ ...TOKENS, company_id: undefined })
    const { app, env } = makeApp()

    const res = await app.request('/api/integrations/freee/callback?code=the-code&state=signed-state', {}, env)
    const html = await res.text()
    expect(html).toContain('事業所')
  })

  // ── JST（レビュー指摘④）────────────────────────────────────

  it('created_at / updated_at を JST(+09:00) で保存する', async () => {
    mockExchangeCodeForTokens.mockResolvedValue(TOKENS)
    const { app, env } = makeApp()

    await app.request('/api/integrations/freee/callback?code=the-code&state=signed-state', {}, env)

    // datetime('now') は UTC かつスペース区切りになるので使わない
    expect(allSql()).not.toContain("datetime('now')")
    const jstValues = allBound().filter(
      (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+09:00$/.test(v),
    )
    expect(jstValues.length).toBeGreaterThan(0)
  })

  it('token_expires_at も JST(+09:00) で保存する（UTCのZだと文字列比較で9時間ずれる）', async () => {
    // SQLite の日時比較は文字列比較。created_at が +09:00 なのに
    // token_expires_at だけ Z だと、WHERE token_expires_at <= jstNow() が常に真になる。
    mockExchangeCodeForTokens.mockResolvedValue(TOKENS)
    const { app, env } = makeApp()

    await app.request('/api/integrations/freee/callback?code=the-code&state=signed-state', {}, env)

    const utcValues = allBound().filter((v) => typeof v === 'string' && /Z$/.test(v))
    expect(utcValues).toEqual([])
  })

  it('state 検証が例外を投げても 500 ではなく 400 で案内する', async () => {
    // FREEE_CLIENT_SECRET 未設定だと HMAC の importKey が DataError を投げる。
    // 素の 500 ではなく、やり直しを案内する画面にする。
    mockVerifyOAuthState.mockRejectedValue(new Error('DataError'))
    const { app, env } = makeApp()

    const res = await app.request('/api/integrations/freee/callback?code=the-code&state=x', {}, env)

    expect(res.status).toBe(400)
    expect(mockExchangeCodeForTokens).not.toHaveBeenCalled()
  })

  // ── 失敗時の案内（レビュー指摘⑤）───────────────────────────

  it('失敗画面は「やり直し」を案内する（認可コードは消費済みでリトライは無意味）', async () => {
    mockExchangeCodeForTokens.mockRejectedValue(new Error('expires_in が不正です'))
    const { app, env } = makeApp()

    const res = await app.request('/api/integrations/freee/callback?code=bad&state=signed-state', {}, env)
    const html = await res.text()
    expect(html).toContain('やり直')
    expect(html).not.toContain('時間をおいて')
  })
})

// ── 接続管理 API（#44）────────────────────────────────────────────────────

describe('GET /api/integrations/freee（接続一覧）', () => {
  function makeListApp(rows: unknown[]) {
    const stmt = {
      bind: vi.fn().mockReturnThis(),
      run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
      first: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue({ results: rows }),
    }
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database
    const app = makeAppWithRole('owner')
    return { app, env: { DB: db }, stmt, db }
  }

  const ROW = {
    id: 'conn-1', company_id: 1234567, company_name: 'テスト事業所',
    is_active: 0, token_expires_at: '2026-09-05T18:00:00.000+09:00',
    created_at: '2026-09-05T09:00:00.000+09:00', updated_at: '2026-09-05T09:00:00.000+09:00',
  }

  it('接続一覧を返す', async () => {
    const { app, env } = makeListApp([ROW])
    const res = await app.request('/api/integrations/freee', {}, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { success: boolean; data: unknown[] }
    expect(body.success).toBe(true)
    expect(body.data).toHaveLength(1)
  })

  it('【重要】トークンを一覧に含めない', async () => {
    // 管理画面に出す＝ブラウザに渡る。トークンが漏れると連携を乗っ取られる。
    const { app, env } = makeListApp([{ ...ROW, access_token: 'at-secret', refresh_token: 'rt-secret' }])
    const res = await app.request('/api/integrations/freee', {}, env)
    const text = await res.text()
    expect(text).not.toContain('at-secret')
    expect(text).not.toContain('rt-secret')
  })

  it('SELECT * ではなく列を明示して取得する（列追加でトークンが漏れないように）', async () => {
    const { app, env, db } = makeListApp([ROW])
    await app.request('/api/integrations/freee', {}, env)
    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(sql).not.toContain('SELECT *')
    expect(sql).not.toContain('access_token')
    expect(sql).not.toContain('refresh_token')
  })

  it('見分けに必要な company_id / company_name を返す', async () => {
    const { app, env } = makeListApp([ROW])
    const res = await app.request('/api/integrations/freee', {}, env)
    const body = await res.json() as { data: Array<Record<string, unknown>> }
    expect(body.data[0].companyId).toBe(1234567)
    expect(body.data[0].companyName).toBe('テスト事業所')
    expect(body.data[0].isActive).toBe(false)
  })
})

describe('POST /api/integrations/freee/:id/activate（有効化）', () => {
  function makeApp2(activatedChanges = 1, role: Role = 'owner') {
    const stmts: Array<{ sql: string; bound: unknown[] }> = []
    const batchCalls: unknown[][] = []
    const db = {
      prepare: vi.fn().mockImplementation((sql: string) => ({
        bind: vi.fn().mockImplementation((...args: unknown[]) => {
          const stmt = { sql, bound: args }
          stmts.push(stmt)
          return stmt
        }),
      })),
      batch: vi.fn().mockImplementation((list: unknown[]) => {
        batchCalls.push(list)
        // 1本目が「対象を有効化」、2本目が「他を無効化」
        return Promise.resolve(list.map((_, i) => ({
          meta: { changes: i === 0 ? activatedChanges : 1 },
        })))
      }),
    } as unknown as D1Database
    const app = makeAppWithRole(role)
    return { app, env: { DB: db }, stmts, batchCalls, db }
  }

  it('指定の接続を有効化する', async () => {
    const { app, env, stmts } = makeApp2()
    const res = await app.request('/api/integrations/freee/conn-1/activate', { method: 'POST' }, env)
    expect(res.status).toBe(200)
    expect(stmts.some((s) => s.sql.includes('is_active = 1') && s.bound.includes('conn-1'))).toBe(true)
  })

  it('他の接続は無効化する（有効な接続は常に1本）', async () => {
    // 複数が有効だと getValidAccessTokenFreee がどれを拾うか不定になる
    const { app, env, stmts } = makeApp2()
    await app.request('/api/integrations/freee/conn-1/activate', { method: 'POST' }, env)
    expect(stmts.some((s) => s.sql.includes('is_active = 0') && s.sql.includes('id != ?'))).toBe(true)
  })

  it('【原子性】2本の UPDATE を db.batch で一括実行する', async () => {
    // 別々に実行すると、2本目が失敗したときに「有効な接続が2本」という
    // この処理が防ごうとしている状態そのものを作ってしまう。
    const { app, env, batchCalls, db } = makeApp2()

    await app.request('/api/integrations/freee/conn-1/activate', { method: 'POST' }, env)

    expect(db.batch).toHaveBeenCalledTimes(1)
    expect(batchCalls[0]).toHaveLength(2)
  })

  it('存在しない接続なら 404', async () => {
    const { app, env } = makeApp2(0)
    const res = await app.request('/api/integrations/freee/nope/activate', { method: 'POST' }, env)
    expect(res.status).toBe(404)
  })

  it('staff 権限では有効化できない（発行先を差し替えられてしまうため）', async () => {
    // 「認証済みの管理者が事業所を目視して有効化する」がこの機能の防御。
    // staff のAPIキーで有効化できると、公開コールバックで登録した自分の事業所に
    // 領収書の発行先を差し替えられる。
    const { app, env, db } = makeApp2(1, 'staff')
    const res = await app.request('/api/integrations/freee/conn-1/activate', { method: 'POST' }, env)
    expect(res.status).toBe(403)
    expect(db.batch).not.toHaveBeenCalled()
  })

  it('admin 権限でも有効化できない（owner のみ）', async () => {
    const { app, env } = makeApp2(1, 'admin')
    const res = await app.request('/api/integrations/freee/conn-1/activate', { method: 'POST' }, env)
    expect(res.status).toBe(403)
  })

  it('【重要】存在しない接続でも、他の接続を巻き込んで無効化しない', async () => {
    // batch は両方走るため、無効化側にガードが無いと
    // 存在しないIDを投げるだけで全接続を止められてしまう。
    const { app, env, stmts } = makeApp2(0)

    await app.request('/api/integrations/freee/nope/activate', { method: 'POST' }, env)

    const deactivate = stmts.find((s) => s.sql.includes('is_active = 0'))
    expect(deactivate?.sql).toContain('EXISTS')
  })

  it('すでに無効な接続の updated_at は触らない', async () => {
    // 無関係な行の「最終更新」が動くと、管理画面の表示が嘘になる
    const { app, env, stmts } = makeApp2()
    await app.request('/api/integrations/freee/conn-1/activate', { method: 'POST' }, env)
    const deactivate = stmts.find((s) => s.sql.includes('is_active = 0'))
    expect(deactivate?.sql).toContain('is_active = 1')
  })
})

describe('DELETE /api/integrations/freee/:id（削除）', () => {
  function makeDeleteApp(changes: number, role: Role = 'owner') {
    const calls: string[] = []
    const db = {
      prepare: vi.fn().mockImplementation((sql: string) => {
        calls.push(sql)
        return { bind: vi.fn().mockReturnThis(), run: vi.fn().mockResolvedValue({ meta: { changes } }) }
      }),
    } as unknown as D1Database
    const app = makeAppWithRole(role)
    return { app, env: { DB: db }, calls }
  }

  it('接続を削除する', async () => {
    const { app, env, calls } = makeDeleteApp(1)
    const res = await app.request('/api/integrations/freee/conn-1', { method: 'DELETE' }, env)
    expect(res.status).toBe(200)
    expect(calls.some((q) => q.includes('DELETE FROM freee_accounts'))).toBe(true)
  })

  it('staff 権限では削除できない', async () => {
    const { app, env, calls } = makeDeleteApp(1, 'staff')
    const res = await app.request('/api/integrations/freee/conn-1', { method: 'DELETE' }, env)
    expect(res.status).toBe(403)
    expect(calls.some((q) => q.includes('DELETE FROM freee_accounts'))).toBe(false)
  })

  it('存在しない接続なら 404（幻の成功を返さない）', async () => {
    // 古いタブから消えた接続を消すと「削除できた」と嘘の表示になる。
    // 有効化が 404 を返すのと挙動を揃える。
    const { app, env } = makeDeleteApp(0)
    const res = await app.request('/api/integrations/freee/nope', { method: 'DELETE' }, env)
    expect(res.status).toBe(404)
  })
})
