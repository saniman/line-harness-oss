import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ScenarioWithStepCount } from '@line-crm/db';

vi.mock('@line-crm/db', () => ({
  getScenarios: vi.fn(),
  enrollFriendInScenario: vi.fn(),
}));

import { getScenarios, enrollFriendInScenario } from '@line-crm/db';
import { enrollEventFollowupScenarios, enrollEventParticipants } from './event-followup.js';

const mockGetScenarios = vi.mocked(getScenarios);
const mockEnroll = vi.mocked(enrollFriendInScenario);

function makeStmt(firstResult: unknown = null, allResult: { results: unknown[] } = { results: [] }) {
  return {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue({ meta: {} }),
    first: vi.fn().mockResolvedValue(firstResult),
    all: vi.fn().mockResolvedValue(allResult),
  };
}

function makeDb(...stmts: ReturnType<typeof makeStmt>[]): D1Database {
  let i = 0;
  return { prepare: vi.fn().mockImplementation(() => stmts[i++] ?? makeStmt()) } as unknown as D1Database;
}

// イベント開催日時（開催日アンカーの起点）。JST 2026-06-13 14:00。
const EVENT_START = '2026-06-13T05:00:00.000Z';

function scenario(overrides: Partial<ScenarioWithStepCount>): ScenarioWithStepCount {
  return {
    id: 'sc-1',
    name: 'アフターフォロー',
    description: null,
    trigger_type: 'event_booking',
    trigger_tag_id: null,
    line_account_id: null,
    is_active: 1,
    step_count: 3,
    created_at: '2026-06-01T00:00:00+09:00',
    updated_at: '2026-06-01T00:00:00+09:00',
    ...overrides,
  };
}

// enrollFriendInScenario が返す FriendScenario の最小モック
const FRIEND_SCENARIO = {
  id: 'fs-1',
  friend_id: 'friend-1',
  scenario_id: 'sc-1',
  current_step_order: 0,
  status: 'active' as const,
  started_at: '2026-06-13T10:00:00+09:00',
  next_delivery_at: '2026-06-14T10:00:00+09:00',
  anchor_at: '2026-06-13T05:00:00.000Z',
  updated_at: '2026-06-13T10:00:00+09:00',
};

describe('enrollEventFollowupScenarios', () => {
  const db = {} as D1Database;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnroll.mockResolvedValue(FRIEND_SCENARIO);
  });

  it('friend_idがnullの場合は何もせず0を返す（getScenariosも呼ばない）', async () => {
    const count = await enrollEventFollowupScenarios(db, null, EVENT_START);
    expect(count).toBe(0);
    expect(mockGetScenarios).not.toHaveBeenCalled();
    expect(mockEnroll).not.toHaveBeenCalled();
  });

  it('event_bookingトリガーかつactiveなシナリオにenrollする', async () => {
    mockGetScenarios.mockResolvedValue([scenario({ id: 'sc-1' })]);
    const count = await enrollEventFollowupScenarios(db, 'friend-1', EVENT_START);
    expect(count).toBe(1);
    // eventStartAt が enrollFriendInScenario の第4引数(anchorAt)として渡る
    expect(mockEnroll).toHaveBeenCalledWith(db, 'friend-1', 'sc-1', EVENT_START);
  });

  it('event_booking以外のトリガーは対象外になる', async () => {
    mockGetScenarios.mockResolvedValue([
      scenario({ id: 'sc-1', trigger_type: 'friend_add' }),
      scenario({ id: 'sc-2', trigger_type: 'tag_added' }),
    ]);
    const count = await enrollEventFollowupScenarios(db, 'friend-1', EVENT_START);
    expect(count).toBe(0);
    expect(mockEnroll).not.toHaveBeenCalled();
  });

  it('非activeなシナリオは対象外になる', async () => {
    mockGetScenarios.mockResolvedValue([scenario({ id: 'sc-1', is_active: 0 })]);
    const count = await enrollEventFollowupScenarios(db, 'friend-1', EVENT_START);
    expect(count).toBe(0);
    expect(mockEnroll).not.toHaveBeenCalled();
  });

  it('line_account_idが一致しないシナリオは対象外になる', async () => {
    mockGetScenarios.mockResolvedValue([scenario({ id: 'sc-1', line_account_id: 'acc-A' })]);
    const count = await enrollEventFollowupScenarios(db, 'friend-1', EVENT_START, 'acc-B');
    expect(count).toBe(0);
    expect(mockEnroll).not.toHaveBeenCalled();
  });

  it('line_account_idが一致する場合はenrollする', async () => {
    mockGetScenarios.mockResolvedValue([scenario({ id: 'sc-1', line_account_id: 'acc-A' })]);
    const count = await enrollEventFollowupScenarios(db, 'friend-1', EVENT_START, 'acc-A');
    expect(count).toBe(1);
    expect(mockEnroll).toHaveBeenCalledWith(db, 'friend-1', 'sc-1', EVENT_START);
  });

  it('シナリオのline_account_idがnull（全アカウント共通）なら常に対象になる', async () => {
    mockGetScenarios.mockResolvedValue([scenario({ id: 'sc-1', line_account_id: null })]);
    const count = await enrollEventFollowupScenarios(db, 'friend-1', EVENT_START, 'acc-B');
    expect(count).toBe(1);
  });

  it('eventStartAtがnullでもenrollは行われる（相対遅延フォールバック）', async () => {
    mockGetScenarios.mockResolvedValue([scenario({ id: 'sc-1' })]);
    const count = await enrollEventFollowupScenarios(db, 'friend-1', null);
    expect(count).toBe(1);
    expect(mockEnroll).toHaveBeenCalledWith(db, 'friend-1', 'sc-1', null);
  });

  it('既に登録済み（enrollがnullを返す）の場合はカウントしない', async () => {
    mockGetScenarios.mockResolvedValue([
      scenario({ id: 'sc-1' }),
      scenario({ id: 'sc-2' }),
    ]);
    mockEnroll.mockResolvedValueOnce(null).mockResolvedValueOnce(FRIEND_SCENARIO);
    const count = await enrollEventFollowupScenarios(db, 'friend-1', EVENT_START);
    expect(count).toBe(1);
    expect(mockEnroll).toHaveBeenCalledTimes(2);
  });
});

describe('enrollEventParticipants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnroll.mockResolvedValue(FRIEND_SCENARIO);
  });

  it('イベントが存在しない場合は eventFound:false を返す', async () => {
    const db = makeDb(makeStmt(null)); // events SELECT → not found
    const res = await enrollEventParticipants(db, 999, 'sc-1');
    expect(res.eventFound).toBe(false);
    expect(res.enrolled).toBe(0);
    expect(res.total).toBe(0);
    expect(mockEnroll).not.toHaveBeenCalled();
  });

  it('確定参加者全員を開催日アンカー(start_at)でenrollする', async () => {
    const db = makeDb(
      makeStmt({ start_at: EVENT_START }), // events SELECT
      makeStmt(null, { results: [{ friend_id: 'f1' }, { friend_id: 'f2' }] }), // 参加者 SELECT DISTINCT
    );
    const res = await enrollEventParticipants(db, 2, 'sc-1');
    expect(res.eventFound).toBe(true);
    expect(res.total).toBe(2);
    expect(res.enrolled).toBe(2);
    expect(mockEnroll).toHaveBeenCalledWith(db, 'f1', 'sc-1', EVENT_START);
    expect(mockEnroll).toHaveBeenCalledWith(db, 'f2', 'sc-1', EVENT_START);
  });

  it('既に登録済み(enrollがnull)はenrolledに数えない', async () => {
    const db = makeDb(
      makeStmt({ start_at: EVENT_START }),
      makeStmt(null, { results: [{ friend_id: 'f1' }, { friend_id: 'f2' }] }),
    );
    mockEnroll.mockResolvedValueOnce(null).mockResolvedValueOnce(FRIEND_SCENARIO);
    const res = await enrollEventParticipants(db, 2, 'sc-1');
    expect(res.total).toBe(2);
    expect(res.enrolled).toBe(1);
  });

  it('確定参加者が0人なら total:0 enrolled:0', async () => {
    const db = makeDb(
      makeStmt({ start_at: EVENT_START }),
      makeStmt(null, { results: [] }),
    );
    const res = await enrollEventParticipants(db, 2, 'sc-1');
    expect(res.eventFound).toBe(true);
    expect(res.total).toBe(0);
    expect(res.enrolled).toBe(0);
    expect(mockEnroll).not.toHaveBeenCalled();
  });
});
