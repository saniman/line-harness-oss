import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./receipt-share-verify.js', () => ({
  verifyShareUrl: vi.fn(),
  freeeShareVerifier: {},
}));

import { verifyShareUrl } from './receipt-share-verify.js';
import { saveReceiptShareUrl, revokeReceiptShare, SHARE_EXPIRY_DAYS } from './receipt-share.js';

const mockVerify = vi.mocked(verifyShareUrl);

const UUID = 'd03d03bd-204b-4a5f-bb48-03d5f13bef50';
const SHARE = `https://invoice.secure.freee.co.jp/ivex/dl/${UUID}`;

function booking(overrides: Record<string, unknown> = {}) {
  return {
    id: 5,
    event_id: 1,
    friend_id: 'f1',
    name: 'あきひさ',
    receipt_name: 'テスト株式会社',
    amount: 100,
    status: 'confirmed',
    payment_status: 'cash',
    cash_received_at: '2026-09-05 18:50:09',
    receipt_url: 'https://invoice.secure.freee.co.jp/reports/receipts/67021206',
    receipt_number: 'REC-0000000008',
    receipt_share_url: null,
    ...overrides,
  };
}

interface DbOptions {
  booking?: Record<string, unknown> | null;
  /** UPDATE が一意制約違反になるか */
  conflict?: boolean;
  /** 既にその URL を持っている予約（重複時に名前を出すため） */
  owner?: { id: number; name: string } | null;
}

/** SQL の空白を潰す。改行やインデントの違いで照合が壊れないようにする */
function norm(sql: string): string {
  return sql.replace(/\s+/g, ' ');
}

function makeDb(opts: DbOptions = {}) {
  const sqls: string[] = [];
  const bound: unknown[][] = [];
  const row = opts.booking === undefined ? booking() : opts.booking;

  const db = {
    prepare: vi.fn().mockImplementation((sql: string) => {
      sqls.push(sql);
      const isOwnerLookup = sql.includes('receipt_share_url = ?') && sql.includes('SELECT');
      const isUpdate = sql.includes('UPDATE');
      const stmt: Record<string, unknown> = {};
      stmt.bind = vi.fn().mockImplementation((...args: unknown[]) => {
        bound.push(args);
        return stmt;
      });
      stmt.first = vi.fn().mockImplementation(async () => {
        if (isOwnerLookup) return opts.owner ?? null;
        if (isUpdate) {
          if (opts.conflict) throw new Error('UNIQUE constraint failed: event_bookings.receipt_share_url');
          return { id: 5, receipt_share_token: 'tok-1' };
        }
        return row;
      });
      stmt.run = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
      return stmt;
    }),
  } as unknown as D1Database;

  return { db, sqls, bound };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerify.mockResolvedValue({ result: 'match', receiptNumber: 'REC-0000000008' });
});

describe('saveReceiptShareUrl（共有リンクの貼り付け）', () => {
  it('正しいリンクを保存し、トークンを発行する', async () => {
    const { db } = makeDb();

    const res = await saveReceiptShareUrl(db, 1, 5, SHARE);

    expect(res.ok).toBe(true);
    expect(res.token).toBeTruthy();
  });

  it('閲覧期限を60日後に設定する', async () => {
    const { db, sqls } = makeDb();

    await saveReceiptShareUrl(db, 1, 5, SHARE);

    expect(SHARE_EXPIRY_DAYS).toBe(60);
    const sql = sqls.find((q) => q.includes('receipt_share_expires_at')) ?? '';
    expect(sql).toContain("datetime('now'");
  });

  it('URL を正規化して保存する（クエリ違いを別物にしない）', async () => {
    const { db, bound } = makeDb();

    await saveReceiptShareUrl(db, 1, 5, `${SHARE}?utm_source=mail`);

    expect(bound.flat()).toContain(SHARE);
  });

  it('【重要】report_url を貼ったら拒否する', async () => {
    const { db } = makeDb();

    const res = await saveReceiptShareUrl(
      db, 1, 5,
      'https://invoice.secure.freee.co.jp/reports/receipts/67021206?from_public=true',
    );

    expect(res.ok).toBe(false);
    expect(res.code).toBe('invalid_url');
  });

  it('存在しない予約なら not_found', async () => {
    const { db } = makeDb({ booking: null });

    const res = await saveReceiptShareUrl(db, 1, 999, SHARE);

    expect(res.code).toBe('not_found');
  });

  it('イベントIDが一致しなければ拒否する', async () => {
    const { db } = makeDb({ booking: booking({ event_id: 99 }) });

    const res = await saveReceiptShareUrl(db, 1, 5, SHARE);

    expect(res.code).toBe('event_mismatch');
  });

  it('領収書が未発行なら拒否する', async () => {
    // freee に領収書が無いのに共有リンクだけあるのはおかしい
    const { db } = makeDb({ booking: booking({ receipt_url: null }) });

    const res = await saveReceiptShareUrl(db, 1, 5, SHARE);

    expect(res.code).toBe('not_issued');
  });

  it('キャンセル済みなら拒否する', async () => {
    const { db } = makeDb({ booking: booking({ status: 'cancelled' }) });

    const res = await saveReceiptShareUrl(db, 1, 5, SHARE);

    expect(res.code).toBe('cancelled');
  });
});

describe('saveReceiptShareUrl（取り違え対策）', () => {
  it('【重要】別の人の領収書なら拒否する（第4層）', async () => {
    mockVerify.mockResolvedValue({ result: 'mismatch', receiptNumber: 'REC-0000000012' });
    const { db, sqls } = makeDb();

    const res = await saveReceiptShareUrl(db, 1, 5, SHARE);

    expect(res.ok).toBe(false);
    expect(res.code).toBe('receipt_mismatch');
    // 運営者が原因に辿り着けるよう、両方の番号を出す
    expect(res.error).toContain('REC-0000000012');
    expect(res.error).toContain('REC-0000000008');
    expect(sqls.some((q) => q.includes('UPDATE'))).toBe(false);
  });

  it('【重要】無効・期限切れのリンクなら拒否する', async () => {
    mockVerify.mockResolvedValue({ result: 'not_found' });
    const { db } = makeDb();

    const res = await saveReceiptShareUrl(db, 1, 5, SHARE);

    expect(res.code).toBe('link_not_found');
  });

  it('【重要】同じリンクを別の予約に登録できない（第1層）', async () => {
    // クリップボードの持ち越し。実際に起きる取り違えの最頻パターン
    const { db } = makeDb({ conflict: true, owner: { id: 9, name: 'たろう' } });

    const res = await saveReceiptShareUrl(db, 1, 5, SHARE);

    expect(res.ok).toBe(false);
    expect(res.code).toBe('duplicate');
    // 誰に登録済みか出さないと、運営者は何を直せばいいか分からない
    expect(res.error).toContain('たろう');
  });

  it('検証できなくても保存はできる（未検証として記録する）', async () => {
    // freee の一時障害や仕様変更で運用を止めない。第1〜3層は生きている
    mockVerify.mockResolvedValue({ result: 'unavailable' });
    const { db, bound } = makeDb();

    const res = await saveReceiptShareUrl(db, 1, 5, SHARE);

    expect(res.ok).toBe(true);
    expect(res.verified).toBe(false);
  });

  it('検証が通ったら verified として記録する', async () => {
    const { db, sqls } = makeDb();

    const res = await saveReceiptShareUrl(db, 1, 5, SHARE);

    expect(res.verified).toBe(true);
    expect(sqls.some((q) => q.includes('receipt_share_verified_at'))).toBe(true);
  });

  it('【重要】検証には予約の領収書番号を渡す', async () => {
    const { db } = makeDb();

    await saveReceiptShareUrl(db, 1, 5, SHARE);

    expect(mockVerify).toHaveBeenCalledWith(UUID, 'REC-0000000008', expect.anything());
  });

  it('貼り直し（同じ予約に同じ URL）は通る', async () => {
    const { db } = makeDb({ booking: booking({ receipt_share_url: SHARE }) });

    const res = await saveReceiptShareUrl(db, 1, 5, SHARE);

    expect(res.ok).toBe(true);
  });
});

describe('無効化と、事故からの復旧（#47 第2層）', () => {
  it('無効化すると receipt_share_url を空にする', async () => {
    // ⚠️ 残したままだと全体一意の制約に阻まれ、**同じリンクを正しい予約に
    //    登録し直せない**。復旧が最も必要な場面で詰む
    const { db, sqls } = makeDb();

    const res = await revokeReceiptShare(db, 1, 5);

    expect(res.ok).toBe(true);
    const sql = sqls.find((q) => q.includes('receipt_share_revoked_at = ')) ?? '';
    expect(sql).toContain('receipt_share_url = NULL');
  });

  it('無効化してもトークンは残す（410 を出すため）', async () => {
    // 消すと 404「見つかりません」になり、参加者に何が起きたか伝わらない
    const { db, sqls } = makeDb();

    await revokeReceiptShare(db, 1, 5);

    const sql = sqls.find((q) => q.includes('receipt_share_revoked_at = ')) ?? '';
    expect(sql).not.toContain('receipt_share_token = NULL');
  });

  it('イベントIDが一致しなければ無効化しない', async () => {
    const { db, bound } = makeDb();

    await revokeReceiptShare(db, 1, 5);

    expect(bound.flat()).toEqual(expect.arrayContaining([5, 1]));
  });

  it('【重要】無効化後に貼り直すとトークンを作り直す（漏洩URLを復活させない）', async () => {
    // 使い回すと、誤って渡ってしまった URL が生き返り、
    // しかも今度は正しい領収書を相手に見せてしまう
    const { db, sqls } = makeDb();

    await saveReceiptShareUrl(db, 1, 5, SHARE);

    // ⚠️ SQL 全体を toContain で見ると、他の CASE 句の文字列に一致して素通りする。
    //    トークンの CASE 句そのものを、空白を正規化して厳密に照合する
    const sql = norm(sqls.find((q) => q.includes('receipt_share_token = ')) ?? '');
    expect(sql).toContain(
      'receipt_share_token = CASE'
      + ' WHEN receipt_share_revoked_at IS NULL THEN COALESCE(receipt_share_token, ?)'
      + ' ELSE ? END',
    );
  });

  it('【重要】無効化後に貼り直すと送信済みを解除する（送り直せる）', async () => {
    const { db, sqls } = makeDb();

    await saveReceiptShareUrl(db, 1, 5, SHARE);

    const sql = norm(sqls.find((q) => q.includes('receipt_sent_at = ')) ?? '');
    expect(sql).toContain(
      'receipt_sent_at = CASE'
      + ' WHEN receipt_share_revoked_at IS NULL THEN receipt_sent_at'
      + ' ELSE NULL END',
    );
  });

  it('無効化されていなければトークンを使い回す（送信済みURLを殺さない）', async () => {
    // 貼り間違いを直したとき、既に送った URL がそのまま正しい領収書を指すようにする
    const { db, sqls } = makeDb();

    await saveReceiptShareUrl(db, 1, 5, SHARE);

    const sql = norm(sqls.find((q) => q.includes('receipt_share_token = ')) ?? '');
    expect(sql).toContain('WHEN receipt_share_revoked_at IS NULL THEN COALESCE(receipt_share_token, ?)');
  });
});
