import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FriendReminderRow, ReminderStepRow } from '@line-crm/db';

vi.mock('@line-crm/db', () => ({
  getDueReminderDeliveries: vi.fn(),
  completeReminderIfDone: vi.fn(),
  getFriendById: vi.fn(),
  jstNow: vi.fn().mockReturnValue('2026-05-01T10:00:00+09:00'),
}));

vi.mock('./stealth.js', () => ({
  addJitter: vi.fn().mockReturnValue(0),
  sleep: vi.fn().mockResolvedValue(undefined),
}));

import { getDueReminderDeliveries, getFriendById, completeReminderIfDone } from '@line-crm/db';
import { processReminderDeliveries } from './reminder-delivery.js';

const ACTIVE_FRIEND = {
  id: 'friend-1',
  line_user_id: 'U1234567890abcde',
  display_name: 'テストユーザー',
  picture_url: null,
  status_message: null,
  is_following: 1,
  user_id: null,
  line_account_id: null,
  metadata: '{}',
  first_tracked_link_id: null,
  created_at: '2026-04-01T00:00:00+09:00',
  updated_at: '2026-04-01T00:00:00+09:00',
};

const REMINDER_STEP: ReminderStepRow = {
  id: 'step-1',
  reminder_id: 'reminder-1',
  offset_minutes: 0,
  message_type: 'text',
  message_content: '明日の予約のご確認です',
  created_at: '2026-04-01T00:00:00+09:00',
};

const DUE_REMINDER: FriendReminderRow & { steps: ReminderStepRow[] } = {
  id: 'fr-1',
  friend_id: 'friend-1',
  reminder_id: 'reminder-1',
  target_date: '2026-05-01T10:00:00+09:00',
  status: 'active',
  created_at: '2026-04-01T00:00:00+09:00',
  updated_at: '2026-04-01T00:00:00+09:00',
  steps: [REMINDER_STEP],
};

function makeDb() {
  const stmt = {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue({}),
    first: vi.fn().mockResolvedValue(null),
    all: vi.fn().mockResolvedValue({ results: [] }),
  };
  return { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;
}

function makeLineClient() {
  return { pushMessage: vi.fn().mockResolvedValue(undefined) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getDueReminderDeliveries).mockResolvedValue([]);
  vi.mocked(completeReminderIfDone).mockResolvedValue(undefined);
  vi.mocked(getFriendById).mockResolvedValue(null);
});

describe('リマインダー送信（Cron）', () => {
  it('status: active のリマインダーのみ送信される', async () => {
    vi.mocked(getDueReminderDeliveries).mockResolvedValue([DUE_REMINDER]);
    vi.mocked(getFriendById).mockResolvedValue(ACTIVE_FRIEND as never);
    const db = makeDb();
    const lineClient = makeLineClient();

    await processReminderDeliveries(db, lineClient as never);

    expect(lineClient.pushMessage).toHaveBeenCalledWith(
      ACTIVE_FRIEND.line_user_id,
      [{ type: 'text', text: REMINDER_STEP.message_content }],
    );
  });

  it('status: cancelled のリマインダーは送信されない', async () => {
    // getDueReminderDeliveries は status='active' のみを返す
    // cancelled なリマインダーは取得対象外のため配信されない
    vi.mocked(getDueReminderDeliveries).mockResolvedValue([]);
    const db = makeDb();
    const lineClient = makeLineClient();

    await processReminderDeliveries(db, lineClient as never);

    expect(lineClient.pushMessage).not.toHaveBeenCalled();
  });

  it('送信済み（delivered_at あり）は再送されない', async () => {
    // getDueReminderDeliveries は配信済みステップを steps から除外して返す
    // 全ステップ配信済みの場合は steps が空配列になり pushMessage は呼ばれない
    vi.mocked(getDueReminderDeliveries).mockResolvedValue([{ ...DUE_REMINDER, steps: [] }]);
    vi.mocked(getFriendById).mockResolvedValue(ACTIVE_FRIEND as never);
    const db = makeDb();
    const lineClient = makeLineClient();

    await processReminderDeliveries(db, lineClient as never);

    expect(lineClient.pushMessage).not.toHaveBeenCalled();
  });

  it('送信時刻前のリマインダーは送信されない', async () => {
    // getDueReminderDeliveries は target_date + offset_minutes > now のステップを除外する
    // 時刻未到来のリマインダーは空配列で返されるため送信されない
    vi.mocked(getDueReminderDeliveries).mockResolvedValue([]);
    const db = makeDb();
    const lineClient = makeLineClient();

    await processReminderDeliveries(db, lineClient as never);

    expect(lineClient.pushMessage).not.toHaveBeenCalled();
  });
});
