import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreateTrackedLink = vi.fn();

vi.mock('@line-crm/db', () => ({
  createTrackedLink: (...args: unknown[]) => mockCreateTrackedLink(...args),
}));

const { autoTrackContent } = await import('./auto-track.js');

const DB = {} as D1Database;
const WORKER_URL = 'https://api.example.com';

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateTrackedLink.mockResolvedValue({
    id: '11111111-2222-3333-4444-555555555555',
    short_code: 'Ab3xY9k',
  });
});

describe('autoTrackContent の短縮コード対応', () => {
  it('短縮コードがある場合は /t/<short_code> のURLに置き換わる', async () => {
    const result = await autoTrackContent(DB, 'text', '詳しくはこちら https://example.com/campaign', WORKER_URL);

    expect(result.content).toBe(`詳しくはこちら ${WORKER_URL}/t/Ab3xY9k`);
  });

  it('短縮コードが null の場合は UUID にフォールバックする', async () => {
    mockCreateTrackedLink.mockResolvedValue({
      id: '11111111-2222-3333-4444-555555555555',
      short_code: null,
    });

    const result = await autoTrackContent(DB, 'text', 'https://example.com/campaign', WORKER_URL);

    expect(result.content).toBe(`${WORKER_URL}/t/11111111-2222-3333-4444-555555555555`);
  });

  it('lineAccountId を渡すと作成するリンクの所有アカウントとして記録される', async () => {
    await autoTrackContent(DB, 'text', 'https://example.com/campaign', WORKER_URL, {
      lineAccountId: 'acc-1',
    });

    expect(mockCreateTrackedLink).toHaveBeenCalledWith(
      DB,
      expect.objectContaining({ lineAccountId: 'acc-1' }),
    );
  });
});

describe('既存トラッキングリンクの二重ラップ防止', () => {
  it('短縮コード形式の /t/ リンクは再ラップしない', async () => {
    const content = `もう一度どうぞ ${WORKER_URL}/t/Ab3xY9k`;

    const result = await autoTrackContent(DB, 'text', content, WORKER_URL);

    expect(mockCreateTrackedLink).not.toHaveBeenCalled();
    expect(result.content).toBe(content);
  });

  it('末尾スラッシュ付きの workerUrl でも短縮コードリンクを再ラップしない', async () => {
    const content = `${WORKER_URL}/t/Ab3xY9k`;

    const result = await autoTrackContent(DB, 'text', content, `${WORKER_URL}/`);

    expect(mockCreateTrackedLink).not.toHaveBeenCalled();
    expect(result.content).toBe(content);
  });

  it('従来の UUID 形式の /t/ リンクも引き続き再ラップしない', async () => {
    const content = `${WORKER_URL}/t/11111111-2222-3333-4444-555555555555`;

    const result = await autoTrackContent(DB, 'text', content, WORKER_URL);

    expect(mockCreateTrackedLink).not.toHaveBeenCalled();
    expect(result.content).toBe(content);
  });

  it('別ドメインの /t/ に見えるURLは通常どおりトラッキング対象にする', async () => {
    const result = await autoTrackContent(DB, 'text', 'https://other.example.org/t/Ab3xY9k', WORKER_URL);

    expect(mockCreateTrackedLink).toHaveBeenCalledTimes(1);
    expect(result.content).toBe(`${WORKER_URL}/t/Ab3xY9k`);
  });
});
