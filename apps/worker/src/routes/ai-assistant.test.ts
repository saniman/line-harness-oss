import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';

const mockGetConfig = vi.hoisted(() => vi.fn());
const mockUpdateConfig = vi.hoisted(() => vi.fn());

vi.mock('../services/ai-assistant.js', () => ({
  getAiAssistantConfig: mockGetConfig,
  updateAiAssistantConfig: mockUpdateConfig,
}));

import { aiAssistant } from './ai-assistant.js';

const app = new Hono();
app.route('/', aiAssistant);

const BASE_CONFIG = {
  id: 'default',
  enabled: 0,
  model: 'claude-haiku-4-5-20251001',
  knowledge: '',
  daily_limit: 10,
  updated_at: '2026-06-15T00:00:00+09:00',
};

const mockEnv = { DB: {} as D1Database };

afterEach(() => { vi.clearAllMocks(); });

function req(method: string, path: string, body?: unknown) {
  return app.request(
    path,
    {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    },
    mockEnv,
  );
}

describe('GET /api/ai-assistant/config', () => {
  beforeEach(() => { mockGetConfig.mockResolvedValue(BASE_CONFIG); });

  it('設定を返す', async () => {
    const res = await req('GET', '/api/ai-assistant/config');
    expect(res.status).toBe(200);
    const json = await res.json() as { success: boolean; data: typeof BASE_CONFIG };
    expect(json.success).toBe(true);
    expect(json.data.id).toBe('default');
  });
});

describe('PUT /api/ai-assistant/config', () => {
  beforeEach(() => {
    mockUpdateConfig.mockResolvedValue(undefined);
    mockGetConfig.mockResolvedValue({ ...BASE_CONFIG, enabled: 1, knowledge: '店名WALOVERカフェ' });
  });

  it('正常更新して更新後の設定を返す', async () => {
    const res = await req('PUT', '/api/ai-assistant/config', { enabled: 1, knowledge: '店名WALOVERカフェ' });
    expect(res.status).toBe(200);
    const json = await res.json() as { success: boolean; data: typeof BASE_CONFIG };
    expect(json.success).toBe(true);
    expect(json.data.enabled).toBe(1);
    expect(mockUpdateConfig).toHaveBeenCalledWith(
      expect.anything(),
      { enabled: 1, knowledge: '店名WALOVERカフェ' },
    );
  });

  it('daily_limit が負数のとき 400 を返す', async () => {
    const res = await req('PUT', '/api/ai-assistant/config', { daily_limit: -1 });
    expect(res.status).toBe(400);
    const json = await res.json() as { success: boolean };
    expect(json.success).toBe(false);
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it('daily_limit が小数のとき 400 を返す', async () => {
    const res = await req('PUT', '/api/ai-assistant/config', { daily_limit: 5.5 });
    expect(res.status).toBe(400);
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });
});
