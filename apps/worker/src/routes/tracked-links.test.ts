import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbMocks = {
  getTrackedLinks: vi.fn(),
  getTrackedLinkById: vi.fn(),
  getTrackedLinkByIdOrShortCode: vi.fn(),
  createTrackedLink: vi.fn(),
  updateTrackedLink: vi.fn(),
  deleteTrackedLink: vi.fn(),
  recordLinkClick: vi.fn(),
  getLinkClicks: vi.fn(),
  getFriendByLineUserId: vi.fn(),
  addTagToFriend: vi.fn(),
  enrollFriendInScenario: vi.fn(),
  generateShortCode: vi.fn(),
};

vi.mock('@line-crm/db', () => dbMocks);

const { trackedLinks } = await import('./tracked-links.js');

const UUID = '11111111-2222-3333-4444-555555555555';

function makeLink(overrides: Record<string, unknown> = {}) {
  return {
    id: UUID,
    name: 'テストリンク',
    original_url: 'https://example.com/campaign',
    tag_id: null,
    scenario_id: null,
    intro_template_id: null,
    reward_template_id: null,
    line_account_id: null,
    short_code: 'Ab3xY9k',
    is_active: 1,
    click_count: 0,
    created_at: '2026-07-27T00:00:00.000Z',
    updated_at: '2026-07-27T00:00:00.000Z',
    ...overrides,
  };
}

const env = { DB: {} as D1Database, WORKER_URL: 'https://api.example.com' };

/** waitUntil に渡された非同期処理を取り出せる ExecutionContext スタブ */
function makeCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: (p: Promise<unknown>) => { pending.push(p); },
      passThroughOnException: () => {},
    } as unknown as ExecutionContext,
    settle: () => Promise.allSettled(pending),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /t/:linkId の短縮コード解決', () => {
  it('短縮コードでもリンクを解決してリダイレクトする', async () => {
    dbMocks.getTrackedLinkByIdOrShortCode.mockResolvedValue(makeLink());
    const { ctx, settle } = makeCtx();

    const res = await trackedLinks.request(
      '/t/Ab3xY9k',
      { headers: { 'user-agent': 'Mozilla/5.0' } },
      env,
      ctx,
    );
    await settle();

    expect(dbMocks.getTrackedLinkByIdOrShortCode).toHaveBeenCalledWith(env.DB, 'Ab3xY9k');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://example.com/campaign');
  });

  it('クリック記録には短縮コードではなくリンクの id を渡す', async () => {
    dbMocks.getTrackedLinkByIdOrShortCode.mockResolvedValue(makeLink());
    const { ctx, settle } = makeCtx();

    await trackedLinks.request(
      '/t/Ab3xY9k',
      { headers: { 'user-agent': 'Mozilla/5.0' } },
      env,
      ctx,
    );
    await settle();

    expect(dbMocks.recordLinkClick).toHaveBeenCalledWith(env.DB, UUID, null);
  });

  it('従来の UUID 形式でも引き続き解決できる', async () => {
    dbMocks.getTrackedLinkByIdOrShortCode.mockResolvedValue(makeLink({ short_code: null }));
    const { ctx, settle } = makeCtx();

    const res = await trackedLinks.request(
      `/t/${UUID}`,
      { headers: { 'user-agent': 'Mozilla/5.0' } },
      env,
      ctx,
    );
    await settle();

    expect(dbMocks.getTrackedLinkByIdOrShortCode).toHaveBeenCalledWith(env.DB, UUID);
    expect(res.status).toBe(302);
  });

  it('リンクが見つからない場合は 404 を返す', async () => {
    dbMocks.getTrackedLinkByIdOrShortCode.mockResolvedValue(null);
    const { ctx } = makeCtx();

    const res = await trackedLinks.request(
      '/t/unknown',
      { headers: { 'user-agent': 'Mozilla/5.0' } },
      env,
      ctx,
    );

    expect(res.status).toBe(404);
    expect(dbMocks.recordLinkClick).not.toHaveBeenCalled();
  });

  it('無効化されたリンクは 404 を返す', async () => {
    dbMocks.getTrackedLinkByIdOrShortCode.mockResolvedValue(makeLink({ is_active: 0 }));
    const { ctx } = makeCtx();

    const res = await trackedLinks.request(
      '/t/Ab3xY9k',
      { headers: { 'user-agent': 'Mozilla/5.0' } },
      env,
      ctx,
    );

    expect(res.status).toBe(404);
    expect(dbMocks.recordLinkClick).not.toHaveBeenCalled();
  });
});
