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
    expect(updates[0].sql).toContain("cancel_reason = 'checkout_expired'");
  });

  it('対象は pending のみ（confirmed / cancelled を巻き込まない）', async () => {
    const { db, updates } = stubDB(0);

    await runEventBookingExpirer(db, { now: NOW });

    expect(updates[0].sql).toContain("status = 'pending'");
  });

  it('カード決済フローに乗った行だけを対象にする（無料・当日現金を巻き込まない）', async () => {
    const { db, updates } = stubDB(0);

    await runEventBookingExpirer(db, { now: NOW });

    // 無料 / 当日現金の申込は /join で confirmed として作られ stripe_session_id を持たない
    expect(updates[0].sql).toContain('stripe_session_id IS NOT NULL');
    expect(updates[0].sql).toContain('paid_at IS NULL');
  });

  it('now から 2 時間前を締切としてバインドする', async () => {
    const { db, updates } = stubDB(0);

    await runEventBookingExpirer(db, { now: NOW });

    // Stripe の expires_at は 30 分。webhook 遅延との二重処理を避けて猶予を取る
    expect(updates[0].bound[0]).toBe('2026-09-04T10:00:00.000Z');
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
