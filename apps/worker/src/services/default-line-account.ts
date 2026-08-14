import { getLineAccounts, upsertDefaultLineAccountFromEnv } from '@line-crm/db';

type DefaultLineAccountEnv = {
  LINE_CHANNEL_ID?: string;
  LINE_CHANNEL_ACCESS_TOKEN?: string;
  LINE_CHANNEL_SECRET?: string;
  LINE_LOGIN_CHANNEL_ID?: string;
  LINE_LOGIN_CHANNEL_SECRET?: string;
  LIFF_BASE_URL?: string;
};

function parseLiffId(liffBaseUrl?: string): string | null {
  if (!liffBaseUrl) return null;
  const match = liffBaseUrl.match(/liff\.line\.me\/([^/?#]+)/);
  return match?.[1] ?? null;
}

/** Resolve Messaging API channel id without requiring LINE_CHANNEL_ID secret. */
export function resolveChannelIdForEnv(env: DefaultLineAccountEnv): string | null {
  const explicit = env.LINE_CHANNEL_ID?.trim();
  if (explicit) return explicit;

  const liffId = parseLiffId(env.LIFF_BASE_URL);
  if (liffId) {
    const prefix = liffId.split('-')[0]?.trim();
    if (prefix) return prefix;
  }

  // Token + secret exist but channel id unknown — use stable placeholder.
  if (env.LINE_CHANNEL_ACCESS_TOKEN?.trim() && env.LINE_CHANNEL_SECRET?.trim()) {
    return 'env-default';
  }
  return null;
}

/**
 * 既定の LINE アカウント ID を解決する。
 *
 * webhook は destination から line_account_id を解決できるが（routes/webhook.ts:220-224）、
 * 管理画面のバックフィルや LIFF 申込の救済 upsert にはその文脈が無い。
 * env のチャネル ID と一致する行を優先し、無ければ「アクティブが1件だけ」のときのみそれを使う。
 * 判断できない場合は null を返す（誤ったアカウントに紐づけるより未設定のままが安全）。
 */
export async function resolveDefaultLineAccountId(
  db: D1Database,
  env: DefaultLineAccountEnv,
): Promise<string | null> {
  const accounts = await getLineAccounts(db);
  if (accounts.length === 0) return null;

  const channelId = resolveChannelIdForEnv(env);
  if (channelId) {
    // 無効化済みアカウントは選ばない（fallback 側と条件を揃える）
    const matched = accounts.find((a) => a.channel_id === channelId && a.is_active !== 0);
    if (matched) return matched.id;
  }

  const active = accounts.filter((a) => a.is_active !== 0);
  return active.length === 1 ? active[0].id : null;
}

/** When line_accounts is empty, mirror wrangler env credentials into a default row. */
export async function ensureDefaultLineAccount(
  db: D1Database,
  env: DefaultLineAccountEnv,
): Promise<void> {
  const accounts = await getLineAccounts(db);
  if (accounts.length > 0) return;

  const channelId = resolveChannelIdForEnv(env);
  const channelAccessToken = env.LINE_CHANNEL_ACCESS_TOKEN?.trim();
  const channelSecret = env.LINE_CHANNEL_SECRET?.trim();
  if (!channelId || !channelAccessToken || !channelSecret) return;

  await upsertDefaultLineAccountFromEnv(db, {
    channelId,
    name: 'Default',
    channelAccessToken,
    channelSecret,
    loginChannelId: env.LINE_LOGIN_CHANNEL_ID ?? null,
    loginChannelSecret: env.LINE_LOGIN_CHANNEL_SECRET ?? null,
    liffId: parseLiffId(env.LIFF_BASE_URL),
  });
}
