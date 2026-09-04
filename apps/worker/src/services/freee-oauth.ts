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

  const data = await res.json<Partial<FreeeTokens>>();

  // 形を検証しないと後段で new Date(NaN).toISOString() の RangeError や
  // D1 の bind(undefined) になり、「原因不明の500」に化ける。
  // 認可コードは既に消費済みでリトライしても直らないため、原因を名指しで残す。
  if (typeof data.access_token !== 'string' || data.access_token === '') {
    throw new Error('freee token response: access_token がありません');
  }
  if (typeof data.refresh_token !== 'string' || data.refresh_token === '') {
    throw new Error('freee token response: refresh_token がありません');
  }
  if (typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in)) {
    throw new Error('freee token response: expires_in が数値ではありません');
  }

  return data as FreeeTokens;
}

// ── OAuth state（CSRF 対策）─────────────────────────────────────────────────

/**
 * state の有効期間。認可画面で事業所を選ぶ時間を見て10分。
 */
const STATE_TTL_MS = 10 * 60 * 1000;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodePayload(payload: object): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
}

function decodePayload(encoded: string): { n?: string; t?: number } | null {
  try {
    const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(b64)) as { n?: string; t?: number };
  } catch {
    return null;
  }
}

async function sign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return base64UrlEncode(new Uint8Array(sig));
}

/** 長さに依存しない比較（署名の一致判定をタイミング差から守る） */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * 署名付きの state を発行する。
 *
 * DB に保存しない（Workers で状態を持たずに済ませる）代わりに、
 * client_secret を鍵にした HMAC で「我々が発行したものか」を検証できるようにする。
 * 発行時刻を載せて有効期間を区切り、使い回しの窓を狭める。
 */
export async function createOAuthState(env: Env['Bindings']): Promise<string> {
  const payload = encodePayload({ n: crypto.randomUUID(), t: Date.now() });
  const signature = await sign(env.FREEE_CLIENT_SECRET, payload);
  return `${payload}.${signature}`;
}

/**
 * state が我々の発行したもので、かつ期限内かを検証する。
 *
 * ⚠️ **これは第三者の登録を防ぐものではない。**
 *    state を配る /auth 自体が無認証の公開エンドポイントなので、攻撃者はそれを叩いて
 *    正規の state を取得し、自分の freee 事業所で認可を完走できる（署名検証は通る）。
 *    さらに state は DB に記録していないため、10分の有効期間内は再利用できる。
 *
 *    ここで防げるのは「偽造・改ざん・期限切れの state を持つコールバック」だけ。
 *    第三者の登録を無害化しているのは routes/freee.ts 側の
 *    「新規接続は is_active=0 で保留し、有効化は認証済みの管理画面から行う」方。
 */
export async function verifyOAuthState(
  env: Env['Bindings'],
  state: string | undefined | null,
): Promise<boolean> {
  if (!state) return false;

  const [payload, signature] = state.split('.');
  if (!payload || !signature) return false;

  const expected = await sign(env.FREEE_CLIENT_SECRET, payload);
  if (!safeEqual(signature, expected)) return false;

  const decoded = decodePayload(payload);
  if (!decoded || typeof decoded.t !== 'number') return false;

  const age = Date.now() - decoded.t;
  // 過去10分以内のみ有効。負値（未来の時刻）も弾く。
  return age >= 0 && age <= STATE_TTL_MS;
}
