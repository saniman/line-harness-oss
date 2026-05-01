import { Hono } from 'hono';
import {
  createEvent,
  getEvents,
  getEventById,
  updateEvent,
  deleteEvent,
  getEventBookings,
  createEventBooking,
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

export { events };
