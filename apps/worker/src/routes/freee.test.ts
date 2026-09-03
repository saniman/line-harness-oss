import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

const mockGetFreeeAuthUrl = vi.hoisted(() => vi.fn())
const mockExchangeCodeForTokens = vi.hoisted(() => vi.fn())

vi.mock('../services/freee-oauth.js', () => ({
  getFreeeAuthUrl: mockGetFreeeAuthUrl,
  exchangeCodeForTokens: mockExchangeCodeForTokens,
}))

import { freee } from './freee.js'

function makeStmt() {
  return {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
    first: vi.fn().mockResolvedValue(null),
    all: vi.fn().mockResolvedValue({ results: [] }),
  }
}

let stmts: ReturnType<typeof makeStmt>[]

function makeApp() {
  stmts = []
  const db = {
    prepare: vi.fn().mockImplementation(() => {
      const s = makeStmt()
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

beforeEach(() => {
  vi.clearAllMocks()
  mockGetFreeeAuthUrl.mockReturnValue('https://accounts.secure.freee.co.jp/public_api/authorize?x=1')
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

  it('state を生成して認可URLに渡す（CSRF対策）', async () => {
    const { app, env } = makeApp()
    await app.request('/api/integrations/freee/auth', {}, env)
    const state = mockGetFreeeAuthUrl.mock.calls[0][1] as string
    expect(typeof state).toBe('string')
    expect(state.length).toBeGreaterThan(0)
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

    const res = await app.request('/api/integrations/freee/callback?code=the-code', {}, env)

    expect(res.status).toBe(200)
    expect(mockExchangeCodeForTokens).toHaveBeenCalledWith(expect.anything(), 'the-code')
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO freee_accounts'))
  })

  it('refresh_token を必ず保存する（freeeのリフレッシュトークンは1回限り・保存漏れで連携が死ぬ）', async () => {
    mockExchangeCodeForTokens.mockResolvedValue(TOKENS)
    const { app, env } = makeApp()

    await app.request('/api/integrations/freee/callback?code=the-code', {}, env)

    const bound = stmts.flatMap((s) => (s.bind as ReturnType<typeof vi.fn>).mock.calls.flat())
    expect(bound).toContain('rt-1')
    expect(bound).toContain('at-1')
  })

  it('company_id を保存する', async () => {
    mockExchangeCodeForTokens.mockResolvedValue(TOKENS)
    const { app, env } = makeApp()

    await app.request('/api/integrations/freee/callback?code=the-code', {}, env)

    const bound = stmts.flatMap((s) => (s.bind as ReturnType<typeof vi.fn>).mock.calls.flat())
    expect(bound).toContain(1234567)
  })

  it('トークン交換が失敗したら 500 を返し DB に書かない', async () => {
    mockExchangeCodeForTokens.mockRejectedValue(new Error('invalid_grant'))
    const { app, env, db } = makeApp()

    const res = await app.request('/api/integrations/freee/callback?code=bad', {}, env)

    expect(res.status).toBe(500)
    expect(db.prepare).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO freee_accounts'))
  })

  it('エラー画面に client_secret を出さない', async () => {
    mockExchangeCodeForTokens.mockRejectedValue(new Error('boom super-secret-value'))
    const { app, env } = makeApp()

    const res = await app.request('/api/integrations/freee/callback?code=bad', {}, env)
    const html = await res.text()
    expect(html).not.toContain('super-secret-value')
  })

  it('成功画面にアクセストークンを出さない', async () => {
    mockExchangeCodeForTokens.mockResolvedValue(TOKENS)
    const { app, env } = makeApp()

    const res = await app.request('/api/integrations/freee/callback?code=the-code', {}, env)
    const html = await res.text()
    expect(html).not.toContain('at-1')
    expect(html).not.toContain('rt-1')
  })
})
