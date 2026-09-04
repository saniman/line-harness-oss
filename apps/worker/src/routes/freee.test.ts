import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

const mockGetFreeeAuthUrl = vi.hoisted(() => vi.fn())
const mockExchangeCodeForTokens = vi.hoisted(() => vi.fn())
const mockCreateOAuthState = vi.hoisted(() => vi.fn())
const mockVerifyOAuthState = vi.hoisted(() => vi.fn())

vi.mock('../services/freee-oauth.js', () => ({
  getFreeeAuthUrl: mockGetFreeeAuthUrl,
  exchangeCodeForTokens: mockExchangeCodeForTokens,
  createOAuthState: mockCreateOAuthState,
  verifyOAuthState: mockVerifyOAuthState,
}))

import { freee } from './freee.js'

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

/** @param existingRow 同じ company_id の既存接続（再認可のテスト用） */
function makeApp(existingRow: unknown = null) {
  stmts = []
  sqls = []
  const db = {
    prepare: vi.fn().mockImplementation((sql: string) => {
      sqls.push(sql)
      // 最初の prepare は既存接続の検索（SELECT）
      const s = makeStmt(sqls.length === 1 ? existingRow : null)
      stmts.push(s)
      return s
    }),
  } as unknown as D1Database

  const app = new Hono<{ Bindings: Record<string, unknown> }>()
  app.route('/', freee)
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

  it('redirect=1 ならブラウザをリダイレクトする', async () => {
    const { app, env } = makeApp()
    const res = await app.request('/api/integrations/freee/auth?redirect=1', {}, env)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('accounts.secure.freee.co.jp')
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

  it('同じ company_id の接続が既にあれば UPDATE してトークンを差し替える', async () => {
    mockExchangeCodeForTokens.mockResolvedValue(TOKENS)
    const { app, env } = makeApp({ id: 'existing-1', is_active: 1 })

    await app.request('/api/integrations/freee/callback?code=the-code&state=signed-state', {}, env)

    expect(allSql()).toContain('UPDATE freee_accounts')
    expect(allSql()).not.toContain('INSERT INTO freee_accounts')
    expect(allBound()).toContain('existing-1')
    expect(allBound()).toContain('rt-1')
  })

  it('再認可で既存接続の is_active を 0 に戻さない（稼働中の連携を止めない）', async () => {
    mockExchangeCodeForTokens.mockResolvedValue(TOKENS)
    const { app, env } = makeApp({ id: 'existing-1', is_active: 1 })

    await app.request('/api/integrations/freee/callback?code=the-code&state=signed-state', {}, env)

    expect(allSql()).not.toMatch(/UPDATE freee_accounts[\s\S]*is_active/)
  })

  it('company_id が返らない場合は既存検索をせず新規保存する', async () => {
    mockExchangeCodeForTokens.mockResolvedValue({ ...TOKENS, company_id: undefined })
    const { app, env } = makeApp()

    await app.request('/api/integrations/freee/callback?code=the-code&state=signed-state', {}, env)

    expect(allSql()).toContain('INSERT INTO freee_accounts')
    expect(allSql()).not.toContain('SELECT')
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
