import { Hono } from 'hono';
import { getBusinessHours, updateBusinessHours, getHolidays, addHoliday, removeHoliday } from '../services/business-hours.js';
import type { Env } from '../index.js';

const businessHours = new Hono<Env>();

// GET /api/business-hours — 全曜日の営業時間設定を返す
businessHours.get('/api/business-hours', async (c) => {
  try {
    const items = await getBusinessHours(c.env.DB);
    return c.json({ success: true, data: items });
  } catch (err) {
    console.error('GET /api/business-hours error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/business-hours/:dayOfWeek — 曜日設定を更新
businessHours.put('/api/business-hours/:dayOfWeek', async (c) => {
  try {
    const dayOfWeek = Number(c.req.param('dayOfWeek'));
    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
      return c.json({ success: false, error: 'dayOfWeek must be an integer between 0 and 6' }, 400);
    }
    const body = await c.req.json<{
      is_open?: number;
      start_hour?: number;
      end_hour?: number;
      slot_minutes?: number;
    }>();
    const updated = await updateBusinessHours(c.env.DB, dayOfWeek, body);
    return c.json({ success: true, data: updated });
  } catch (err) {
    console.error('PUT /api/business-hours/:dayOfWeek error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/business-hours/holidays — 休業日一覧
businessHours.get('/api/business-hours/holidays', async (c) => {
  try {
    const from = c.req.query('from');
    const to = c.req.query('to');
    const items = await getHolidays(c.env.DB, from && to ? { from, to } : undefined);
    return c.json({ success: true, data: items });
  } catch (err) {
    console.error('GET /api/business-hours/holidays error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/business-hours/holidays — 休業日を追加
businessHours.post('/api/business-hours/holidays', async (c) => {
  try {
    const body = await c.req.json<{ date?: string; reason?: string | null }>();
    if (!body.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
      return c.json({ success: false, error: 'date is required and must be YYYY-MM-DD format' }, 400);
    }
    const holiday = await addHoliday(c.env.DB, body.date, body.reason);
    return c.json({ success: true, data: holiday }, 201);
  } catch (err) {
    console.error('POST /api/business-hours/holidays error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/business-hours/holidays/:date — 休業日を削除
businessHours.delete('/api/business-hours/holidays/:date', async (c) => {
  try {
    const date = c.req.param('date');
    await removeHoliday(c.env.DB, date);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/business-hours/holidays/:date error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { businessHours };
