import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./freee-oauth.js', () => ({
  getValidAccessTokenFreee: vi.fn(),
}));

import { getValidAccessTokenFreee } from './freee-oauth.js';
import { issueReceiptForBooking, type FreeeReceiptIssuer } from './freee-receipt.js';

const mockToken = vi.mocked(getValidAccessTokenFreee);

const ENV = {} as Parameters<typeof issueReceiptForBooking>[0];

/** 受領済み・領収書未発行の予約 */
function booking(overrides: Record<string, unknown> = {}) {
  return {
    id: 5,
    event_id: 1,
    friend_id: 'f1',
    name: 'あきひさ',
    receipt_name: '株式会社サンプル',
    amount: 3000,
    status: 'confirmed',
    payment_status: 'cash',
    cash_received_at: '2026-09-06 09:00:00',
    receipt_url: null,
    receipt_issued_at: null,
    ...overrides,
  };
}

function makeStmt(firstResult: unknown = null) {
  return {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
    first: vi.fn().mockResolvedValue(firstResult),
    all: vi.fn().mockResolvedValue({ results: [] }),
  };
}

function makeDb(...stmts: ReturnType<typeof makeStmt>[]) {
  let i = 0;
  const sqls: string[] = [];
  const used: ReturnType<typeof makeStmt>[] = [];
  const db = {
    prepare: vi.fn().mockImplementation((sql: string) => {
      sqls.push(sql);
      const s = stmts[i++] ?? makeStmt();
      used.push(s);
      return s;
    }),
  } as unknown as D1Database;
  return { db, sqls, used };
}

/** 領収書を1件発行する最小の発行器 */
function makeIssuer(url = 'https://invoice.secure.freee.co.jp/ivex/dl/abc'): FreeeReceiptIssuer {
  return { createReceipt: vi.fn().mockResolvedValue({ receiptUrl: url }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockToken.mockResolvedValue({ accessToken: 'at-1', companyId: 1234567, connectionId: 'c1' });
});

describe('issueReceiptForBooking（正常系）', () => {
  it('領収書を発行して URL を返す', async () => {
    const { db } = makeDb(makeStmt(booking()));
    const issuer = makeIssuer();

    const res = await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    expect(res.issued).toBe(true);
    expect(res.receiptUrl).toBe('https://invoice.secure.freee.co.jp/ivex/dl/abc');
  });

  it('宛名・金額・但し書きを発行器に渡す', async () => {
    const { db } = makeDb(makeStmt(booking()));
    const issuer = makeIssuer();

    await issueReceiptForBooking(ENV, db, 1, 5, issuer, { eventTitle: '無料セミナー' });

    expect(issuer.createReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        payeeName: '株式会社サンプル',
        amount: 3000,
        companyId: 1234567,
        accessToken: 'at-1',
      }),
    );
    const arg = vi.mocked(issuer.createReceipt).mock.calls[0][0];
    expect(arg.description).toContain('無料セミナー');
  });

  it('発行日は JST の暦日で渡す', async () => {
    // UTC で渡すと日付が1日ずれた領収書が出る
    const { db } = makeDb(makeStmt(booking({ cash_received_at: '2026-09-06 16:30:00' })));
    const issuer = makeIssuer();

    await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    const arg = vi.mocked(issuer.createReceipt).mock.calls[0][0];
    // UTC 16:30 = JST 翌日 01:30
    expect(arg.issueDate).toBe('2026-09-07');
  });

  it('URL と発行日時を DB に保存する', async () => {
    const update = makeStmt();
    const { db, sqls } = makeDb(makeStmt(booking()), update);

    await issueReceiptForBooking(ENV, db, 1, 5, makeIssuer());

    const sql = sqls.find((q) => q.includes('UPDATE')) ?? '';
    expect(sql).toContain('receipt_url');
    expect(sql).toContain('receipt_issued_at');
    const bound = (update.bind as ReturnType<typeof vi.fn>).mock.calls.flat();
    expect(bound).toContain('https://invoice.secure.freee.co.jp/ivex/dl/abc');
  });

  it('宛名の指定が無ければ申込時の氏名を使う', async () => {
    const { db } = makeDb(makeStmt(booking({ receipt_name: null })));
    const issuer = makeIssuer();

    await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    const arg = vi.mocked(issuer.createReceipt).mock.calls[0][0];
    expect(arg.payeeName).toBe('あきひさ');
  });
});

describe('issueReceiptForBooking（発行しないケース）', () => {
  it('存在しない予約なら code=not_found', async () => {
    const { db } = makeDb(makeStmt(null));
    const issuer = makeIssuer();

    const res = await issueReceiptForBooking(ENV, db, 1, 999, issuer);

    expect(res.issued).toBe(false);
    expect(res.code).toBe('not_found');
    expect(issuer.createReceipt).not.toHaveBeenCalled();
  });

  it('イベントIDが一致しなければ発行しない', async () => {
    const { db } = makeDb(makeStmt(booking({ event_id: 99 })));
    const issuer = makeIssuer();

    const res = await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    expect(res.code).toBe('event_mismatch');
    expect(issuer.createReceipt).not.toHaveBeenCalled();
  });

  it('【重要】既に発行済みなら再発行しない（冪等）', async () => {
    // 二重発行は経理上の事故。リトライや連打で起きうる
    const already = booking({ receipt_url: 'https://invoice.secure.freee.co.jp/ivex/dl/old' });
    const { db, sqls } = makeDb(makeStmt(already));
    const issuer = makeIssuer();

    const res = await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    expect(res.issued).toBe(true);
    expect(res.alreadyIssued).toBe(true);
    expect(res.receiptUrl).toBe('https://invoice.secure.freee.co.jp/ivex/dl/old');
    expect(issuer.createReceipt).not.toHaveBeenCalled();
    expect(sqls.some((q) => q.includes('UPDATE'))).toBe(false);
  });

  it('現金を受領していなければ発行しない', async () => {
    // 受け取っていない金額の領収書を出してはいけない
    const { db } = makeDb(makeStmt(booking({ cash_received_at: null })));
    const issuer = makeIssuer();

    const res = await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    expect(res.code).toBe('not_received');
    expect(issuer.createReceipt).not.toHaveBeenCalled();
  });

  it('キャンセル済みなら発行しない', async () => {
    const { db } = makeDb(makeStmt(booking({ status: 'cancelled' })));
    const issuer = makeIssuer();

    const res = await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    expect(res.code).toBe('cancelled');
    expect(issuer.createReceipt).not.toHaveBeenCalled();
  });

  it('【重要】宛名が決められなければ発行しない', async () => {
    // resolveReceiptName は候補が全部空だと null を返す。
    // 空欄の宛名で領収書を出すと作り直しになる
    const { db } = makeDb(makeStmt(booking({ receipt_name: null, name: '' })));
    const issuer = makeIssuer();

    const res = await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    expect(res.issued).toBe(false);
    expect(res.code).toBe('no_payee');
    expect(issuer.createReceipt).not.toHaveBeenCalled();
  });

  it('金額が無ければ発行しない', async () => {
    const { db } = makeDb(makeStmt(booking({ amount: null })));
    const issuer = makeIssuer();

    const res = await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    expect(res.code).toBe('no_amount');
    expect(issuer.createReceipt).not.toHaveBeenCalled();
  });

  it('freee 未連携なら発行しない（受領の記録は壊さない）', async () => {
    mockToken.mockRejectedValue(new Error('FREEE_NOT_CONNECTED'));
    const { db, sqls } = makeDb(makeStmt(booking()));
    const issuer = makeIssuer();

    const res = await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    expect(res.issued).toBe(false);
    expect(res.code).toBe('freee_unavailable');
    expect(sqls.some((q) => q.includes('UPDATE'))).toBe(false);
  });
});

describe('issueReceiptForBooking（freee API が失敗したとき）', () => {
  it('【重要】DB を更新しない（receipt_url を空のまま残す）', async () => {
    // 中途半端に URL を入れると、冪等ガードが効いて二度と発行できなくなる
    const { db, sqls } = makeDb(makeStmt(booking()));
    const issuer: FreeeReceiptIssuer = {
      createReceipt: vi.fn().mockRejectedValue(new Error('freee 500')),
    };

    const res = await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    expect(res.issued).toBe(false);
    expect(res.code).toBe('issue_failed');
    expect(sqls.some((q) => q.includes('UPDATE'))).toBe(false);
  });

  it('URL が空で返ってきたら保存しない', async () => {
    const { db, sqls } = makeDb(makeStmt(booking()));
    const issuer: FreeeReceiptIssuer = {
      createReceipt: vi.fn().mockResolvedValue({ receiptUrl: '' }),
    };

    const res = await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    expect(res.issued).toBe(false);
    expect(res.code).toBe('issue_failed');
    expect(sqls.some((q) => q.includes('UPDATE'))).toBe(false);
  });

  it('例外を外に投げない（受領の記録を巻き戻さないため）', async () => {
    const { db } = makeDb(makeStmt(booking()));
    const issuer: FreeeReceiptIssuer = {
      createReceipt: vi.fn().mockRejectedValue(new Error('boom')),
    };

    await expect(issueReceiptForBooking(ENV, db, 1, 5, issuer)).resolves.toBeTruthy();
  });
});
