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

import { jstNow, toJstString } from '@line-crm/db';
import type { Env } from '../index.js';

const FREEE_AUTHORIZE_URL = 'https://accounts.secure.freee.co.jp/public_api/authorize';
const FREEE_TOKEN_URL = 'https://accounts.secure.freee.co.jp/public_api/token';

/**
 * トークン更新のタイムアウト。
 *
 * ⚠️ **短くしてはいけない。** freee は refresh_token を**回転**させる（使い捨て）。
 *    レスポンスを受け取る前に中断すると、freee 側では既に回転が済んでいるのに
 *    新しい refresh_token をこちらが保存できず、以降は死んだトークンを送り続けて
 *    invalid_grant になる。**人間が再連携するまで領収書が止まる恒久障害**で、
 *    しかも新しいトークンは二度と手に入らないので自動復旧もできない。
 *
 * 一方でこの呼び出しは現金受領ボタンの応答に同期でぶら下がっているため、
 * 無制限に待つとボタンが無反応になる。
 *
 * 「無反応が最大 25 秒」と「再連携が必要な恒久障害」を比べて前者を選ぶ。
 * タイムアウトは長いほど応答を受け取れる＝トークンを失いにくいので、
 * **応答性のためにここを縮めない**こと（8 秒にして事故りかけた）。
 */
export const TOKEN_TIMEOUT_MS = 25_000;
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
  // 未設定のまま組み立てると client_id=undefined で freee に飛び、
  // freee 側の「原因の分からないエラー画面」に着地する。設定漏れだと分かる形で落とす。
  if (!env.FREEE_CLIENT_ID) {
    throw new Error('FREEE_CLIENT_ID が未設定です（wrangler secret put で設定してください）');
  }

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

// ── トークンの自動リフレッシュ ──────────────────────────────────────────────
//
// ⚠️ 設計上の約束：**このモジュールは freee_accounts.is_active を絶対に書かない。**
//
//    is_active は「管理者がどの事業所を使うと決めたか」を表す列で、
//    書き手は管理画面（有効化・無効化・新規は保留で挿入）だけに限る。
//
//    かつてリフレッシュ処理からも書いていたが、書き手が競合して2つのレースを生んだ:
//      1. 同時リフレッシュに負けた側が、勝った側の接続を保留に落とす
//      2. 飛行中のリフレッシュが、管理者の切り替え（A→B）を巻き戻す
//    片方を塞ぐともう片方が復活する構造だったため、書き手を1つに減らして解消した。
//
//    失効の可視化は is_active ではなく **token_expires_at が過去であること**で行う
//    （管理画面が「⚠️ 要再連携」を表示する）。

/**
 * リフレッシュの失敗種別。
 *
 * `permanent = true` は再認可しか復旧手段がないもの（失効・取り消し）。
 * `false` は一時障害（5xx / 429 / 通信断）で、**接続を落としてはいけない**。
 * ここを区別しないと、freee 側の短い障害で連携が保留に落ち、
 * 人間が有効化し直すまで領収書が止まる。
 */
export class FreeeAuthError extends Error {
  constructor(message: string, readonly permanent: boolean) {
    super(message);
    this.name = 'FreeeAuthError';
  }
}

/**
 * freee の refresh_token を使って新しいトークン一式を得る。
 *
 * ⚠️ freee の refresh_token は **1回限り**。呼ぶたびに新しい refresh_token が
 *    発行され、渡した古い値は無効になる。返り値の refresh_token を必ず保存すること。
 */
export async function refreshFreeeTokens(
  env: Env['Bindings'],
  refreshToken: string,
): Promise<FreeeTokens> {
  const res = await fetch(FREEE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: env.FREEE_CLIENT_ID,
      client_secret: env.FREEE_CLIENT_SECRET,
      refresh_token: refreshToken,
    }).toString(),
    // ⚠️ 中断すると回転済みの refresh_token を取り逃す。値の根拠は TOKEN_TIMEOUT_MS を読むこと
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');

    // ⚠️ HTTP ステータスだけで「失効」と判断してはいけない。
    //    RFC 6749 §5.2 は invalid_client（＝client_secret の設定ミス）にも 401 を許すため、
    //    ステータス判定だと wrangler secret put の打ち間違いで全接続が保留に落ち、
    //    シークレットを直しても人間が有効化し直すまで復旧しなくなる。
    //    OAuth のエラーコードまで見てドメインエラーに変換する。
    //    参照: .claude/rules/api-coding.md「OAuth APIのエラーコードはドメインエラーに変換する」
    let code: string | undefined;
    try {
      code = (JSON.parse(body) as { error?: string }).error;
    } catch {
      // 本文が JSON でない＝判断がつかない。壊さない側（一時障害）に倒す
    }

    // 再認可しか復旧手段が無いのは invalid_grant（失効・取り消し）だけ
    const permanent = code === 'invalid_grant';
    throw new FreeeAuthError(`freee token refresh failed (${res.status}): ${body}`, permanent);
  }

  const data = await res.json<Partial<FreeeTokens>>();
  // 空文字も弾く。通してしまうと CAS UPDATE が成立し、
  // 有効な refresh_token を空で上書きして再認可以外に復旧手段が無くなる。
  if (!data.access_token || typeof data.access_token !== 'string') {
    throw new Error('freee refresh response: access_token がありません');
  }
  if (!data.refresh_token || typeof data.refresh_token !== 'string') {
    throw new Error('freee refresh response: refresh_token がありません');
  }
  if (typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in)) {
    throw new Error('freee refresh response: expires_in が数値ではありません');
  }
  return data as FreeeTokens;
}

interface FreeeAccountRow {
  id: string;
  company_id: number;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  is_active: number;
}

/**
 * 期限まで5分を切っていたら更新する。
 *
 * 未設定・解釈できない値も「期限切れ」として扱う（fail safe）。
 * NaN との比較は false になるため、素直に書くと壊れた値のときに
 * 二度とリフレッシュされず、freee が 401 を返し続ける状態から自力で戻れない。
 */
function expiringSoon(expiresAt: string | null): boolean {
  if (!expiresAt) return true;
  const at = new Date(expiresAt).getTime();
  if (Number.isNaN(at)) return true;
  return at - Date.now() < 5 * 60 * 1000;
}

/**
 * 有効化済みの freee 接続から、使えるアクセストークンを得る。
 * 期限が近ければリフレッシュし、**新しい refresh_token を保存し直す**。
 *
 * @throws FREEE_NOT_CONNECTED  有効化された接続が無い（未連携 or 保留のまま）
 * @throws REAUTH_REQUIRED      リフレッシュできない（失効等）。再認可が必要
 */
export async function getValidAccessTokenFreee(
  env: Env['Bindings'],
  db: D1Database,
  /**
   * 期限が残っていてもリフレッシュし直す。
   *
   * freee 側でアプリ連携を解除されると、**期限内のトークンでも 401 になる**。
   * その状態はキャッシュを見ても分からないので、401 を受けた呼び出し元が
   * 一度だけこれを立てて取り直す（services/freee-receipt.ts 参照）。
   */
  forceRefresh = false,
): Promise<{ accessToken: string; companyId: number; connectionId: string }> {
  const conn = await db
    .prepare('SELECT * FROM freee_accounts WHERE is_active = 1 ORDER BY updated_at DESC LIMIT 1')
    .first<FreeeAccountRow>();

  if (!conn) throw new Error('FREEE_NOT_CONNECTED');

  if (!forceRefresh && !expiringSoon(conn.token_expires_at) && conn.access_token) {
    return { accessToken: conn.access_token, companyId: conn.company_id, connectionId: conn.id };
  }

  if (!conn.refresh_token) {
    console.error('[freee] refresh_token が未設定 — 再認可が必要です:', conn.id);
    throw new Error('REAUTH_REQUIRED');
  }

  let tokens: FreeeTokens;
  try {
    tokens = await refreshFreeeTokens(env, conn.refresh_token);
  } catch (err) {
    // 一時障害では接続を落とさない。落とすと人間が有効化し直すまで領収書が止まる。
    if (!(err instanceof FreeeAuthError) || !err.permanent) {
      console.error('[freee] リフレッシュに一時的に失敗しました（接続は維持）:', conn.id, err);
      throw new Error('FREEE_TEMPORARILY_UNAVAILABLE');
    }

    // ⚠️ 恒久的失敗に見えても「同時実行に負けただけ」の可能性がある。
    //    freee は refresh_token を回転させるため、負けた側は必ず invalid_grant になる。
    //    refresh_token が読んだ値から変わっていれば、誰かが先に回した＝勝者がいる。
    const fresh = await db
      .prepare('SELECT * FROM freee_accounts WHERE id = ?')
      .bind(conn.id)
      .first<FreeeAccountRow>();

    const someoneElseRotated = !!fresh && fresh.refresh_token !== conn.refresh_token;
    if (someoneElseRotated && fresh.access_token && fresh.is_active) {
      console.warn('[freee] 同時リフレッシュに負けたため勝った側のトークンを使います:', conn.id);
      return { accessToken: fresh.access_token, companyId: fresh.company_id, connectionId: fresh.id };
    }

    // ⚠️ ここで is_active を落とさない（上部コメント参照）。
    //    失効は token_expires_at が過去のままであることで管理画面に表れる。
    console.error('[freee] リフレッシュに失敗しました。再認可が必要です:', conn.id, err);
    throw new Error('REAUTH_REQUIRED');
  }

  // ⚠️ 読んだときの refresh_token を条件にして更新する（compare-and-swap）。
  //    同時に2本リフレッシュが走ると片方の refresh_token が無効化されるため、
  //    負けた側が有効なトークンを古い値で上書きしないようにする。
  const expiresAt = toJstString(new Date(Date.now() + tokens.expires_in * 1000));
  const result = await db
    .prepare(
      // ⚠️ is_active は書かない（このモジュールは一切触らない。上部コメント参照）。
      //    書くと、飛行中のリフレッシュが管理者の切り替えを巻き戻す。
      `UPDATE freee_accounts
          SET access_token = ?, refresh_token = ?, token_expires_at = ?, updated_at = ?
        WHERE id = ? AND refresh_token = ?`,
    )
    .bind(tokens.access_token, tokens.refresh_token, expiresAt, jstNow(), conn.id, conn.refresh_token)
    .run();

  if (!result.meta.changes) {
    // 競合に負けた。勝った側が保存したトークンを読み直して使う。
    console.warn('[freee] 同時リフレッシュに負けたため読み直します:', conn.id);
    const fresh = await db
      .prepare('SELECT * FROM freee_accounts WHERE id = ?')
      .bind(conn.id)
      .first<FreeeAccountRow>();
    // 「有効化された接続だけを使う」という前提はこの経路でも守る
    if (!fresh?.access_token || !fresh.is_active) throw new Error('REAUTH_REQUIRED');
    return { accessToken: fresh.access_token, companyId: fresh.company_id, connectionId: fresh.id };
  }

  return { accessToken: tokens.access_token, companyId: conn.company_id, connectionId: conn.id };
}

/**
 * freee会計の事業所一覧から、指定 company_id の表示名を取得する。
 *
 * 管理画面で「自分の事業所」と「第三者の事業所」を見分けるための表示用。
 * **ベストエフォート**：取得できなくても連携自体は成功させる
 * （アプリのスコープが会計APIを含まない場合など。その場合は company_id で見分ける）。
 *
 * @returns 表示名。取得できなければ null
 */
export async function fetchFreeeCompanyName(
  accessToken: string,
  companyId: number,
): Promise<string | null> {
  try {
    const res = await fetch('https://api.freee.co.jp/api/1/companies', {
      headers: { Authorization: `Bearer ${accessToken}` },
      // ベストエフォートなのにハングすると、認可コードを消費したまま
      // 1件も保存されずにコールバックが終わってしまう。必ず打ち切る。
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.warn(`[freee] 事業所名の取得に失敗 (${res.status}) — company_id で表示します`);
      return null;
    }
    const body = await res.json<{ companies?: Array<{ id?: number; name?: string; display_name?: string }> }>();
    const hit = body.companies?.find((co) => co.id === companyId);
    return hit?.display_name ?? hit?.name ?? null;
  } catch (err) {
    console.warn('[freee] 事業所名の取得に失敗しました:', err);
    return null;
  }
}
