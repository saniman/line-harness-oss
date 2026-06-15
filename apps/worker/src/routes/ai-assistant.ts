import { Hono } from 'hono';
import type { Env } from '../index.js';
import { getAiAssistantConfig, updateAiAssistantConfig } from '../services/ai-assistant.js';

const aiAssistant = new Hono<Env>();

/** GET /api/ai-assistant/config — 現在設定を返す（管理者専用） */
aiAssistant.get('/api/ai-assistant/config', async (c) => {
  const config = await getAiAssistantConfig(c.env.DB);
  return c.json({ success: true, data: config });
});

/** PUT /api/ai-assistant/config — 設定を部分更新（管理者専用） */
aiAssistant.put('/api/ai-assistant/config', async (c) => {
  const body = await c.req.json<{
    enabled?: number;
    model?: string;
    knowledge?: string;
    daily_limit?: number;
  }>();

  if (body.daily_limit !== undefined && (body.daily_limit < 0 || !Number.isInteger(body.daily_limit))) {
    return c.json({ success: false, error: 'daily_limit must be a non-negative integer' }, 400);
  }

  await updateAiAssistantConfig(c.env.DB, body);
  const updated = await getAiAssistantConfig(c.env.DB);
  return c.json({ success: true, data: updated });
});

export { aiAssistant };
