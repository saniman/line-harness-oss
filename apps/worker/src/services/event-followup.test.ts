import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ScenarioWithStepCount } from '@line-crm/db';

vi.mock('@line-crm/db', () => ({
  getScenarios: vi.fn(),
  enrollFriendInScenario: vi.fn(),
}));

import { getScenarios, enrollFriendInScenario } from '@line-crm/db';
import { enrollEventFollowupScenarios } from './event-followup.js';

const mockGetScenarios = vi.mocked(getScenarios);
const mockEnroll = vi.mocked(enrollFriendInScenario);

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
  updated_at: '2026-06-13T10:00:00+09:00',
};

describe('enrollEventFollowupScenarios', () => {
  const db = {} as D1Database;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnroll.mockResolvedValue(FRIEND_SCENARIO);
  });

  it('friend_idがnullの場合は何もせず0を返す（getScenariosも呼ばない）', async () => {
    const count = await enrollEventFollowupScenarios(db, null);
    expect(count).toBe(0);
    expect(mockGetScenarios).not.toHaveBeenCalled();
    expect(mockEnroll).not.toHaveBeenCalled();
  });

  it('event_bookingトリガーかつactiveなシナリオにenrollする', async () => {
    mockGetScenarios.mockResolvedValue([scenario({ id: 'sc-1' })]);
    const count = await enrollEventFollowupScenarios(db, 'friend-1');
    expect(count).toBe(1);
    expect(mockEnroll).toHaveBeenCalledWith(db, 'friend-1', 'sc-1');
  });

  it('event_booking以外のトリガーは対象外になる', async () => {
    mockGetScenarios.mockResolvedValue([
      scenario({ id: 'sc-1', trigger_type: 'friend_add' }),
      scenario({ id: 'sc-2', trigger_type: 'tag_added' }),
    ]);
    const count = await enrollEventFollowupScenarios(db, 'friend-1');
    expect(count).toBe(0);
    expect(mockEnroll).not.toHaveBeenCalled();
  });

  it('非activeなシナリオは対象外になる', async () => {
    mockGetScenarios.mockResolvedValue([scenario({ id: 'sc-1', is_active: 0 })]);
    const count = await enrollEventFollowupScenarios(db, 'friend-1');
    expect(count).toBe(0);
    expect(mockEnroll).not.toHaveBeenCalled();
  });

  it('line_account_idが一致しないシナリオは対象外になる', async () => {
    mockGetScenarios.mockResolvedValue([scenario({ id: 'sc-1', line_account_id: 'acc-A' })]);
    const count = await enrollEventFollowupScenarios(db, 'friend-1', 'acc-B');
    expect(count).toBe(0);
    expect(mockEnroll).not.toHaveBeenCalled();
  });

  it('line_account_idが一致する場合はenrollする', async () => {
    mockGetScenarios.mockResolvedValue([scenario({ id: 'sc-1', line_account_id: 'acc-A' })]);
    const count = await enrollEventFollowupScenarios(db, 'friend-1', 'acc-A');
    expect(count).toBe(1);
    expect(mockEnroll).toHaveBeenCalledWith(db, 'friend-1', 'sc-1');
  });

  it('シナリオのline_account_idがnull（全アカウント共通）なら常に対象になる', async () => {
    mockGetScenarios.mockResolvedValue([scenario({ id: 'sc-1', line_account_id: null })]);
    const count = await enrollEventFollowupScenarios(db, 'friend-1', 'acc-B');
    expect(count).toBe(1);
  });

  it('既に登録済み（enrollがnullを返す）の場合はカウントしない', async () => {
    mockGetScenarios.mockResolvedValue([
      scenario({ id: 'sc-1' }),
      scenario({ id: 'sc-2' }),
    ]);
    mockEnroll.mockResolvedValueOnce(null).mockResolvedValueOnce(FRIEND_SCENARIO);
    const count = await enrollEventFollowupScenarios(db, 'friend-1');
    expect(count).toBe(1);
    expect(mockEnroll).toHaveBeenCalledTimes(2);
  });
});
