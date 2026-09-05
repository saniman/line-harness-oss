import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  getFreeeAuthUrl,
  exchangeCodeForTokens,
  createOAuthState,
  verifyOAuthState,
  getValidAccessTokenFreee,
  fetchFreeeCompanyName,
} from './freee-oauth.js';

const ENV = {
  FREEE_CLIENT_ID: 'client-abc',
  FREEE_CLIENT_SECRET: 'super-secret-value',
  FREEE_REDIRECT_URI: undefined,
} as unknown as Parameters<typeof getFreeeAuthUrl>[0];

const ENV_WITH_REDIRECT = {
  ...ENV,
  FREEE_REDIRECT_URI: 'https://example.test/api/integrations/freee/callback',
} as unknown as Parameters<typeof getFreeeAuthUrl>[0];

describe('getFreeeAuthUrl', () => {
  it('freee の認可エンドポイントを指す', () => {
    const url = new URL(getFreeeAuthUrl(ENV));
    expect(url.origin).toBe('https://accounts.secure.freee.co.jp');
    expect(url.pathname).toBe('/public_api/authorize');
  });

  it('必須パラメータ（response_type/client_id/redirect_uri）を含む', () => {
    const url = new URL(getFreeeAuthUrl(ENV));
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-abc');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://api.walover-co.work/api/integrations/freee/callback',
    );
  });

  it('scope パラメータを付けない（freee はアプリ登録側でスコープを決めるため）', () => {
    // Google と違い freee の認可URLに scope は無い。付けると仕様外のパラメータになる。
    const url = new URL(getFreeeAuthUrl(ENV));
    expect(url.searchParams.has('scope')).toBe(false);
  });

  it('prompt=select_company を付ける（freee は事業所を選ばせる必要がある）', () => {
    const url = new URL(getFreeeAuthUrl(ENV));
    expect(url.searchParams.get('prompt')).toBe('select_company');
  });

  it('state を渡すとそのまま載る（CSRF対策）', () => {
    const url = new URL(getFreeeAuthUrl(ENV, 'csrf-token-123'));
    expect(url.searchParams.get('state')).toBe('csrf-token-123');
  });

  it('state を渡さない場合は state パラメータを付けない', () => {
    const url = new URL(getFreeeAuthUrl(ENV));
    expect(url.searchParams.has('state')).toBe(false);
  });

  it('FREEE_REDIRECT_URI が設定されていればそちらを優先する', () => {
    const url = new URL(getFreeeAuthUrl(ENV_WITH_REDIRECT));
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://example.test/api/integrations/freee/callback',
    );
  });

  it('FREEE_CLIENT_ID が未設定なら例外を投げる', () => {
    // 未設定のまま組み立てると client_id=undefined で freee に飛び、
    // 原因の分からないエラー画面になる。設定漏れだと分かる形で落とす。
    const noId = { ...ENV, FREEE_CLIENT_ID: undefined } as unknown as typeof ENV;
    expect(() => getFreeeAuthUrl(noId)).toThrow(/FREEE_CLIENT_ID/);
  });

  it('FREEE_CLIENT_ID が空文字でも例外を投げる', () => {
    const emptyId = { ...ENV, FREEE_CLIENT_ID: '' } as unknown as typeof ENV;
    expect(() => getFreeeAuthUrl(emptyId)).toThrow(/FREEE_CLIENT_ID/);
  });

  it('client_secret を認可URLに載せない', () => {
    // 認可URLはブラウザのアドレスバーに出る。secret が載ったら漏洩。
    expect(getFreeeAuthUrl(ENV)).not.toContain('super-secret-value');
  });
});

describe('exchangeCodeForTokens', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => { vi.unstubAllGlobals() });

  function okResponse(body: unknown) {
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  }

  it('トークンエンドポイントへ authorization_code で POST する', async () => {
    fetchMock.mockResolvedValue(okResponse({
      access_token: 'at-1', refresh_token: 'rt-1', expires_in: 21600,
    }));

    await exchangeCodeForTokens(ENV, 'the-code');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://accounts.secure.freee.co.jp/public_api/token');
    expect(init.method).toBe('POST');

    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('client_id')).toBe('client-abc');
    expect(body.get('client_secret')).toBe('super-secret-value');
    expect(body.get('code')).toBe('the-code');
    expect(body.get('redirect_uri')).toBe(
      'https://api.walover-co.work/api/integrations/freee/callback',
    );
  });

  it('access_token / refresh_token / expires_in を返す', async () => {
    fetchMock.mockResolvedValue(okResponse({
      access_token: 'at-1', refresh_token: 'rt-1', expires_in: 21600,
    }));

    const tokens = await exchangeCodeForTokens(ENV, 'the-code');

    expect(tokens.access_token).toBe('at-1');
    expect(tokens.refresh_token).toBe('rt-1');
    expect(tokens.expires_in).toBe(21600);
  });

  it('company_id が返れば拾う（freee は事業所単位で連携するため）', async () => {
    fetchMock.mockResolvedValue(okResponse({
      access_token: 'at-1', refresh_token: 'rt-1', expires_in: 21600, company_id: 1234567,
    }));

    const tokens = await exchangeCodeForTokens(ENV, 'the-code');
    expect(tokens.company_id).toBe(1234567);
  });

  it('company_id が返らなくてもエラーにしない', async () => {
    fetchMock.mockResolvedValue(okResponse({
      access_token: 'at-1', refresh_token: 'rt-1', expires_in: 21600,
    }));

    const tokens = await exchangeCodeForTokens(ENV, 'the-code');
    expect(tokens.company_id).toBeUndefined();
  });

  it('失敗レスポンスなら例外を投げる', async () => {
    fetchMock.mockResolvedValue({
      ok: false, status: 400,
      text: async () => '{"error":"invalid_grant"}',
      json: async () => ({ error: 'invalid_grant' }),
    });

    await expect(exchangeCodeForTokens(ENV, 'bad-code')).rejects.toThrow(/invalid_grant/);
  });

  it('access_token が欠けたレスポンスは例外にする', async () => {
    // 形を検証しないと後段で new Date(NaN) や bind(undefined) になり、
    // 「原因不明の500」に化ける（認可コードは消費済みなのでリトライしても直らない）
    fetchMock.mockResolvedValue(okResponse({ refresh_token: 'rt-1', expires_in: 21600 }));
    await expect(exchangeCodeForTokens(ENV, 'the-code')).rejects.toThrow(/access_token/);
  });

  it('refresh_token が欠けたレスポンスは例外にする', async () => {
    fetchMock.mockResolvedValue(okResponse({ access_token: 'at-1', expires_in: 21600 }));
    await expect(exchangeCodeForTokens(ENV, 'the-code')).rejects.toThrow(/refresh_token/);
  });

  it('expires_in が数値でないレスポンスは例外にする', async () => {
    // new Date(NaN).toISOString() は RangeError になる
    fetchMock.mockResolvedValue(okResponse({
      access_token: 'at-1', refresh_token: 'rt-1', expires_in: 'six hours',
    }));
    await expect(exchangeCodeForTokens(ENV, 'the-code')).rejects.toThrow(/expires_in/);
  });

  it('例外メッセージに client_secret を含めない', async () => {
    // エラーは Workers Logs に残る。secret が載ると閲覧権限だけで漏れる。
    fetchMock.mockResolvedValue({
      ok: false, status: 400,
      text: async () => '{"error":"invalid_grant"}',
      json: async () => ({ error: 'invalid_grant' }),
    });

    await expect(exchangeCodeForTokens(ENV, 'bad-code')).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining('super-secret-value') as unknown as string,
      }),
    );
  });
});

describe('OAuth state の署名と検証', () => {
  it('署名付き state を発行できる', async () => {
    const state = await createOAuthState(ENV);
    expect(typeof state).toBe('string');
    expect(state.length).toBeGreaterThan(0);
  });

  it('自分で発行した state は検証を通る', async () => {
    const state = await createOAuthState(ENV);
    expect(await verifyOAuthState(ENV, state)).toBe(true);
  });

  it('毎回ちがう state を発行する（使い回しを防ぐ）', async () => {
    const a = await createOAuthState(ENV);
    const b = await createOAuthState(ENV);
    expect(a).not.toBe(b);
  });

  it('未署名の適当な文字列は拒否する', async () => {
    expect(await verifyOAuthState(ENV, 'attacker-made-this')).toBe(false);
  });

  it('空文字・undefined は拒否する', async () => {
    expect(await verifyOAuthState(ENV, '')).toBe(false);
    expect(await verifyOAuthState(ENV, undefined)).toBe(false);
  });

  it('署名を改ざんした state は拒否する', async () => {
    const state = await createOAuthState(ENV);
    const [payload] = state.split('.');
    const tampered = `${payload}.YWJjZGVm`;
    expect(await verifyOAuthState(ENV, tampered)).toBe(false);
  });

  it('中身を差し替えた state は拒否する（署名が合わなくなる）', async () => {
    const state = await createOAuthState(ENV);
    const [, sig] = state.split('.');
    const forgedPayload = btoa(JSON.stringify({ n: 'forged', t: Date.now() }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(await verifyOAuthState(ENV, `${forgedPayload}.${sig}`)).toBe(false);
  });

  it('別のシークレットで署名された state は拒否する', async () => {
    const otherEnv = { ...ENV, FREEE_CLIENT_SECRET: 'someone-elses-secret' } as typeof ENV;
    const state = await createOAuthState(otherEnv);
    expect(await verifyOAuthState(ENV, state)).toBe(false);
  });

  it('発行から10分を超えた state は拒否する', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-04T10:00:00Z'));
      const state = await createOAuthState(ENV);
      expect(await verifyOAuthState(ENV, state)).toBe(true);

      vi.setSystemTime(new Date('2026-09-04T10:10:01Z'));
      expect(await verifyOAuthState(ENV, state)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('未来の時刻で署名された state は拒否する（age >= 0 のガードを通す）', async () => {
    // 「署名が無いので落ちる」テストでは age >= 0 のガードを通らず、
    // ガードを消してもテストが緑のままになる（空振り）。
    // 正しい署名を持つ未来日付の state を作って、時刻判定だけで落ちることを確かめる。
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-04T11:00:00Z'));
      const futureState = await createOAuthState(ENV); // t = 11:00 で署名

      vi.setSystemTime(new Date('2026-09-04T10:00:00Z')); // now = 10:00 → age = -1時間
      expect(await verifyOAuthState(ENV, futureState)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── トークン自動リフレッシュ ────────────────────────────────────────────────

function makeStmt(firstResult: unknown = null) {
  return {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
    first: vi.fn().mockResolvedValue(firstResult),
    all: vi.fn().mockResolvedValue({ results: [] }),
  };
}

function makeDb(...stmts: ReturnType<typeof makeStmt>[]) {
  let i = 0;
  const sqls: string[] = [];
  const used: ReturnType<typeof makeStmt>[] = [];
  const db = {
    prepare: vi.fn().mockImplementation((sql: string) => {
      sqls.push(sql);
      const s = stmts[i++] ?? makeStmt();
      used.push(s);
      return s;
    }),
  } as unknown as D1Database;
  return { db, sqls, used };
}

/** 有効な接続行（期限は十分先） */
function activeConn(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn-1',
    company_id: 1234567,
    access_token: 'at-old',
    refresh_token: 'rt-old',
    token_expires_at: '2099-01-01T00:00:00.000+09:00',
    is_active: 1,
    ...overrides,
  };
}

describe('getValidAccessTokenFreee', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => { vi.unstubAllGlobals() });

  function tokenResponse(body: unknown) {
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  }

  it('有効な接続が無ければ FREEE_NOT_CONNECTED を投げる', async () => {
    const { db } = makeDb(makeStmt(null));
    await expect(getValidAccessTokenFreee(ENV, db)).rejects.toThrow('FREEE_NOT_CONNECTED');
  });

  it('保留（is_active=0）の接続は対象にしない', async () => {
    const { db, sqls } = makeDb(makeStmt(null));
    await expect(getValidAccessTokenFreee(ENV, db)).rejects.toThrow('FREEE_NOT_CONNECTED');
    expect(sqls[0]).toContain('is_active = 1');
  });

  it('期限に余裕があればリフレッシュせず既存トークンを返す', async () => {
    const { db } = makeDb(makeStmt(activeConn()));
    const result = await getValidAccessTokenFreee(ENV, db);
    expect(result.accessToken).toBe('at-old');
    expect(result.companyId).toBe(1234567);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('期限が近いのに refresh_token が無ければ REAUTH_REQUIRED を投げる', async () => {
    const { db } = makeDb(makeStmt(activeConn({
      refresh_token: null, token_expires_at: '2020-01-01T00:00:00.000+09:00',
    })));
    await expect(getValidAccessTokenFreee(ENV, db)).rejects.toThrow('REAUTH_REQUIRED');
  });

  it('refresh_token が無くても期限に余裕があれば既存トークンを使う', async () => {
    // まだ使えるトークンをわざわざ失敗させない
    const { db } = makeDb(makeStmt(activeConn({ refresh_token: null })));
    const result = await getValidAccessTokenFreee(ENV, db);
    expect(result.accessToken).toBe('at-old');
  });

  it('期限切れ間近ならリフレッシュして新しいトークンを返す', async () => {
    fetchMock.mockResolvedValue(tokenResponse({
      access_token: 'at-new', refresh_token: 'rt-new', expires_in: 21600,
    }));
    const { db } = makeDb(makeStmt(activeConn({ token_expires_at: '2020-01-01T00:00:00.000+09:00' })));

    const result = await getValidAccessTokenFreee(ENV, db);

    expect(result.accessToken).toBe('at-new');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('【最重要】リフレッシュ時に新しい refresh_token を保存する', async () => {
    // freee の refresh_token は1回限り。保存し忘れると次回のリフレッシュが必ず失敗し、
    // 連携が死ぬ。Google 版の getValidAccessToken は refresh_token を更新しない。
    fetchMock.mockResolvedValue(tokenResponse({
      access_token: 'at-new', refresh_token: 'rt-new', expires_in: 21600,
    }));
    const updateStmt = makeStmt();
    const { db } = makeDb(makeStmt(activeConn({ token_expires_at: '2020-01-01T00:00:00.000+09:00' })), updateStmt);

    await getValidAccessTokenFreee(ENV, db);

    const bound = (updateStmt.bind as ReturnType<typeof vi.fn>).mock.calls.flat();
    expect(bound).toContain('rt-new');
  });

  it('リフレッシュの UPDATE 文が refresh_token を含む', async () => {
    fetchMock.mockResolvedValue(tokenResponse({
      access_token: 'at-new', refresh_token: 'rt-new', expires_in: 21600,
    }));
    const { db, sqls } = makeDb(makeStmt(activeConn({ token_expires_at: '2020-01-01T00:00:00.000+09:00' })));

    await getValidAccessTokenFreee(ENV, db);

    const updateSql = sqls.find((q) => q.includes('UPDATE freee_accounts')) ?? '';
    expect(updateSql).toContain('refresh_token');
    expect(updateSql).toContain('access_token');
    expect(updateSql).toContain('token_expires_at');
  });

  it('保存する期限は JST(+09:00) にする（文字列比較でずれないため）', async () => {
    fetchMock.mockResolvedValue(tokenResponse({
      access_token: 'at-new', refresh_token: 'rt-new', expires_in: 21600,
    }));
    const updateStmt = makeStmt();
    const { db } = makeDb(makeStmt(activeConn({ token_expires_at: '2020-01-01T00:00:00.000+09:00' })), updateStmt);

    await getValidAccessTokenFreee(ENV, db);

    const bound = (updateStmt.bind as ReturnType<typeof vi.fn>).mock.calls.flat();
    expect(bound.some((v) => typeof v === 'string' && v.endsWith('+09:00'))).toBe(true);
    expect(bound.some((v) => typeof v === 'string' && /Z$/.test(v))).toBe(false);
  });

  it('古い refresh_token を条件にした UPDATE にする（同時リフレッシュ対策）', async () => {
    // 同時に2本走ると片方の refresh_token が無効化される。
    // 「読んだときの値」を条件に更新し、負けた側が上書きしないようにする。
    fetchMock.mockResolvedValue(tokenResponse({
      access_token: 'at-new', refresh_token: 'rt-new', expires_in: 21600,
    }));
    const { db, sqls } = makeDb(makeStmt(activeConn({ token_expires_at: '2020-01-01T00:00:00.000+09:00' })));

    await getValidAccessTokenFreee(ENV, db);

    const updateSql = sqls.find((q) => q.includes('UPDATE freee_accounts')) ?? '';
    expect(updateSql).toMatch(/WHERE[\s\S]*refresh_token = \?/);
  });

  it('同時リフレッシュに負けたら、勝った側のトークンを読み直して返す', async () => {
    fetchMock.mockResolvedValue(tokenResponse({
      access_token: 'at-mine', refresh_token: 'rt-mine', expires_in: 21600,
    }));
    const lostUpdate = makeStmt();
    lostUpdate.run.mockResolvedValue({ meta: { changes: 0 } }); // 誰かが先に更新した
    const { db } = makeDb(
      makeStmt(activeConn({ token_expires_at: '2020-01-01T00:00:00.000+09:00' })),
      lostUpdate,
      makeStmt(activeConn({ access_token: 'at-winner' })), // 読み直し
    );

    const result = await getValidAccessTokenFreee(ENV, db);

    expect(result.accessToken).toBe('at-winner');
  });

  it('リフレッシュが失敗したら接続を保留に戻して REAUTH_REQUIRED を投げる', async () => {
    // 90日超過や refresh_token の使い回しで失効した場合。
    // is_active=1 のままだと管理画面で「連携済み」に見えて原因に気づけない。
    fetchMock.mockResolvedValue({
      ok: false, status: 401,
      text: async () => '{"error":"invalid_grant"}',
      json: async () => ({ error: 'invalid_grant' }),
    });
    const { db, sqls } = makeDb(makeStmt(activeConn({ token_expires_at: '2020-01-01T00:00:00.000+09:00' })));

    await expect(getValidAccessTokenFreee(ENV, db)).rejects.toThrow('REAUTH_REQUIRED');

    expect(sqls.some((q) => q.includes('is_active = 0'))).toBe(true);
  });
});

describe('fetchFreeeCompanyName', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => { vi.unstubAllGlobals() });

  function ok(body: unknown) {
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  }

  it('company_id に一致する事業所の display_name を返す', async () => {
    fetchMock.mockResolvedValue(ok({ companies: [
      { id: 111, name: 'ほか', display_name: 'ほか事業所' },
      { id: 1234567, name: 'walover', display_name: 'WALOVER合同会社' },
    ] }));
    expect(await fetchFreeeCompanyName('at-1', 1234567)).toBe('WALOVER合同会社');
  });

  it('display_name が無ければ name を使う', async () => {
    fetchMock.mockResolvedValue(ok({ companies: [{ id: 1234567, name: 'walover' }] }));
    expect(await fetchFreeeCompanyName('at-1', 1234567)).toBe('walover');
  });

  it('一致する事業所が無ければ null', async () => {
    fetchMock.mockResolvedValue(ok({ companies: [{ id: 111, display_name: 'ほか' }] }));
    expect(await fetchFreeeCompanyName('at-1', 1234567)).toBeNull();
  });

  it('APIが失敗しても例外を投げず null を返す（連携自体は成功させる）', async () => {
    // アプリのスコープが会計APIを含まない場合など。名前が無くても company_id で見分けられる。
    fetchMock.mockResolvedValue({ ok: false, status: 403, text: async () => 'forbidden' });
    expect(await fetchFreeeCompanyName('at-1', 1234567)).toBeNull();
  });

  it('通信自体が失敗しても null を返す', async () => {
    fetchMock.mockRejectedValue(new Error('network'));
    expect(await fetchFreeeCompanyName('at-1', 1234567)).toBeNull();
  });

  it('レスポンスの形が想定外でも null を返す', async () => {
    fetchMock.mockResolvedValue(ok({ unexpected: true }));
    expect(await fetchFreeeCompanyName('at-1', 1234567)).toBeNull();
  });
});
