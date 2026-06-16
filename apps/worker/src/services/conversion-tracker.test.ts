import { describe, expect, test, vi, beforeEach } from 'vitest';

const mockGetConversionPointsByEventType = vi.hoisted(() => vi.fn());
const mockTrackConversion = vi.hoisted(() => vi.fn());

vi.mock('@line-crm/db', () => ({
  getConversionPointsByEventType: mockGetConversionPointsByEventType,
  trackConversion: mockTrackConversion,
}));

import {
  resolveConversionEventTypes,
  trackConversionsForEvent,
} from './conversion-tracker.js';

const db = {} as D1Database;

beforeEach(() => {
  vi.clearAllMocks();
  mockTrackConversion.mockResolvedValue({ id: 'evt-1' });
});

describe('resolveConversionEventTypes', () => {
  test('returns the event type itself', () => {
    expect(resolveConversionEventTypes('friend_add')).toEqual(['friend_add']);
  });

  test('maps cv_fire to purchase alias', () => {
    const types = resolveConversionEventTypes('cv_fire');
    expect(types).toContain('cv_fire');
    expect(types).toContain('purchase');
  });
});

describe('trackConversionsForEvent', () => {
  test('does nothing without friendId', async () => {
    await trackConversionsForEvent(db, 'friend_add', {});
    expect(mockGetConversionPointsByEventType).not.toHaveBeenCalled();
  });

  test('tracks all conversion points matching the event type', async () => {
    mockGetConversionPointsByEventType.mockResolvedValue([
      { id: 'cp-friend', name: '友だち追加', event_type: 'friend_add', value: null, created_at: '' },
    ]);

    await trackConversionsForEvent(db, 'friend_add', {
      friendId: 'friend-1',
      eventData: { displayName: '太郎' },
    });

    expect(mockGetConversionPointsByEventType).toHaveBeenCalledWith(db, 'friend_add');
    expect(mockTrackConversion).toHaveBeenCalledWith(db, {
      conversionPointId: 'cp-friend',
      friendId: 'friend-1',
      metadata: JSON.stringify({ displayName: '太郎' }),
    });
  });

  test('tracks purchase points when cv_fire fires', async () => {
    mockGetConversionPointsByEventType.mockImplementation(async (_db, eventType: string) => {
      if (eventType === 'purchase') {
        return [{ id: 'cp-purchase', name: '購入', event_type: 'purchase', value: 5000, created_at: '' }];
      }
      return [];
    });

    await trackConversionsForEvent(db, 'cv_fire', {
      friendId: 'friend-1',
      eventData: { type: 'purchase', amount: 5000 },
    });

    expect(mockTrackConversion).toHaveBeenCalledWith(db, {
      conversionPointId: 'cp-purchase',
      friendId: 'friend-1',
      metadata: JSON.stringify({ type: 'purchase', amount: 5000 }),
    });
  });

  test('deduplicates when multiple aliases resolve to the same point', async () => {
    mockGetConversionPointsByEventType.mockResolvedValue([
      { id: 'cp-1', name: 'A', event_type: 'custom', value: null, created_at: '' },
    ]);

    await trackConversionsForEvent(db, 'custom', { friendId: 'f1' });

    expect(mockTrackConversion).toHaveBeenCalledTimes(1);
  });
});
