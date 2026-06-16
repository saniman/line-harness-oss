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
