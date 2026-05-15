import { Hono } from 'hono';
import Stripe from 'stripe';
import {
  createEvent,
  getEvents,
  getEventById,
  updateEvent,
  deleteEvent,
  getEventBookings,
  createEventBooking,
  createPendingBooking,
  updateBookingStripeSessionId,
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
    const bookings = await getEventBookings(c.env.DB, id);
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
    const body = await c.req.json<{ name: string; email: string; lineUserId?: string }>();

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
      name: body.name,
      email: body.email,
    });

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
      apiVersion: '2024-06-20',
      httpClient: Stripe.createFetchHttpClient(),
    });

    const liffBase = (c.env as unknown as Record<string, string>).LIFF_BASE_URL ?? '';
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

export { events };
