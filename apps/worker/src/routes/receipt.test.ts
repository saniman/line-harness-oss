import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import receipt from './receipt.js';

const FREEE_URL = 'https://invoice.secure.freee.co.jp/ivex/dl/d03d03bd-204b-4a5f-bb48-03d5f13bef50';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 5,
    receipt_share_url: FREEE_URL,
    receipt_share_expires_at: '2099-01-01 00:00:00',
    receipt_share_revoked_at: null,
    receipt_share_opened_at: null,
    ...overrides,
  };
}

function makeDb(found: Record<string, unknown> | null = row()) {
  const sqls: string[] = [];
  const db = {
    prepare: vi.fn().mockImplementation((sql: string) => {
      sqls.push(sql);
      const stmt: Record<string, unknown> = {};
      stmt.bind = vi.fn().mockReturnValue(stmt);
      stmt.first = vi.fn().mockResolvedValue(found);
      stmt.run = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
      return stmt;
    }),
  } as unknown as D1Database;
  return { db, sqls };
}

const app = new Hono();
app.route('/', receipt);

beforeEach(() => { vi.clearAllMocks(); });

describe('GET /receipt/:token', () => {
  it('有効なトークンなら freee の共有リンクへ 302 する', async () => {
    const { db } = makeDb();

    const res = await app.request('/receipt/tok-1', {}, { DB: db });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(FREEE_URL);
  });

  it('【重要】存在しないトークンは 404（存在の有無を漏らさない）', async () => {
    const { db } = makeDb(null);

    const res = await app.request('/receipt/nope', {}, { DB: db });

    expect(res.status).toBe(404);
  });

  it('【重要】無効化されていたら 410（誤配を止められる）', async () => {
    const { db } = makeDb(row({ receipt_share_revoked_at: '2026-09-06 00:00:00' }));

    const res = await app.request('/receipt/tok-1', {}, { DB: db });

    expect(res.status).toBe(410);
    expect(res.headers.get('location')).toBe(null);
  });

  it('期限切れなら 410 で案内を出す', async () => {
    const { db } = makeDb(row({ receipt_share_expires_at: '2020-01-01 00:00:00' }));

    const res = await app.request('/receipt/tok-1', {}, { DB: db });

    expect(res.status).toBe(410);
    expect(await res.text()).toContain('期限');
  });

  it('開いた日時を記録する（被害範囲の把握に使う）', async () => {
    const { db, sqls } = makeDb();

    await app.request('/receipt/tok-1', {}, { DB: db });

    // ⚠️ SELECT の列名にも出るので UPDATE であることまで見る
    expect(sqls.some((q) => q.includes('UPDATE') && q.includes('receipt_share_opened_at = '))).toBe(true);
  });

  it('既に開かれていれば初回の日時を上書きしない', async () => {
    const { db, sqls } = makeDb(row({ receipt_share_opened_at: '2026-09-06 00:00:00' }));

    await app.request('/receipt/tok-1', {}, { DB: db });

    // 既に開かれていれば UPDATE を発行しない（初回の日時を保つ）
    expect(sqls.some((q) => q.includes('UPDATE'))).toBe(false);
  });

  it('【重要】検索避けとリファラ抑止のヘッダを付ける', async () => {
    // URL が検索に載ったり、遷移先に漏れたりしないようにする
    const { db } = makeDb();

    const res = await app.request('/receipt/tok-1', {}, { DB: db });

    expect(res.headers.get('X-Robots-Tag')).toContain('noindex');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('Cache-Control')).toContain('no-store');
  });

  it('【重要】共有 URL・トークンをログに出さない', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { db } = makeDb();

    await app.request('/receipt/tok-1', {}, { DB: db });

    const logged = spy.mock.calls.flat().join(' ');
    expect(logged).not.toContain('tok-1');
    expect(logged).not.toContain('invoice.secure.freee.co.jp');
    spy.mockRestore();
  });

  it('異常に長いトークンでも DB を引かない', async () => {
    const { db, sqls } = makeDb();

    const res = await app.request(`/receipt/${'a'.repeat(5000)}`, {}, { DB: db });

    expect(res.status).toBe(404);
    expect(sqls).toHaveLength(0);
  });
});

describe('GET /receipt/:token の認証', () => {
  it('【重要】認証なしで開ける（スキップリスト漏れの検出）', async () => {
    // 参加者は管理画面のトークンを持たない。401 になったら誰も領収書を見られない
    const { authMiddleware } = await import('../middleware/auth.js');
    const { db } = makeDb();
    const guarded = new Hono();
    guarded.use('*', authMiddleware as never);
    guarded.route('/', receipt);

    const res = await guarded.request('/receipt/tok-1', {}, { DB: db });

    expect(res.status).toBe(302);
  });
});
