import { describe, expect, it, vi } from 'vitest';
import { runEventBookingExpirer } from './event-booking-expirer.js';

/**
 * UPDATE の SQL とバインド値を記録する D1 スタブ。
 * booking-expirer.test.ts と同じ作法（実 D1 は使わない）。
 */
function stubDB(changes: number) {
  const updates: Array<{ sql: string; bound: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        async run() {
          updates.push({ sql, bound });
          return { success: true, meta: { changes } };
        },
        async all() {
          return { results: [] };
        },
        async first() {
          return null;
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db, updates };
}

const NOW = new Date('2026-09-04T12:00:00.000Z');

describe('runEventBookingExpirer', () => {
  it('期限切れの pending を cancelled + checkout_expired にする', async () => {
    const { db, updates } = stubDB(3);

    const result = await runEventBookingExpirer(db, { now: NOW });

    expect(result.expired).toBe(3);
    expect(updates).toHaveLength(1);
    expect(updates[0].sql).toContain("status = 'cancelled'");
    expect(updates[0].sql).toContain("'checkout_expired'");
  });

  it('対象は pending のみ（confirmed / cancelled を巻き込まない）', async () => {
    const { db, updates } = stubDB(0);

    await runEventBookingExpirer(db, { now: NOW });

    expect(updates[0].sql).toContain("status = 'pending'");
  });

  it('入金済みは取り消さない', async () => {
    const { db, updates } = stubDB(0);

    await runEventBookingExpirer(db, { now: NOW });

    expect(updates[0].sql).toContain('paid_at IS NULL');
  });

  it('セッションを作れなかった行は理由を出し分ける', async () => {
    // session_id が NULL ＝ Stripe セッション作成に失敗した行。
    // 客の離脱と同じ理由にすると障害が折りたたみに隠れる
    const { db, updates } = stubDB(0);

    await runEventBookingExpirer(db, { now: NOW });

    expect(updates[0].sql).toContain('checkout_create_failed');
    expect(updates[0].sql).toContain('CASE');
  });

  it('stripe_session_id が NULL の pending も対象にする', async () => {
    // Stripe のセッション作成に失敗した申込は session_id が NULL のまま残り、
    // webhook も届かない（metadata が無い）。この掃除ネットが最後の受け皿になる。
    // session_id は理由の出し分け（CASE）にだけ使い、絞り込みには使わない
    const { db, updates } = stubDB(0);

    await runEventBookingExpirer(db, { now: NOW });

    expect(updates[0].sql).not.toContain('stripe_session_id IS NOT NULL');
  });

  it('now から 2 時間前を締切としてバインドする', async () => {
    const { db, updates } = stubDB(0);

    await runEventBookingExpirer(db, { now: NOW });

    // Stripe の expires_at は 30 分。webhook 遅延との二重処理を避けて猶予を取る。
    // created_at と同じ datetime('now') 形式（スペース区切り・Z なし）で渡すこと。
    expect(updates[0].bound[0]).toBe('2026-09-04 10:00:00');
  });

  it('締切を created_at と比較可能な形式で渡す', async () => {
    const { db, updates } = stubDB(0);

    await runEventBookingExpirer(db, { now: NOW });

    // created_at の既定値は datetime('now') = 'YYYY-MM-DD HH:MM:SS'。
    // ISO 形式（'T' 区切り・ミリ秒・Z）を渡すと SQLite の文字列比較が壊れる
    expect(updates[0].bound[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('猶予内に作られた申込を締切より古いと判定しない', async () => {
    // SQLite の BINARY 照合は文字コード順。'T'(0x54) より ' '(0x20) が小さいため、
    // ISO 形式の締切と datetime 形式の created_at を比べると
    // 「同じ日付なら常に締切より古い」と誤判定し、決済中の申込まで取り消してしまう。
    // JS の文字列比較は SQLite の BINARY 照合と同じ順序なのでここで再現できる。
    const { db, updates } = stubDB(0);

    await runEventBookingExpirer(db, { now: NOW });

    const cutoff = updates[0].bound[0] as string;
    const twoMinutesAgo = '2026-09-04 11:58:00'; // NOW の 2 分前 = まだ決済中
    const threeHoursAgo = '2026-09-04 09:00:00'; // 猶予超え = 取り消してよい

    expect(twoMinutesAgo < cutoff).toBe(false);
    expect(threeHoursAgo < cutoff).toBe(true);
  });

  it('1 tick あたりの件数に上限を設ける', async () => {
    const { db, updates } = stubDB(0);

    await runEventBookingExpirer(db, { now: NOW });

    expect(updates[0].sql).toContain('LIMIT 200');
  });

  it('対象が無ければ expired=0 を返す', async () => {
    const { db } = stubDB(0);

    const result = await runEventBookingExpirer(db, { now: NOW });

    expect(result.expired).toBe(0);
  });

  it('meta.changes が返らない D1 でも 0 として扱う', async () => {
    const db = {
      prepare: () => ({
        bind: () => ({ run: vi.fn().mockResolvedValue({ success: true }) }),
      }),
    } as unknown as D1Database;

    const result = await runEventBookingExpirer(db, { now: NOW });

    expect(result.expired).toBe(0);
  });
});
