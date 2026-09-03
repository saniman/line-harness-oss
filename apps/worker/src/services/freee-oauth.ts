/**
 * freee OAuth2（認可コードフロー）
 *
 * 現金決済領収書自動化（Epic #41）で freee請求書 API を叩くためのトークンを取得する。
 * 実装方針は既存の Google Calendar 連携（services/google-calendar.ts）に揃えているが、
 * freee 固有の差異が3つあるので注意する。
 *
 * 1. 認可URLに `scope` を渡さない
 *    freee はアプリ登録画面でスコープを設定する方式。Google のように認可URLへ
 *    scope を載せる仕様ではない。
 *
 * 2. `prompt=select_company` が必要
 *    freee は1アカウントが複数の事業所を持てるため、どの事業所と連携するかを選ばせる。
 *
 * 3. ⚠️ リフレッシュトークンは「1回限り・有効期限90日」
 *    Google の refresh_token は再利用可・無期限だが、freee は使うたびに新しい
 *    refresh_token が発行され、古いものは無効になる（rotating refresh token）。
 *    → リフレッシュ時は **必ず新しい refresh_token を保存し直す**。
 *      保存し忘れると次回のリフレッシュが失敗し、連携が死ぬ。
 *    → 90日間まったくリフレッシュしないと失効する。再認証導線が必須（#44）。
 *    出典: https://developer.freee.co.jp/reference/認可コード
 */

import type { Env } from '../index.js';

const FREEE_AUTHORIZE_URL = 'https://accounts.secure.freee.co.jp/public_api/authorize';
const FREEE_TOKEN_URL = 'https://accounts.secure.freee.co.jp/public_api/token';
const DEFAULT_REDIRECT_URI = 'https://api.walover-co.work/api/integrations/freee/callback';

export interface FreeeTokens {
  access_token: string;
  refresh_token: string;
  /** アクセストークンの有効期間（秒） */
  expires_in: number;
  /** 連携先の事業所ID。返らない場合もあるので optional */
  company_id?: number;
}

function redirectUri(env: Env['Bindings']): string {
  return env.FREEE_REDIRECT_URI ?? DEFAULT_REDIRECT_URI;
}

/**
 * freee の認可画面URLを組み立てる。
 *
 * `scope` は付けない（freee はアプリ登録側でスコープを決めるため。上部コメント参照）。
 */
export function getFreeeAuthUrl(env: Env['Bindings'], state?: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: env.FREEE_CLIENT_ID,
    redirect_uri: redirectUri(env),
    // freee は事業所を選ばせる必要がある
    prompt: 'select_company',
    ...(state ? { state } : {}),
  });
  return `${FREEE_AUTHORIZE_URL}?${params}`;
}

/**
 * 認可コードをアクセストークン／リフレッシュトークンに交換する。
 *
 * エラー時は freee のレスポンス本文だけを載せる。
 * リクエストボディ（client_secret を含む）は絶対にメッセージへ入れない。
 */
export async function exchangeCodeForTokens(
  env: Env['Bindings'],
  code: string,
): Promise<FreeeTokens> {
  const res = await fetch(FREEE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: env.FREEE_CLIENT_ID,
      client_secret: env.FREEE_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri(env),
    }).toString(),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`freee token exchange failed (${res.status}): ${body}`);
  }

  return res.json<FreeeTokens>();
}
