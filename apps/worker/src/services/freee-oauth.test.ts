import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { getFreeeAuthUrl, exchangeCodeForTokens } from './freee-oauth.js';

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
