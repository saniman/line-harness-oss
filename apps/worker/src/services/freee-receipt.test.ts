import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./freee-oauth.js', () => ({
  getValidAccessTokenFreee: vi.fn(),
}));

import { getValidAccessTokenFreee } from './freee-oauth.js';
import { issueReceiptForBooking } from './freee-receipt.js';
import { FreeeReceiptApiError, type FreeeReceiptIssuer } from './freee-receipt-client.js';

const mockToken = vi.mocked(getValidAccessTokenFreee);

const ENV = {} as Parameters<typeof issueReceiptForBooking>[0];
const ISSUED_URL = 'https://invoice.secure.freee.co.jp/ivex/dl/abc';
/** claim が立てる印の時刻。release がこの値で照合できているかを見る */
const CLAIMED_AT = '2026-09-06 09:05:00';

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

interface DbOptions {
  /** 最初の SELECT が返す行 */
  booking?: Record<string, unknown> | null;
  /** 発行権（claim）が取れるか */
  claim?: boolean;
  /** 保存の UPDATE が1行更新できるか */
  save?: boolean;
  /** 2回目以降の SELECT が返す行（同時実行で状態が変わった状況を作る） */
  fresh?: Record<string, unknown> | null;
}

/**
 * SQL の中身で分岐する D1 モック。
 * 呼び出し順に依存させると、実装の途中に SELECT を1つ足しただけで
 * 全テストが無関係な理由で落ちる（＝壊れやすいテストになる）。
 */
function makeDb(opts: DbOptions = {}) {
  const sqls: string[] = [];
  /** release の UPDATE に渡された bind 引数 */
  const released: unknown[][] = [];
  const calls = { select: 0, claim: 0, release: 0, save: 0 };
  const row = opts.booking === undefined ? booking() : opts.booking;

  const db = {
    prepare: vi.fn().mockImplementation((sql: string) => {
      sqls.push(sql);
      const isSelect = sql.includes('SELECT * FROM event_bookings');
      const isClaim = sql.includes('RETURNING id');
      const isRelease = sql.includes('receipt_issued_at = NULL');
      const isSave = sql.includes('receipt_url = ?');

      let bound: unknown[] = [];
      return {
        bind: vi.fn().mockImplementation(function (this: unknown, ...args: unknown[]) {
          bound = args;
          return this;
        }),
        run: vi.fn().mockImplementation(async () => {
          if (isRelease) {
            calls.release++;
            released.push(bound);
          }
          return { meta: { changes: 1 } };
        }),
        first: vi.fn().mockImplementation(async () => {
          if (isSelect) {
            calls.select++;
            if (calls.select === 1) return row;
            return opts.fresh === undefined ? row : opts.fresh;
          }
          if (isClaim) {
            calls.claim++;
            return opts.claim === false ? null : { id: 5, receipt_issued_at: CLAIMED_AT };
          }
          if (isSave) {
            calls.save++;
            return opts.save === false ? null : { receipt_url: ISSUED_URL };
          }
          return null;
        }),
      };
    }),
  } as unknown as D1Database;

  return { db, sqls, calls, released };
}

/** 領収書を1件発行する最小の発行器 */
function makeIssuer(url = ISSUED_URL): FreeeReceiptIssuer {
  return { createReceipt: vi.fn().mockResolvedValue({ receiptId: 1, receiptUrl: url }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockToken.mockResolvedValue({ accessToken: 'at-1', companyId: 1234567, connectionId: 'c1' });
});

describe('issueReceiptForBooking（正常系）', () => {
  it('領収書を発行して URL を返す', async () => {
    const { db } = makeDb();
    const res = await issueReceiptForBooking(ENV, db, 1, 5, makeIssuer());

    expect(res.issued).toBe(true);
    expect(res.receiptUrl).toBe(ISSUED_URL);
  });

  it('宛名・金額・但し書きを発行器に渡す', async () => {
    const { db } = makeDb();
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
    const { db } = makeDb({ booking: booking({ cash_received_at: '2026-09-06 16:30:00' }) });
    const issuer = makeIssuer();

    await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    const arg = vi.mocked(issuer.createReceipt).mock.calls[0][0];
    // UTC 16:30 = JST 翌日 01:30
    expect(arg.issueDate).toBe('2026-09-07');
  });

  it('URL と発行日時を DB に保存する', async () => {
    const { db, sqls, calls } = makeDb();

    await issueReceiptForBooking(ENV, db, 1, 5, makeIssuer());

    const sql = sqls.find((q) => q.includes('receipt_url = ?')) ?? '';
    expect(sql).toContain('receipt_issued_at');
    expect(calls.save).toBe(1);
  });

  it('宛名の指定が無ければ申込時の氏名を使う', async () => {
    const { db } = makeDb({ booking: booking({ receipt_name: null }) });
    const issuer = makeIssuer();

    await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    const arg = vi.mocked(issuer.createReceipt).mock.calls[0][0];
    expect(arg.payeeName).toBe('あきひさ');
  });
});

describe('issueReceiptForBooking（発行しないケース）', () => {
  it('存在しない予約なら code=not_found', async () => {
    const { db } = makeDb({ booking: null });
    const issuer = makeIssuer();

    const res = await issueReceiptForBooking(ENV, db, 1, 999, issuer);

    expect(res.issued).toBe(false);
    expect(res.code).toBe('not_found');
    expect(issuer.createReceipt).not.toHaveBeenCalled();
  });

  it('イベントIDが一致しなければ発行しない', async () => {
    const { db } = makeDb({ booking: booking({ event_id: 99 }) });
    const issuer = makeIssuer();

    const res = await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    expect(res.code).toBe('event_mismatch');
    expect(issuer.createReceipt).not.toHaveBeenCalled();
  });

  it('【重要】既に発行済みなら再発行しない（冪等）', async () => {
    // 二重発行は経理上の事故。リトライや連打で起きうる
    const { db, calls } = makeDb({
      booking: booking({ receipt_url: 'https://invoice.secure.freee.co.jp/ivex/dl/old' }),
    });
    const issuer = makeIssuer();

    const res = await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    expect(res.issued).toBe(true);
    expect(res.alreadyIssued).toBe(true);
    expect(res.receiptUrl).toBe('https://invoice.secure.freee.co.jp/ivex/dl/old');
    expect(issuer.createReceipt).not.toHaveBeenCalled();
    expect(calls.claim).toBe(0);
    expect(calls.save).toBe(0);
  });

  it('現金を受領していなければ発行しない', async () => {
    // 受け取っていない金額の領収書を出してはいけない
    const { db } = makeDb({ booking: booking({ cash_received_at: null }) });
    const issuer = makeIssuer();

    const res = await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    expect(res.code).toBe('not_received');
    expect(issuer.createReceipt).not.toHaveBeenCalled();
  });

  it('キャンセル済みなら発行しない', async () => {
    const { db } = makeDb({ booking: booking({ status: 'cancelled' }) });
    const issuer = makeIssuer();

    const res = await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    expect(res.code).toBe('cancelled');
    expect(issuer.createReceipt).not.toHaveBeenCalled();
  });

  it('【重要】宛名が決められなければ発行しない', async () => {
    // resolveReceiptName は候補が全部空だと null を返す。
    // 空欄の宛名で領収書を出すと作り直しになる
    const { db } = makeDb({ booking: booking({ receipt_name: null, name: '' }) });
    const issuer = makeIssuer();

    const res = await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    expect(res.issued).toBe(false);
    expect(res.code).toBe('no_payee');
    expect(issuer.createReceipt).not.toHaveBeenCalled();
  });

  it('金額が無ければ発行しない', async () => {
    const { db } = makeDb({ booking: booking({ amount: null }) });
    const issuer = makeIssuer();

    const res = await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    expect(res.code).toBe('no_amount');
    expect(issuer.createReceipt).not.toHaveBeenCalled();
  });

  it('freee 未連携なら発行しない（受領の記録は壊さない）', async () => {
    mockToken.mockRejectedValue(new Error('FREEE_NOT_CONNECTED'));
    const { db, calls } = makeDb();
    const issuer = makeIssuer();

    const res = await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    expect(res.issued).toBe(false);
    expect(res.code).toBe('freee_unavailable');
    expect(calls.save).toBe(0);
  });

  it('トークンを取れなければ発行権を返す（次の試行を塞がない）', async () => {
    mockToken.mockRejectedValue(new Error('FREEE_NOT_CONNECTED'));
    const { db, calls } = makeDb();

    await issueReceiptForBooking(ENV, db, 1, 5, makeIssuer());

    expect(calls.release).toBe(1);
  });
});

describe('issueReceiptForBooking（同時実行）', () => {
  it('【重要】freee を呼ぶ前に発行権を取る', async () => {
    // 「読んでから書く」だけだと、2台の端末が両方とも未発行と読んで2枚発行される
    const { db, sqls } = makeDb();

    await issueReceiptForBooking(ENV, db, 1, 5, makeIssuer());

    const claim = sqls.find((q) => q.includes('RETURNING id')) ?? '';
    expect(claim).toContain('receipt_issued_at');
    expect(claim).toContain('receipt_url IS NULL');
  });

  it('【重要】発行権を取れなければ freee を呼ばない', async () => {
    const { db } = makeDb({ claim: false });
    const issuer = makeIssuer();

    const res = await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    expect(issuer.createReceipt).not.toHaveBeenCalled();
    expect(res.issued).toBe(false);
    expect(res.code).toBe('issue_in_progress');
  });

  it('発行権を取れず、既に他が発行し終えていたらその URL を返す', async () => {
    const { db } = makeDb({
      claim: false,
      fresh: booking({ receipt_url: 'https://invoice.secure.freee.co.jp/ivex/dl/won' }),
    });
    const issuer = makeIssuer();

    const res = await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    expect(res.issued).toBe(true);
    expect(res.alreadyIssued).toBe(true);
    expect(res.receiptUrl).toBe('https://invoice.secure.freee.co.jp/ivex/dl/won');
    expect(issuer.createReceipt).not.toHaveBeenCalled();
  });

  it('放棄された発行権は時間経過で奪い返せる（永久に発行不能にしない）', async () => {
    // Worker が発行の途中で落ちると receipt_issued_at だけが残る。
    // 期限を付けておかないと、その予約は二度と発行できなくなる
    const { db, sqls } = makeDb();

    await issueReceiptForBooking(ENV, db, 1, 5, makeIssuer());

    const claim = sqls.find((q) => q.includes('RETURNING id')) ?? '';
    expect(claim).toContain("datetime('now', ?)");
  });

  it('【重要】保存が0行なら、重複の可能性を運営者に伝える', async () => {
    // 発行権を持っていたのに保存できない＝もう1枚 freee 側にある可能性がある。
    // 黙って成功を返すと突合できなくなる
    const { db } = makeDb({ save: false, fresh: booking({ receipt_url: 'https://x/other' }) });

    const res = await issueReceiptForBooking(ENV, db, 1, 5, makeIssuer());

    // ⚠️ error ではなく warning に載せる。error に入れると呼び出し側の
    //    `issued ? null : error` で黙って捨てられる（1周目で実際にそうなった）
    expect(res.issued).toBe(true);
    expect(res.warning).toContain('2枚');
    expect(res.error).toBeUndefined();
  });

  it('【重要】発行権は自分が立てた印のときだけ返す', async () => {
    // 条件が receipt_url IS NULL だけだと、期限切れで引き継いだ相手の発行権まで
    // 消してしまい、3本目が同時に走れるようになる
    const { db, sqls, released } = makeDb();
    const issuer: FreeeReceiptIssuer = {
      createReceipt: vi.fn().mockRejectedValue(new Error('freee 500')),
    };

    await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    const release = sqls.find((q) => q.includes('receipt_issued_at = NULL')) ?? '';
    expect(release).toContain('receipt_issued_at = ?');
    // claim で持ち帰った時刻をそのまま照合に使っているか（? があるだけでは足りない）
    expect(released[0]).toContain(CLAIMED_AT);
  });

  it('発行権を取るときに時刻を持ち帰る（release の照合に使う）', async () => {
    const { db, sqls } = makeDb();

    await issueReceiptForBooking(ENV, db, 1, 5, makeIssuer());

    const claim = sqls.find((q) => q.includes('RETURNING id')) ?? '';
    expect(claim).toContain('RETURNING id, receipt_issued_at');
  });
});

describe('issueReceiptForBooking（freee API が失敗したとき）', () => {
  it('【重要】URL を保存しない（receipt_url を空のまま残す）', async () => {
    // 中途半端に URL を入れると、冪等ガードが効いて二度と発行できなくなる
    const { db, calls } = makeDb();
    const issuer: FreeeReceiptIssuer = {
      createReceipt: vi.fn().mockRejectedValue(new Error('freee 500')),
    };

    const res = await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    expect(res.issued).toBe(false);
    expect(res.code).toBe('issue_failed');
    expect(calls.save).toBe(0);
  });

  it('【重要】失敗したら発行権を返す（再送できるようにする）', async () => {
    const { db, calls } = makeDb();
    const issuer: FreeeReceiptIssuer = {
      createReceipt: vi.fn().mockRejectedValue(new Error('freee 500')),
    };

    await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    expect(calls.release).toBe(1);
  });

  it('URL が空で返ってきたら保存せず、発行権も返す', async () => {
    const { db, calls } = makeDb();
    const issuer: FreeeReceiptIssuer = {
      createReceipt: vi.fn().mockResolvedValue({ receiptId: 1, receiptUrl: '' }),
    };

    const res = await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    expect(res.issued).toBe(false);
    expect(res.code).toBe('issue_failed');
    expect(calls.save).toBe(0);
    expect(calls.release).toBe(1);
  });

  it('例外を外に投げない（受領の記録を巻き戻さないため）', async () => {
    const { db } = makeDb();
    const issuer: FreeeReceiptIssuer = {
      createReceipt: vi.fn().mockRejectedValue(new Error('boom')),
    };

    await expect(issueReceiptForBooking(ENV, db, 1, 5, issuer)).resolves.toBeTruthy();
  });
});

describe('issueReceiptForBooking（トークン失効）', () => {
  it('【重要】401 ならトークンを取り直して1回だけ再試行する', async () => {
    // freee 側で連携を解除されると、期限内のトークンでも 401 になる。
    // キャッシュを使い続けると期限が来るまで黙って失敗し続ける
    const { db } = makeDb();
    const createReceipt = vi
      .fn()
      .mockRejectedValueOnce(new FreeeReceiptApiError('freee 401', 401))
      .mockResolvedValueOnce({ receiptId: 1, receiptUrl: ISSUED_URL });

    const res = await issueReceiptForBooking(ENV, db, 1, 5, { createReceipt });

    expect(createReceipt).toHaveBeenCalledTimes(2);
    // 2回目は強制リフレッシュで取り直している
    expect(mockToken).toHaveBeenLastCalledWith(ENV, db, true);
    expect(res.issued).toBe(true);
  });

  it('再試行しても 401 なら「連携し直し」を案内する', async () => {
    const { db } = makeDb();
    const createReceipt = vi.fn().mockRejectedValue(new FreeeReceiptApiError('freee 401', 401));

    const res = await issueReceiptForBooking(ENV, db, 1, 5, { createReceipt });

    expect(res.code).toBe('freee_reauth_required');
    expect(res.error).toContain('連携');
  });

  it('401 以外（500）は再試行しない', async () => {
    // 一時障害でトークンを回すと、無駄に refresh_token を消費する
    const { db } = makeDb();
    const createReceipt = vi.fn().mockRejectedValue(new FreeeReceiptApiError('freee 500', 500));

    const res = await issueReceiptForBooking(ENV, db, 1, 5, { createReceipt });

    expect(createReceipt).toHaveBeenCalledTimes(1);
    expect(res.code).toBe('issue_failed');
  });

  it('400（設定ミス）も再試行しない', async () => {
    const { db } = makeDb();
    const createReceipt = vi
      .fn()
      .mockRejectedValue(new FreeeReceiptApiError('freee 400: 取引先を指定してください。', 400));

    const res = await issueReceiptForBooking(ENV, db, 1, 5, { createReceipt });

    expect(createReceipt).toHaveBeenCalledTimes(1);
    expect(res.code).toBe('issue_failed');
  });
});

describe('issueReceiptForBooking（運営者への案内）', () => {
  it('【重要】freee のエラー内容を潰さずに伝える', async () => {
    // 取引先が未設定だと freee が「取引先を指定してください」と教えてくれる。
    // 固定文で上書きすると、デプロイ直後に原因不明で全件失敗する
    const { db } = makeDb();
    const createReceipt = vi
      .fn()
      .mockRejectedValue(new FreeeReceiptApiError('freee 400: 取引先を指定してください。', 400));

    const res = await issueReceiptForBooking(ENV, db, 1, 5, { createReceipt });

    expect(res.error).toContain('取引先を指定してください');
  });

  it('freee 以外の失敗（通信断など）は中身を出さない', async () => {
    // 何が入るか読めないメッセージを管理画面に出さない
    const { db } = makeDb();
    const createReceipt = vi.fn().mockRejectedValue(new Error('fetch failed: 10.0.0.1:443'));

    const res = await issueReceiptForBooking(ENV, db, 1, 5, { createReceipt });

    expect(res.error).not.toContain('10.0.0.1');
  });

  it('【重要】連携が切れている（REAUTH_REQUIRED）なら再認可を案内する', async () => {
    // freee 側で連携を解除すると refresh の段階で落ちる。
    // /receipts まで届かないので 401 は返ってこない
    mockToken.mockRejectedValue(new Error('REAUTH_REQUIRED'));
    const { db } = makeDb();

    const res = await issueReceiptForBooking(ENV, db, 1, 5, makeIssuer());

    expect(res.code).toBe('freee_reauth_required');
    expect(res.error).toContain('連携し直して');
  });

  it('まだ連携していない（FREEE_NOT_CONNECTED）なら連携を案内する', async () => {
    mockToken.mockRejectedValue(new Error('FREEE_NOT_CONNECTED'));
    const { db } = makeDb();

    const res = await issueReceiptForBooking(ENV, db, 1, 5, makeIssuer());

    expect(res.code).toBe('freee_unavailable');
    expect(res.error).toContain('連携していません');
  });

  it('一時障害なら「少し待って」と案内する（再認可を促さない）', async () => {
    // ここで「連携し直して」と出すと、直す必要のない再認可をさせてしまう
    mockToken.mockRejectedValue(new Error('FREEE_TEMPORARILY_UNAVAILABLE'));
    const { db } = makeDb();

    const res = await issueReceiptForBooking(ENV, db, 1, 5, makeIssuer());

    expect(res.code).toBe('freee_unavailable');
    expect(res.error).toContain('少し待って');
  });
});
