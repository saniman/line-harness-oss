import { Hono } from 'hono';
import Stripe from 'stripe';
import { LineClient } from '@line-crm/line-sdk';
import {
  createEvent,
  getEvents,
  getEventById,
  updateEvent,
  deleteEvent,
  getEventBookings,
  getEventBookingsAdmin,
  createEventBooking,
  createPendingBooking,
  updateBookingStripeSessionId,
  cancelEventBooking,
} from '../services/events.js';
import type { Env } from '../index.js';

const events = new Hono<Env>();

// ========== 管理API ==========

events.get('/api/events', async (c) => {
  try {
    const items = await getEvents(c.env.DB);
    return c.json({
      success: true,
      data: items.map((e) => ({
        ...e,
        remaining: e.capacity - e.participant_count,
      })),
    });
  } catch (err) {
    console.error('GET /api/events error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

events.post('/api/events', async (c) => {
  try {
    const body = await c.req.json<{
      title?: string;
      description?: string;
      start_at?: string;
      end_at?: string;
      capacity?: number;
      price?: number | null;
      is_published?: number;
    }>();
    if (!body.title || !body.start_at || !body.end_at || !body.capacity) {
      return c.json({ success: false, error: 'title, start_at, end_at, capacity are required' }, 400);
    }
    const event = await createEvent(c.env.DB, {
      title: body.title,
      description: body.description,
      start_at: body.start_at,
      end_at: body.end_at,
      capacity: body.capacity,
      price: body.price != null && body.price > 0 ? body.price : null,
      is_published: body.is_published,
    });
    return c.json({ success: true, data: { ...event, remaining: event.capacity - event.participant_count } }, 201);
  } catch (err) {
    console.error('POST /api/events error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== 公開API（LIFF向け） ==========

// NOTE: /public must be registered before /:id to avoid shadowing
events.get('/api/events/public', async (c) => {
  try {
    const items = await getEvents(c.env.DB);
    const published = items
      .filter((e) => e.is_published === 1)
      .map((e) => ({
        id: e.id,
        title: e.title,
        description: e.description,
        start_at: e.start_at,
        end_at: e.end_at,
        capacity: e.capacity,
        price: e.price,
        participant_count: e.participant_count,
        remaining: e.capacity - e.participant_count,
        available: e.participant_count < e.capacity,
      }));
    return c.json({ success: true, data: published });
  } catch (err) {
    console.error('GET /api/events/public error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== 個別イベント管理 ==========

events.get('/api/events/:id', async (c) => {
  try {
    const id = Number(c.req.param('id'));
    const event = await getEventById(c.env.DB, id);
    if (!event) return c.json({ success: false, error: 'Event not found' }, 404);
    return c.json({ success: true, data: { ...event, remaining: event.capacity - event.participant_count } });
  } catch (err) {
    console.error('GET /api/events/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

events.get('/api/events/:id/bookings', async (c) => {
  try {
    const id = Number(c.req.param('id'));
    const bookings = await getEventBookingsAdmin(c.env.DB, id);
    return c.json({ success: true, data: bookings });
  } catch (err) {
    console.error('GET /api/events/:id/bookings error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

events.put('/api/events/:id', async (c) => {
  try {
    const id = Number(c.req.param('id'));
    const body = await c.req.json<{
      title?: string;
      description?: string;
      start_at?: string;
      end_at?: string;
      capacity?: number;
      price?: number | null;
      is_published?: number;
    }>();
    const event = await updateEvent(c.env.DB, id, body);
    if (!event) return c.json({ success: false, error: 'Event not found' }, 404);
    return c.json({ success: true, data: { ...event, remaining: event.capacity - event.participant_count } });
  } catch (err) {
    console.error('PUT /api/events/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

events.delete('/api/events/:id', async (c) => {
  try {
    const id = Number(c.req.param('id'));
    await deleteEvent(c.env.DB, id);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/events/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

events.post('/api/events/:id/join', async (c) => {
  try {
    const id = Number(c.req.param('id'));
    const body = await c.req.json<{ name?: string; lineUserId?: string; paymentMethod?: string }>();
    const isCash = body.paymentMethod === 'cash';

    const event = await getEventById(c.env.DB, id);
    if (!event) return c.json({ success: false, error: 'Event not found' }, 404);
    if (event.participant_count >= event.capacity) {
      return c.json({ success: false, error: 'Event is full' }, 409);
    }

    // lineUserId → friendId 解決（ベストエフォート）
    let friendId: string | null = null;
    if (body.lineUserId) {
      try {
        const row = await c.env.DB
          .prepare('SELECT id FROM friends WHERE line_user_id = ? LIMIT 1')
          .bind(body.lineUserId)
          .first<{ id: string }>();
        friendId = row?.id ?? null;
      } catch {
        // フォールバック: friend_id なしで続行
      }
    }

    const booking = await createEventBooking(c.env.DB, {
      event_id: id,
      friend_id: friendId,
      name: body.name ?? '',
      payment_status: isCash ? 'cash' : undefined,
    });

    // LINE push通知（ベストエフォート）
    if (body.lineUserId && c.env.LINE_CHANNEL_ACCESS_TOKEN) {
      try {
        const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
        const d = new Date(new Date(event.start_at).getTime() + 9 * 60 * 60 * 1000);
        const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(d.getUTCDate()).padStart(2, '0');
        const hh = String(d.getUTCHours()).padStart(2, '0');
        const min = String(d.getUTCMinutes()).padStart(2, '0');
        const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
        const dateStr = `${mm}/${dd}(${weekdays[d.getUTCDay()]}) ${hh}:${min}`;
        const headerText = isCash ? '✅ 当日現金払いで申込完了' : '✅ お申込みが完了しました';
        const cashNote = isCash ? [
          { type: 'text', text: '💴 当日スタッフにお支払いください', size: 'sm', color: '#e67e22', wrap: true },
        ] : [];
        await lineClient.pushMessage(body.lineUserId, [{
          type: 'flex',
          altText: `✅ 「${event.title}」のお申込みが完了しました`,
          contents: {
            type: 'bubble',
            header: {
              type: 'box', layout: 'vertical', paddingAll: '16px',
              backgroundColor: '#06C755',
              contents: [{ type: 'text', text: headerText, color: '#ffffff', weight: 'bold', size: 'md' }],
            },
            body: {
              type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'sm',
              contents: [
                { type: 'text', text: event.title, weight: 'bold', size: 'md', wrap: true },
                { type: 'text', text: `日時：${dateStr}`, size: 'sm', color: '#666666', wrap: true },
                ...cashNote,
              ],
            },
            footer: {
              type: 'box', layout: 'vertical', paddingAll: '12px',
              contents: [{
                type: 'button',
                action: {
                  type: 'postback',
                  label: 'キャンセルはこちら',
                  data: `event_cancel:${booking.id}`,
                  displayText: 'キャンセルを申請する',
                },
                style: 'secondary', height: 'sm',
              }],
            },
          } as never,
        }]);
      } catch {
        // ベストエフォート
      }
    }

    return c.json({ success: true, data: booking }, 201);
  } catch (err) {
    console.error('POST /api/events/:id/join error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

events.post('/api/events/:id/checkout-session', async (c) => {
  try {
    const id = Number(c.req.param('id'));
    const lineUserId = c.req.header('x-line-user-id');

    // 1. イベント取得・存在チェック・公開チェック
    const event = await getEventById(c.env.DB, id);
    if (!event || event.is_published !== 1) {
      return c.json({ success: false, error: 'Event not found' }, 404);
    }

    // 2. 定員チェック（participant_count は confirmed のみカウント済み）
    if (event.participant_count >= event.capacity) {
      return c.json({ success: false, error: 'Event is full' }, 409);
    }

    // 3. lineUserId → friendId 解決（ベストエフォート）
    let friendId: string | null = null;
    if (lineUserId) {
      try {
        const row = await c.env.DB
          .prepare('SELECT id FROM friends WHERE line_user_id = ? LIMIT 1')
          .bind(lineUserId)
          .first<{ id: string }>();
        friendId = row?.id ?? null;
      } catch {
        // フォールバック: friend_id なしで続行
      }
    }

    // 4. 仮登録（pending / unpaid）
    const booking = await createPendingBooking(c.env.DB, { event_id: id, friend_id: friendId });

    // 5. Stripe Checkout Session 作成
    const stripe = new Stripe(c.env.STRIPE_SECRET_KEY, {
      apiVersion: '2026-04-22.dahlia',
      httpClient: Stripe.createFetchHttpClient(),
    });

    const liffBase = c.env.LIFF_BASE_URL ?? '';
    let session: { id: string; url: string | null };
    try {
      session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [{
          price_data: {
            currency: 'jpy',
            unit_amount: event.price ?? 0,
            product_data: { name: event.title },
          },
          quantity: 1,
        }],
        success_url: `${liffBase}?page=event&payment=success&bookingId=${booking.id}`,
        cancel_url:  `${liffBase}?page=event&payment=cancel&bookingId=${booking.id}`,
        metadata: {
          bookingId: String(booking.id),
          lineUserId: lineUserId ?? '',
          eventId: String(id),
        },
        expires_at: Math.floor(Date.now() / 1000) + 1800,
      });
    } catch (stripeErr) {
      console.error('Stripe checkout.sessions.create error:', stripeErr);
      return c.json({ success: false, error: 'Stripe API error' }, 500);
    }

    // 6. stripe_session_id を更新
    await updateBookingStripeSessionId(c.env.DB, booking.id, session.id);

    return c.json({ success: true, data: { url: session.url } });
  } catch (err) {
    console.error('POST /api/events/:id/checkout-session error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== LIFF: イベント予約キャンセル ==========

events.post('/api/events/bookings/:id/cancel', async (c) => {
  try {
    const bookingId = Number(c.req.param('id'));
    const lineUserId = c.req.header('x-line-user-id') ?? null;

    // lineUserId → friendId 解決（ベストエフォート）
    let friendId: string | null = null;
    if (lineUserId) {
      try {
        const row = await c.env.DB
          .prepare('SELECT id FROM friends WHERE line_user_id = ? LIMIT 1')
          .bind(lineUserId)
          .first<{ id: string }>();
        friendId = row?.id ?? null;
      } catch {
        // フォールバック: friend_id なしで続行
      }
    }

    const stripe = new Stripe(c.env.STRIPE_SECRET_KEY, {
      apiVersion: '2026-04-22.dahlia',
      httpClient: Stripe.createFetchHttpClient(),
    });

    const result = await cancelEventBooking(c.env.DB, bookingId, friendId, stripe);
    if (!result.success) {
      return c.json({ success: false, error: result.error }, 400);
    }

    // LINE push通知（ベストエフォート）
    if (lineUserId && c.env.LINE_CHANNEL_ACCESS_TOKEN && result.eventId) {
      try {
        const event = await getEventById(c.env.DB, result.eventId);
        const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
        const d = new Date(new Date(event?.start_at ?? '').getTime() + 9 * 60 * 60 * 1000);
        const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(d.getUTCDate()).padStart(2, '0');
        const hh = String(d.getUTCHours()).padStart(2, '0');
        const min = String(d.getUTCMinutes()).padStart(2, '0');
        const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
        const dateStr = event?.start_at
          ? `${mm}/${dd}(${weekdays[d.getUTCDay()]}) ${hh}:${min}`
          : '';
        const bodyContents: object[] = [
          { type: 'text', text: event?.title ?? 'イベント', weight: 'bold', size: 'md', wrap: true },
          { type: 'text', text: `日時：${dateStr}`, size: 'sm', color: '#666666', wrap: true },
        ];
        if (result.refunded) {
          bodyContents.push({ type: 'text', text: '返金処理を開始しました。カードの種類や銀行によって、口座への反映まで 5〜10 営業日ほどかかる場合があります。', size: 'sm', color: '#999999', wrap: true });
        }
        await lineClient.pushMessage(lineUserId, [{
          type: 'flex',
          altText: `キャンセルが完了しました：${event?.title ?? 'イベント'}`,
          contents: {
            type: 'bubble',
            header: {
              type: 'box', layout: 'vertical', paddingAll: '16px',
              backgroundColor: '#999999',
              contents: [{ type: 'text', text: 'キャンセルが完了しました', color: '#ffffff', weight: 'bold', size: 'md' }],
            },
            body: {
              type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'sm',
              contents: bodyContents,
            },
          } as never,
        }]);
      } catch {
        // ベストエフォート
      }
    }

    return c.json({ success: true, data: { refunded: result.refunded } });
  } catch (err) {
    console.error('POST /api/events/bookings/:id/cancel error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { events };
