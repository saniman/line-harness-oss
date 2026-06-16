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

/** When line_accounts is empty, mirror wrangler env credentials into a default row. */
export async function ensureDefaultLineAccount(
  db: D1Database,
  env: DefaultLineAccountEnv,
): Promise<void> {
  const accounts = await getLineAccounts(db);
  if (accounts.length > 0) return;

  const channelId = env.LINE_CHANNEL_ID?.trim();
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
