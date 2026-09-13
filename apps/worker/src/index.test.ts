// cron の配線テスト（#118）
//
// なぜ必要か: `scheduled()` は cron 式で分岐していて、ジョブを**移し忘れても
// 何も落ちない**。掃除が黙って止まり、pending 申込が溜まり続けても誰も気づけない。
// 2026-09-10 には `*/5` の登録自体が数ヶ月欠けていたことに気づけなかった。
// 「この cron でこのジョブが回る」という配線そのものを固定する。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRunExpirer = vi.fn();
const mockRunEventBookingExpirer = vi.fn();

vi.mock('./services/booking-expirer.js', () => ({
  runExpirer: (...args: unknown[]) => mockRunExpirer(...args),
}));
vi.mock('./services/event-booking-expirer.js', () => ({
  runEventBookingExpirer: (...args: unknown[]) => mockRunEventBookingExpirer(...args),
}));
vi.mock('@line-crm/line-sdk', () => ({
  LineClient: vi.fn(() => ({ pushMessage: vi.fn(), broadcast: vi.fn() })),
  buildMessage: vi.fn(),
}));

/** 何を聞かれても空を返す D1。expirer 以外のジョブはここで失敗して握られる */
function makeDb() {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [] }),
      first: vi.fn().mockResolvedValue(null),
      run: vi.fn().mockResolvedValue({ meta: { changes: 0 } }),
    })),
  } as unknown as D1Database;
}

/** scheduled に渡す最小の env。足りない値は各ジョブ側で失敗して握られる */
function makeEnv() {
  return {
    DB: makeDb(),
    LINE_CHANNEL_ACCESS_TOKEN: 'token',
    WORKER_URL: 'https://example.test',
  };
}

async function fire(cron: string, env: unknown) {
  const mod = await import('./index.js');
  await mod.default.scheduled(
    { cron } as unknown as ScheduledEvent,
    env as never,
    { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRunExpirer.mockResolvedValue({ expired: 0, idempotencyPurged: 0 });
  mockRunEventBookingExpirer.mockResolvedValue({ expired: 0 });
});

describe('cron の配線（#118）', () => {
  it('【重要】*/5 の tick でサロン予約の expirer が回る', async () => {
    await fire('*/5 * * * *', makeEnv());
    expect(mockRunExpirer).toHaveBeenCalled();
  });

  it('【重要】*/5 の tick でイベント申込の expirer が回る', async () => {
    await fire('*/5 * * * *', makeEnv());
    expect(mockRunEventBookingExpirer).toHaveBeenCalled();
  });

  it('【重要】0 */6 の tick では何も起きない（分岐を消した）', async () => {
    // 分岐が残っていると、トリガーを消すまで二重に走る
    await fire('0 */6 * * *', makeEnv());
    expect(mockRunExpirer).not.toHaveBeenCalled();
    expect(mockRunEventBookingExpirer).not.toHaveBeenCalled();
  });

  it('【重要】掃除が失敗したら理由をログに残す', async () => {
    // ⚠️ `Promise.allSettled` は reject を**無言で握る**。catch を外しても
    //    「もう片方は動く」は成り立つので、それだけを見るテストは空振りする
    //    （ミューテーションテストで判明）。ログに出ることこそが catch の価値。
    //    ここが消えると、掃除が止まっていても誰も気づけない。
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockRunExpirer.mockRejectedValue(new Error('boom'));

    await fire('*/5 * * * *', makeEnv());

    expect(spy.mock.calls.some((c) => String(c[0]).includes('booking-expirer'))).toBe(true);
    // 片方の失敗で他方まで止めない
    expect(mockRunEventBookingExpirer).toHaveBeenCalled();
    spy.mockRestore();
  });
});
