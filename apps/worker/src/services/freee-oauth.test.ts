import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  getFreeeAuthUrl,
  exchangeCodeForTokens,
  createOAuthState,
  verifyOAuthState,
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
