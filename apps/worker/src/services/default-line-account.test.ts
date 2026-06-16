import { describe, expect, test, vi, beforeEach } from 'vitest';

const mockGetLineAccounts = vi.hoisted(() => vi.fn());
const mockUpsertDefaultLineAccountFromEnv = vi.hoisted(() => vi.fn());

vi.mock('@line-crm/db', () => ({
  getLineAccounts: mockGetLineAccounts,
  upsertDefaultLineAccountFromEnv: mockUpsertDefaultLineAccountFromEnv,
}));

import { ensureDefaultLineAccount } from './default-line-account.js';

const db = {} as D1Database;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ensureDefaultLineAccount', () => {
  test('does nothing when line_accounts already has rows', async () => {
    mockGetLineAccounts.mockResolvedValue([{ id: 'acc-1' }]);

    await ensureDefaultLineAccount(db, {
      LINE_CHANNEL_ID: '123',
      LINE_CHANNEL_ACCESS_TOKEN: 'token',
      LINE_CHANNEL_SECRET: 'secret',
    });

    expect(mockUpsertDefaultLineAccountFromEnv).not.toHaveBeenCalled();
  });

  test('bootstraps default row from env when table is empty', async () => {
    mockGetLineAccounts.mockResolvedValue([]);

    await ensureDefaultLineAccount(db, {
      LINE_CHANNEL_ID: '1661159603',
      LINE_CHANNEL_ACCESS_TOKEN: 'access-token',
      LINE_CHANNEL_SECRET: 'channel-secret',
      LINE_LOGIN_CHANNEL_ID: 'login-id',
      LIFF_BASE_URL: 'https://liff.line.me/1661159603-5qlDj5wV',
    });

    expect(mockUpsertDefaultLineAccountFromEnv).toHaveBeenCalledWith(db, {
      channelId: '1661159603',
      name: 'Default',
      channelAccessToken: 'access-token',
      channelSecret: 'channel-secret',
      loginChannelId: 'login-id',
      loginChannelSecret: null,
      liffId: '1661159603-5qlDj5wV',
    });
  });

  test('skips bootstrap when env credentials are missing', async () => {
    mockGetLineAccounts.mockResolvedValue([]);

    await ensureDefaultLineAccount(db, {});

    expect(mockUpsertDefaultLineAccountFromEnv).not.toHaveBeenCalled();
  });
});
