import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAutoTrackContent = vi.fn();

vi.mock('./auto-track.js', () => ({
  autoTrackContent: (...args: unknown[]) => mockAutoTrackContent(...args),
}));

const dbMocks = {
  getBroadcastById: vi.fn(),
  getBroadcasts: vi.fn(),
  getQueuedBroadcasts: vi.fn(),
  updateBroadcastStatus: vi.fn(),
  updateBroadcastBatchProgress: vi.fn(),
  getFriendsByTag: vi.fn(),
  jstNow: () => '2026-07-27T00:00:00.000Z',
  updateBroadcastLineRequestId: vi.fn(),
  createBroadcastInsight: vi.fn(),
  getLineAccountById: vi.fn(),
  getFollowingFriendCount: vi.fn(),
};

vi.mock('@line-crm/db', () => dbMocks);

const { processBroadcastSend } = await import('./broadcast.js');

const WORKER_URL = 'https://api.example.com';
const CONTENT = 'キャンペーン中です https://example.com/campaign';

function makeBroadcast(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bc-1',
    title: 'テスト配信',
    message_type: 'text',
    message_content: CONTENT,
    target_type: 'all',
    target_tag_id: null,
    status: 'draft',
    scheduled_at: null,
    sent_at: null,
    total_count: 0,
    success_count: 0,
    track_links: 1,
    created_at: '2026-07-27T00:00:00.000Z',
    ...overrides,
  };
}

const db = {
  prepare: vi.fn(() => ({
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
    first: vi.fn().mockResolvedValue(null),
  })),
  batch: vi.fn().mockResolvedValue([]),
} as unknown as D1Database;

function makeLineClient() {
  return {
    broadcast: vi.fn().mockResolvedValue({ requestId: 'req-1' }),
    multicast: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAutoTrackContent.mockResolvedValue({
    messageType: 'text',
    content: `キャンペーン中です ${WORKER_URL}/t/Ab3xY9k`,
  });
  dbMocks.getFollowingFriendCount.mockResolvedValue(0);
});

describe('processBroadcastSend の track_links 制御', () => {
  it('track_links=1 の場合は URL がトラッキングリンクに変換される', async () => {
    dbMocks.getBroadcastById.mockResolvedValue(makeBroadcast({ track_links: 1 }));
    const lineClient = makeLineClient();

    await processBroadcastSend(db, lineClient as never, 'bc-1', WORKER_URL);

    expect(mockAutoTrackContent).toHaveBeenCalledTimes(1);
    expect(lineClient.broadcast).toHaveBeenCalledWith([
      expect.objectContaining({ text: `キャンペーン中です ${WORKER_URL}/t/Ab3xY9k` }),
    ]);
  });

  it('track_links=0 の場合は auto-track を呼ばず本文をそのまま送る', async () => {
    dbMocks.getBroadcastById.mockResolvedValue(makeBroadcast({ track_links: 0 }));
    const lineClient = makeLineClient();

    await processBroadcastSend(db, lineClient as never, 'bc-1', WORKER_URL);

    expect(mockAutoTrackContent).not.toHaveBeenCalled();
    expect(lineClient.broadcast).toHaveBeenCalledWith([
      expect.objectContaining({ text: CONTENT }),
    ]);
  });

  it('track_links が未設定（旧レコード）の場合は従来どおり変換する', async () => {
    dbMocks.getBroadcastById.mockResolvedValue(makeBroadcast({ track_links: undefined }));
    const lineClient = makeLineClient();

    await processBroadcastSend(db, lineClient as never, 'bc-1', WORKER_URL);

    expect(mockAutoTrackContent).toHaveBeenCalledTimes(1);
  });

  it('workerUrl が無い場合は track_links に関わらず変換しない', async () => {
    dbMocks.getBroadcastById.mockResolvedValue(makeBroadcast({ track_links: 1 }));
    const lineClient = makeLineClient();

    await processBroadcastSend(db, lineClient as never, 'bc-1', undefined);

    expect(mockAutoTrackContent).not.toHaveBeenCalled();
  });
});

describe('processBroadcastSend の配信実績カウント', () => {
  it('全員配信の場合はフォロー中の友だち数が配信実績として記録される', async () => {
    dbMocks.getBroadcastById.mockResolvedValue(makeBroadcast({ target_type: 'all' }));
    dbMocks.getFollowingFriendCount.mockResolvedValue(42);
    const lineClient = makeLineClient();

    await processBroadcastSend(db, lineClient as never, 'bc-1', WORKER_URL);

    expect(dbMocks.getFollowingFriendCount).toHaveBeenCalledWith(db);
    expect(dbMocks.updateBroadcastStatus).toHaveBeenCalledWith(db, 'bc-1', 'sent', {
      totalCount: 42,
      successCount: 42,
    });
  });

  it('フォロー中の友だちが0人の場合は 0 が記録される', async () => {
    dbMocks.getBroadcastById.mockResolvedValue(makeBroadcast({ target_type: 'all' }));
    dbMocks.getFollowingFriendCount.mockResolvedValue(0);
    const lineClient = makeLineClient();

    await processBroadcastSend(db, lineClient as never, 'bc-1', WORKER_URL);

    expect(dbMocks.updateBroadcastStatus).toHaveBeenCalledWith(db, 'bc-1', 'sent', {
      totalCount: 0,
      successCount: 0,
    });
  });

  it('タグ配信の場合はフォロー中の友だち総数ではなく対象タグの人数が記録される', async () => {
    dbMocks.getBroadcastById.mockResolvedValue(
      makeBroadcast({ target_type: 'tag', target_tag_id: 'tag-1', track_links: 0 }),
    );
    dbMocks.getFollowingFriendCount.mockResolvedValue(42);
    dbMocks.getFriendsByTag.mockResolvedValue([
      { id: 'f-1', line_user_id: 'U1', is_following: 1 },
      { id: 'f-2', line_user_id: 'U2', is_following: 1 },
      { id: 'f-3', line_user_id: 'U3', is_following: 0 },
    ]);
    const lineClient = makeLineClient();

    await processBroadcastSend(db, lineClient as never, 'bc-1', WORKER_URL);

    expect(dbMocks.getFollowingFriendCount).not.toHaveBeenCalled();
    expect(dbMocks.updateBroadcastStatus).toHaveBeenCalledWith(db, 'bc-1', 'sent', {
      totalCount: 2,
      successCount: 2,
    });
  });
});
