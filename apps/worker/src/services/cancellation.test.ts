import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cancelBooking } from './cancellation.js';

vi.mock('./google-calendar.js', () => ({
  getValidAccessToken: vi.fn().mockResolvedValue('mock-token'),
  GoogleCalendarClient: vi.fn().mockImplementation(() => ({
    deleteEvent: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { GoogleCalendarClient } from './google-calendar.js';

const BASE_BOOKING = {
  id: 'booking-1',
  status: 'confirmed',
  event_id: null as string | null,
  connection_id: null as string | null,
  friend_id: 'friend-1',
  start_at: '2026-05-01T10:00:00+09:00',
  end_at: '2026-05-01T11:00:00+09:00',
};

function makeStmt(firstVal: unknown, allVal = { results: [] as unknown[] }) {
  return {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(firstVal),
    run: vi.fn().mockResolvedValue({}),
    all: vi.fn().mockResolvedValue(allVal),
  };
}

function makeDb(...stmts: ReturnType<typeof makeStmt>[]) {
  const prepare = vi.fn();
  stmts.forEach((s) => prepare.mockReturnValueOnce(s));
  return { prepare } as unknown as D1Database;
}

beforeEach(() => { vi.clearAllMocks(); });

describe('キャンセル処理', () => {
  describe('予約のキャンセル', () => {
    it('D1のcalendar_bookingsのstatusがcancelledになる', async () => {
      const updateStmt = makeStmt(null);
      const db = makeDb(
        makeStmt(BASE_BOOKING),   // SELECT booking
        updateStmt,               // UPDATE calendar_bookings
        makeStmt(null, { results: [] }), // SELECT reminders
      );

      const result = await cancelBooking(db, 'booking-1', 'friend-1');

      expect(result.success).toBe(true);
      expect(db.prepare).toHaveBeenCalledWith(
        expect.stringContaining("status = 'cancelled'"),
      );
      expect(updateStmt.run).toHaveBeenCalled();
    });

    it('存在しない予約IDはエラーになる', async () => {
      const db = makeDb(makeStmt(null));

      const result = await cancelBooking(db, 'nonexistent', 'friend-1');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('すでにキャンセル済みの予約は二重キャンセルできない', async () => {
      const db = makeDb(makeStmt({ ...BASE_BOOKING, status: 'cancelled' }));

      const result = await cancelBooking(db, 'booking-1', 'friend-1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('キャンセル済み');
    });
  });

  describe('Google Calendarイベントの削除', () => {
    const ENV = {} as Parameters<typeof cancelBooking>[3];

    it('eventIdがある場合はGoogle Calendarから削除される', async () => {
      const booking = { ...BASE_BOOKING, event_id: 'evt-1', connection_id: 'conn-1' };
      const db = makeDb(
        makeStmt(booking),                          // SELECT booking
        makeStmt(null),                             // UPDATE calendar_bookings
        makeStmt({ calendar_id: 'cal-1' }),         // SELECT google_calendar_connections
        makeStmt(null, { results: [] }),             // SELECT reminders
      );

      await cancelBooking(db, 'booking-1', 'friend-1', ENV);

      const mockInstance = vi.mocked(GoogleCalendarClient).mock.results[0].value;
      expect(mockInstance.deleteEvent).toHaveBeenCalledWith('evt-1');
    });

    it('eventIdがない場合はスキップされる', async () => {
      const db = makeDb(
        makeStmt(BASE_BOOKING), // event_id=null
        makeStmt(null),
        makeStmt(null, { results: [] }),
      );

      const result = await cancelBooking(db, 'booking-1', 'friend-1', ENV);

      expect(result.success).toBe(true);
      expect(GoogleCalendarClient).not.toHaveBeenCalled();
    });

    it('Google Calendar削除失敗でもD1のキャンセルは成功する', async () => {
      vi.mocked(GoogleCalendarClient).mockImplementationOnce(() => ({
        deleteEvent: vi.fn().mockRejectedValue(new Error('gcal error')),
      } as never));

      const booking = { ...BASE_BOOKING, event_id: 'evt-1', connection_id: 'conn-1' };
      const db = makeDb(
        makeStmt(booking),
        makeStmt(null),
        makeStmt({ calendar_id: 'cal-1' }),
        makeStmt(null, { results: [] }),
      );

      const result = await cancelBooking(db, 'booking-1', 'friend-1', ENV);

      expect(result.success).toBe(true);
    });
  });

  describe('リマインダーの停止', () => {
    it('関連するリマインダーのstatusがcancelledになる', async () => {
      const reminderUpdateStmt = makeStmt(null);
      const db = makeDb(
        makeStmt(BASE_BOOKING),                                       // SELECT booking
        makeStmt(null),                                               // UPDATE calendar_bookings
        makeStmt(null, { results: [{ id: 'reminder-1' }] }),          // SELECT reminders
        reminderUpdateStmt,                                           // UPDATE friend_reminders
      );

      await cancelBooking(db, 'booking-1', 'friend-1');

      expect(reminderUpdateStmt.run).toHaveBeenCalled();
      expect(db.prepare).toHaveBeenCalledWith(
        expect.stringContaining("friend_reminders"),
      );
    });

    it('リマインダーがない場合はスキップされる', async () => {
      const db = makeDb(
        makeStmt(BASE_BOOKING),
        makeStmt(null),
        makeStmt(null, { results: [] }), // リマインダー0件
      );

      const result = await cancelBooking(db, 'booking-1', 'friend-1');

      expect(result.success).toBe(true);
      // prepare呼び出し回数は3回（reminder UPDATEは呼ばれない）
      expect(db.prepare).toHaveBeenCalledTimes(3);
    });

    it('複数のリマインダー（前日・当日）が全て停止される', async () => {
      const updateStmt1 = makeStmt(null);
      const updateStmt2 = makeStmt(null);
      const db = makeDb(
        makeStmt(BASE_BOOKING),                                                         // SELECT booking
        makeStmt(null),                                                                 // UPDATE calendar_bookings
        makeStmt(null, { results: [{ id: 'reminder-day-before' }, { id: 'reminder-same-day' }] }), // SELECT reminders（2件）
        updateStmt1,                                                                    // UPDATE friend_reminders（1件目）
        updateStmt2,                                                                    // UPDATE friend_reminders（2件目）
      );

      const result = await cancelBooking(db, 'booking-1', 'friend-1');

      expect(result.success).toBe(true);
      expect(updateStmt1.run).toHaveBeenCalled();
      expect(updateStmt2.run).toHaveBeenCalled();
    });
  });
});

describe('予約→キャンセルの統合シナリオ', () => {
  it('キャンセル後はリマインダーのUPDATEが全件分呼ばれる', async () => {
    const updateBookingStmt = makeStmt(null);
    const updateReminder1 = makeStmt(null);
    const updateReminder2 = makeStmt(null);
    const db = makeDb(
      makeStmt(BASE_BOOKING),
      updateBookingStmt,
      makeStmt(null, { results: [{ id: 'r-1' }, { id: 'r-2' }] }),
      updateReminder1,
      updateReminder2,
    );

    const result = await cancelBooking(db, 'booking-1', 'friend-1');

    expect(result.success).toBe(true);
    // calendar_bookings が cancelled に更新される
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining("status = 'cancelled'"));
    // friend_reminders が 2件分 UPDATE される
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining("friend_reminders"));
    expect(updateReminder1.run).toHaveBeenCalled();
    expect(updateReminder2.run).toHaveBeenCalled();
  });
});
