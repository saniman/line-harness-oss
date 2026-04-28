import { jstNow } from '@line-crm/db';
import { getValidAccessToken, GoogleCalendarClient } from './google-calendar.js';
import type { Env } from '../index.js';

interface BookingRow {
  id: string;
  status: string;
  event_id: string | null;
  connection_id: string | null;
  friend_id: string;
  start_at: string;
  end_at: string;
}

export async function cancelBooking(
  db: D1Database,
  bookingId: string,
  friendId: string,
  env?: Env['Bindings'],
): Promise<{ success: boolean; error?: string }> {
  const booking = await db
    .prepare('SELECT * FROM calendar_bookings WHERE id = ?')
    .bind(bookingId)
    .first<BookingRow>();

  if (!booking) {
    return { success: false, error: '予約が見つかりませんでした。' };
  }

  // friend_id が設定されている場合のみ所有者チェック
  if (booking.friend_id !== null && booking.friend_id !== friendId) {
    return { success: false, error: '予約が見つかりませんでした。' };
  }
  if (booking.status === 'cancelled') {
    return { success: false, error: 'すでにキャンセル済みです。' };
  }

  await db
    .prepare("UPDATE calendar_bookings SET status = 'cancelled', updated_at = ? WHERE id = ?")
    .bind(jstNow(), bookingId)
    .run();

  // Google Calendar削除（ベストエフォート）
  if (booking.event_id && booking.connection_id && env) {
    try {
      const conn = await db
        .prepare('SELECT calendar_id FROM google_calendar_connections WHERE id = ?')
        .bind(booking.connection_id)
        .first<{ calendar_id: string }>();
      const accessToken = await getValidAccessToken(env, db, booking.connection_id);
      const gcal = new GoogleCalendarClient({
        calendarId: conn?.calendar_id ?? 'primary',
        accessToken,
      });
      await gcal.deleteEvent(booking.event_id);
    } catch (err) {
      console.error('[cancelBooking] Google Calendar deleteEvent failed:', err);
    }
  }

  // リマインダー停止（ベストエフォート）
  try {
    const reminders = await db
      .prepare("SELECT id FROM reminders WHERE description LIKE ?")
      .bind(`booking_id:${bookingId}%`)
      .all<{ id: string }>();

    for (const reminder of reminders.results) {
      await db
        .prepare("UPDATE friend_reminders SET status = 'cancelled', updated_at = ? WHERE reminder_id = ? AND status = 'active'")
        .bind(jstNow(), reminder.id)
        .run();
    }
  } catch (err) {
    console.error('[cancelBooking] Reminder cancellation failed:', err);
  }

  return { success: true };
}
