import { Hono } from 'hono';
import {
  getCalendarConnections,
  getCalendarConnectionById,
  createCalendarConnection,
  deleteCalendarConnection,
  getCalendarBookings,
  getCalendarBookingById,
  createCalendarBooking,
  updateCalendarBookingStatus,
  updateCalendarBookingEventId,
  getBookingsInRange,
  toJstString,
  createReminder,
  updateReminder,
  createReminderStep,
  enrollFriendInReminder,
} from '@line-crm/db';
import {
  GoogleCalendarClient,
  getGoogleAuthUrl,
  exchangeCodeForTokens,
  getValidAccessToken,
} from '../services/google-calendar.js';
import type { Env } from '../index.js';

export function validateBookingRequest(body: {
  connectionId?: string;
  title?: string;
  startAt?: string;
  endAt?: string;
}): string | null {
  if (!body.connectionId) return 'connectionId is required';
  if (!body.title) return 'title is required';
  if (!body.startAt || !body.endAt) return 'startAt and endAt are required';
  if (new Date(body.startAt) >= new Date(body.endAt)) return 'startAt must be before endAt';
  return null;
}

const calendar = new Hono<Env>();

// ========== OAuth ==========

calendar.get('/api/integrations/google-calendar/auth', async (c) => {
  try {
    const state = crypto.randomUUID();
    const url = getGoogleAuthUrl(c.env, state);
    return c.json({ success: true, data: { url } });
  } catch (err) {
    console.error('GET /api/integrations/google-calendar/auth error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

calendar.get('/api/integrations/google-calendar/callback', async (c) => {
  const code = c.req.query('code');
  const error = c.req.query('error');

  if (error || !code) {
    return c.html(`<h1>認証失敗</h1><p>${error ?? 'codeが取得できませんでした'}</p>`, 400);
  }

  try {
    const tokens = await exchangeCodeForTokens(c.env, code);
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
    const id = crypto.randomUUID();

    await c.env.DB.prepare(`
      INSERT INTO google_calendar_connections
        (id, calendar_id, auth_type, access_token, refresh_token, token_expires_at, created_at, updated_at)
      VALUES (?, 'primary', 'oauth', ?, ?, ?, datetime('now'), datetime('now'))
    `).bind(id, tokens.access_token, tokens.refresh_token, expiresAt).run();

    return c.html(`
      <html><body style="font-family:sans-serif;padding:32px">
        <h1>✅ Google Calendar 連携完了</h1>
        <p>接続ID: <code style="background:#f0f0f0;padding:4px 8px;border-radius:4px">${id}</code></p>
        <p>このIDを管理画面の設定に保存してください。</p>
      </body></html>
    `);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.html(`<h1>エラー</h1><p>${message}</p>`, 500);
  }
});

// ========== 接続管理 ==========

calendar.get('/api/integrations/google-calendar', async (c) => {
  try {
    const items = await getCalendarConnections(c.env.DB);
    return c.json({
      success: true,
      data: items.map((conn) => ({
        id: conn.id,
        calendarId: conn.calendar_id,
        authType: conn.auth_type,
        isActive: Boolean(conn.is_active),
        createdAt: conn.created_at,
        updatedAt: conn.updated_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/integrations/google-calendar error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

calendar.post('/api/integrations/google-calendar/connect', async (c) => {
  try {
    const body = await c.req.json<{ calendarId: string; authType: string; accessToken?: string; refreshToken?: string; apiKey?: string }>();
    if (!body.calendarId) return c.json({ success: false, error: 'calendarId is required' }, 400);
    const conn = await createCalendarConnection(c.env.DB, body);
    return c.json({
      success: true,
      data: { id: conn.id, calendarId: conn.calendar_id, authType: conn.auth_type, isActive: Boolean(conn.is_active), createdAt: conn.created_at },
    }, 201);
  } catch (err) {
    console.error('POST /api/integrations/google-calendar/connect error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

calendar.delete('/api/integrations/google-calendar/:id', async (c) => {
  try {
    await deleteCalendarConnection(c.env.DB, c.req.param('id'));
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/integrations/google-calendar/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== 空きスロット取得 ==========

calendar.get('/api/integrations/google-calendar/slots', async (c) => {
  try {
    const connectionId = c.req.query('connectionId');
    const date = c.req.query('date'); // YYYY-MM-DD
    const slotMinutes = Number(c.req.query('slotMinutes') ?? '60');
    const startHour = Number(c.req.query('startHour') ?? '9');
    const endHour = Number(c.req.query('endHour') ?? '18');

    if (!connectionId || !date) {
      return c.json({ success: false, error: 'connectionId and date are required' }, 400);
    }

    const conn = await getCalendarConnectionById(c.env.DB, connectionId);
    if (!conn) {
      return c.json({ success: false, error: 'Calendar connection not found' }, 404);
    }

    const dayStart = `${date}T${String(startHour).padStart(2, '0')}:00:00`;
    const dayEnd = `${date}T${String(endHour).padStart(2, '0')}:00:00`;

    // 既存D1予約を取得
    const bookings = await getBookingsInRange(c.env.DB, connectionId, dayStart, dayEnd);

    // Google FreeBusy API から busy 区間を取得（access_token がある場合のみ）
    let googleBusyIntervals: { start: string; end: string }[] = [];
    if (conn.access_token) {
      try {
        const gcal = new GoogleCalendarClient({
          calendarId: conn.calendar_id,
          accessToken: conn.access_token,
        });
        // タイムゾーンオフセットを付けて ISO 形式で渡す（Asia/Tokyo = +09:00）
        const timeMin = `${date}T${String(startHour).padStart(2, '0')}:00:00+09:00`;
        const timeMax = `${date}T${String(endHour).padStart(2, '0')}:00:00+09:00`;
        googleBusyIntervals = await gcal.getFreeBusy(timeMin, timeMax);
      } catch (err) {
        // Google API 失敗はベストエフォート — D1 のみでフォールバック
        console.warn('Google FreeBusy API error (falling back to D1 only):', err);
      }
    }

    // スロットを生成して空きを計算
    const slots: { startAt: string; endAt: string; available: boolean }[] = [];
    const baseDate = new Date(`${date}T${String(startHour).padStart(2, '0')}:00:00+09:00`);

    for (let h = startHour; h < endHour; h += slotMinutes / 60) {
      const slotStart = new Date(baseDate);
      slotStart.setMinutes(slotStart.getMinutes() + (h - startHour) * 60);
      const slotEnd = new Date(slotStart);
      slotEnd.setMinutes(slotEnd.getMinutes() + slotMinutes);

      const startStr = toJstString(slotStart);
      const endStr = toJstString(slotEnd);

      // D1 予約との重複チェック
      const isBookedInD1 = bookings.some((b) => {
        const bStart = new Date(b.start_at).getTime();
        const bEnd = new Date(b.end_at).getTime();
        return slotStart.getTime() < bEnd && slotEnd.getTime() > bStart;
      });

      // Google busy 区間との重複チェック
      const isBookedInGoogle = googleBusyIntervals.some((interval) => {
        const gStart = new Date(interval.start).getTime();
        const gEnd = new Date(interval.end).getTime();
        return slotStart.getTime() < gEnd && slotEnd.getTime() > gStart;
      });

      slots.push({ startAt: startStr, endAt: endStr, available: !isBookedInD1 && !isBookedInGoogle });
    }

    return c.json({ success: true, data: slots });
  } catch (err) {
    console.error('GET /api/integrations/google-calendar/slots error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== 予約管理 ==========

calendar.get('/api/integrations/google-calendar/bookings', async (c) => {
  try {
    const connectionId = c.req.query('connectionId');
    const friendId = c.req.query('friendId');
    const items = await getCalendarBookings(c.env.DB, { connectionId: connectionId ?? undefined, friendId: friendId ?? undefined });
    return c.json({
      success: true,
      data: items.map((b) => ({
        id: b.id,
        connectionId: b.connection_id,
        friendId: b.friend_id,
        eventId: b.event_id,
        title: b.title,
        startAt: b.start_at,
        endAt: b.end_at,
        status: b.status,
        metadata: b.metadata ? JSON.parse(b.metadata) : null,
        createdAt: b.created_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/integrations/google-calendar/bookings error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

calendar.post('/api/integrations/google-calendar/book', async (c) => {
  try {
    const body = await c.req.json<{
      connectionId: string;
      friendId?: string;
      lineUserId?: string;
      title: string;
      startAt: string;
      endAt: string;
      description?: string;
      metadata?: Record<string, unknown>;
    }>();
    const validationError = validateBookingRequest(body);
    if (validationError) {
      return c.json({ success: false, error: validationError }, 400);
    }

    // D1 に予約レコードを作成
    const booking = await createCalendarBooking(c.env.DB, {
      ...body,
      metadata: body.metadata ? JSON.stringify(body.metadata) : undefined,
    });

    // Google Calendar にイベントを作成（ベストエフォート）
    const conn = await getCalendarConnectionById(c.env.DB, body.connectionId);
    if (conn) {
      try {
        const accessToken = await getValidAccessToken(c.env, c.env.DB, conn.id);
        const gcal = new GoogleCalendarClient({
          calendarId: conn.calendar_id,
          accessToken,
        });
        const attendeeEmail = body.metadata?.email as string | undefined;
        const { eventId } = await gcal.createEvent({
          summary: body.title,
          start: body.startAt,
          end: body.endAt,
          description: body.description,
          attendeeEmail,
        });
        await updateCalendarBookingEventId(c.env.DB, booking.id, eventId);
        booking.event_id = eventId;
      } catch (err) {
        console.warn('Google Calendar createEvent error (booking still created in D1):', err);
      }
    }

    // LINE プッシュ通知（ベストエフォート）
    try {
      // lineUserId 直接 or friendId 経由で取得
      let lineUserId = body.lineUserId;
      let channelAccessToken: string | undefined;

      if (!lineUserId && body.friendId) {
        const friend = await c.env.DB
          .prepare('SELECT line_user_id FROM friends WHERE id = ?')
          .bind(body.friendId)
          .first<{ line_user_id: string }>();
        lineUserId = friend?.line_user_id;
      }

      if (lineUserId) {
        // line_accounts テーブルが空の場合は Worker の環境変数から取得
        const account = await c.env.DB
          .prepare('SELECT channel_access_token FROM line_accounts WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1')
          .first<{ channel_access_token: string }>();
        channelAccessToken = account?.channel_access_token ?? c.env.LINE_CHANNEL_ACCESS_TOKEN;
        console.log('[LINE push] lineUserId:', lineUserId, '| token:', channelAccessToken ? '取得済み' : 'undefined');
      } else {
        console.log('[LINE push] lineUserId が未指定のためスキップ');
      }

      if (lineUserId && channelAccessToken) {
        // 日時ラベル生成（例: 4月21日(月) 10:00〜11:00）
        const toJst = (iso: string) => new Date(new Date(iso).getTime());
        const start = toJst(body.startAt);
        const end = toJst(body.endAt);
        const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
        const jstOffset = 9 * 60 * 60 * 1000;
        const startJst = new Date(start.getTime() + jstOffset);
        const endJst = new Date(end.getTime() + jstOffset);
        const dateStr = `${startJst.getUTCMonth() + 1}月${startJst.getUTCDate()}日(${weekdays[startJst.getUTCDay()]})`;
        const timeStr = `${String(startJst.getUTCHours()).padStart(2, '0')}:${String(startJst.getUTCMinutes()).padStart(2, '0')}〜${String(endJst.getUTCHours()).padStart(2, '0')}:${String(endJst.getUTCMinutes()).padStart(2, '0')}`;
        const startDateStr = `${dateStr} ${timeStr}`;
        const guestName = (body.metadata?.name as string | undefined) ?? body.title;

        const pushRes = await fetch('https://api.line.me/v2/bot/message/push', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${channelAccessToken}`,
          },
          body: JSON.stringify({
            to: lineUserId,
            messages: [{
              type: 'flex',
              altText: `✅ 予約が確定しました（${startDateStr}）`,
              contents: {
                type: 'bubble',
                header: {
                  type: 'box', layout: 'vertical', backgroundColor: '#06C755', paddingAll: '16px',
                  contents: [{ type: 'text', text: '✅ 予約確定', color: '#ffffff', size: 'lg', weight: 'bold' }],
                },
                body: {
                  type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '20px',
                  contents: [
                    {
                      type: 'box', layout: 'horizontal',
                      contents: [
                        { type: 'text', text: '📅 日時', size: 'sm', color: '#666666', flex: 2 },
                        { type: 'text', text: startDateStr, size: 'sm', wrap: true, flex: 5 },
                      ],
                    },
                    {
                      type: 'box', layout: 'horizontal',
                      contents: [
                        { type: 'text', text: '👤 お名前', size: 'sm', color: '#666666', flex: 2 },
                        { type: 'text', text: guestName, size: 'sm', flex: 5 },
                      ],
                    },
                  ],
                },
                footer: {
                  type: 'box', layout: 'vertical', paddingAll: '16px',
                  contents: [{
                    type: 'button',
                    action: { type: 'postback', label: 'キャンセルする', data: `cancel:${booking.id}`, displayText: '予約をキャンセルする' },
                    style: 'secondary', height: 'sm',
                  }],
                },
              },
            }],
          }),
        });
        const pushBody = await pushRes.text();
        console.log('[LINE push] status:', pushRes.status, '| body:', pushBody);
        if (!pushRes.ok) {
          console.warn('[LINE push] FAILED:', pushBody);
        }
      }
    } catch (err) {
      console.warn('LINE push notification error (booking still confirmed):', err);
    }

    // 予約リマインダー登録（ベストエフォート）
    try {
      // lineUserId または friendId から friend レコードを取得
      let friendRecord: { id: string } | null = null;
      if (body.lineUserId) {
        friendRecord = await c.env.DB
          .prepare('SELECT id FROM friends WHERE line_user_id = ? LIMIT 1')
          .bind(body.lineUserId)
          .first<{ id: string }>();
      } else if (body.friendId) {
        friendRecord = await c.env.DB
          .prepare('SELECT id FROM friends WHERE id = ? LIMIT 1')
          .bind(body.friendId)
          .first<{ id: string }>();
      }

      if (friendRecord) {
        const bookingStart = new Date(body.startAt);
        const bookingEnd = new Date(body.endAt);
        const jstOffset = 9 * 60 * 60 * 1000;
        const startJst = new Date(bookingStart.getTime() + jstOffset);
        const endJst = new Date(bookingEnd.getTime() + jstOffset);
        const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
        const dateLabel = `${startJst.getUTCMonth() + 1}月${startJst.getUTCDate()}日(${weekdays[startJst.getUTCDay()]})`;
        const timeLabel = `${String(startJst.getUTCHours()).padStart(2, '0')}:${String(startJst.getUTCMinutes()).padStart(2, '0')}〜${String(endJst.getUTCHours()).padStart(2, '0')}:${String(endJst.getUTCMinutes()).padStart(2, '0')}`;
        const dateTimeLabel = `${dateLabel} ${timeLabel}`;
        const guestName = (body.metadata?.name as string | undefined) ?? '';

        // 前日 09:00 JST のオフセット（分）= 前日09:00 - 予約開始時刻
        const dayBefore09 = new Date(startJst.getTime() - 24 * 60 * 60 * 1000);
        dayBefore09.setUTCHours(0, 0, 0, 0); // JST 09:00 = UTC 00:00
        const offsetDayBefore = Math.round((dayBefore09.getTime() - bookingStart.getTime()) / 60_000);

        // 当日 08:00 JST のオフセット（分）= 当日08:00 - 予約開始時刻
        const sameDay08 = new Date(startJst.getTime());
        sameDay08.setUTCHours(23, 0, 0, 0); // JST 08:00 = UTC 23:00 前日
        // startJst の日付の UTC 23:00 = JST 08:00 当日
        const sameDayDate = new Date(Date.UTC(startJst.getUTCFullYear(), startJst.getUTCMonth(), startJst.getUTCDate()) - 60 * 60 * 1000);
        const offsetSameDay = Math.round((sameDayDate.getTime() - bookingStart.getTime()) / 60_000);

        const now = Date.now();
        const willSendDayBefore = now < dayBefore09.getTime();
        const willSendSameDay = now < sameDayDate.getTime();

        if (willSendDayBefore || willSendSameDay) {
          // リマインダーテンプレートを作成（予約ごとに個別）
          const reminder = await createReminder(c.env.DB, {
            name: `予約リマインダー: ${booking.id}`,
            description: `booking_id:${booking.id}`,
          });
          await updateReminder(c.env.DB, reminder.id, { isActive: true });

          if (willSendDayBefore) {
            await createReminderStep(c.env.DB, {
              reminderId: reminder.id,
              offsetMinutes: offsetDayBefore,
              messageType: 'flex',
              messageContent: JSON.stringify({
                type: 'bubble',
                body: {
                  type: 'box', layout: 'vertical', paddingAll: '20px', spacing: 'md',
                  contents: [
                    { type: 'text', text: '明日の予約のご確認です 📅', weight: 'bold', size: 'md', color: '#1e293b' },
                    { type: 'text', text: body.title, size: 'sm', color: '#64748b', margin: 'sm' },
                    { type: 'separator', margin: 'lg' },
                    { type: 'box', layout: 'horizontal', margin: 'lg', contents: [
                      { type: 'text', text: '📅 日時', size: 'sm', color: '#666666', flex: 2 },
                      { type: 'text', text: dateTimeLabel, size: 'sm', wrap: true, flex: 5 },
                    ]},
                    ...(guestName ? [{ type: 'box', layout: 'horizontal', contents: [
                      { type: 'text', text: '👤 お名前', size: 'sm', color: '#666666', flex: 2 },
                      { type: 'text', text: guestName, size: 'sm', flex: 5 },
                    ]}] : []),
                  ],
                },
                footer: {
                  type: 'box', layout: 'vertical', paddingAll: '16px',
                  contents: [{
                    type: 'button',
                    action: { type: 'postback', label: 'キャンセルする', data: `cancel:${booking.id}`, displayText: '予約をキャンセルする' },
                    style: 'secondary', height: 'sm',
                  }],
                },
              }),
            });
          }

          if (willSendSameDay) {
            await createReminderStep(c.env.DB, {
              reminderId: reminder.id,
              offsetMinutes: offsetSameDay,
              messageType: 'flex',
              messageContent: JSON.stringify({
                type: 'bubble',
                body: {
                  type: 'box', layout: 'vertical', paddingAll: '20px', spacing: 'md',
                  contents: [
                    { type: 'text', text: '本日の予約をお忘れなく！📅', weight: 'bold', size: 'md', color: '#06C755' },
                    { type: 'text', text: body.title, size: 'sm', color: '#64748b', margin: 'sm' },
                    { type: 'separator', margin: 'lg' },
                    { type: 'box', layout: 'horizontal', margin: 'lg', contents: [
                      { type: 'text', text: '📅 日時', size: 'sm', color: '#666666', flex: 2 },
                      { type: 'text', text: dateTimeLabel, size: 'sm', wrap: true, flex: 5 },
                    ]},
                    { type: 'text', text: 'ご来店をお待ちしております。', size: 'xs', color: '#94a3b8', margin: 'lg', wrap: true },
                  ],
                },
              }),
            });
          }

          await enrollFriendInReminder(c.env.DB, {
            friendId: friendRecord.id,
            reminderId: reminder.id,
            targetDate: body.startAt,
          });
          console.log('[Reminder] enrolled friend', friendRecord.id, 'for booking', booking.id);
        }
      }
    } catch (err) {
      console.warn('Reminder enrollment error (booking still confirmed):', err);
    }

    return c.json({
      success: true,
      data: {
        id: booking.id,
        connectionId: booking.connection_id,
        friendId: booking.friend_id,
        eventId: booking.event_id,
        title: booking.title,
        startAt: booking.start_at,
        endAt: booking.end_at,
        status: booking.status,
        createdAt: booking.created_at,
      },
    }, 201);
  } catch (err) {
    console.error('POST /api/integrations/google-calendar/book error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

calendar.put('/api/integrations/google-calendar/bookings/:id/status', async (c) => {
  try {
    const id = c.req.param('id');
    const { status } = await c.req.json<{ status: string }>();

    // キャンセル時は Google Calendar のイベントも削除する（ベストエフォート）
    if (status === 'cancelled') {
      const booking = await getCalendarBookingById(c.env.DB, id);
      if (booking?.event_id && booking.connection_id) {
        const conn = await getCalendarConnectionById(c.env.DB, booking.connection_id);
        if (conn?.access_token) {
          try {
            const gcal = new GoogleCalendarClient({
              calendarId: conn.calendar_id,
              accessToken: conn.access_token,
            });
            await gcal.deleteEvent(booking.event_id);
          } catch (err) {
            console.warn('Google Calendar deleteEvent error (status still updated in D1):', err);
          }
        }
      }
    }

    await updateCalendarBookingStatus(c.env.DB, id, status);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('PUT /api/integrations/google-calendar/bookings/:id/status error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { calendar };
