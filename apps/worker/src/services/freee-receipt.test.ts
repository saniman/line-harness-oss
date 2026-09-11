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
    /**
     * イベントの開催日時（events.start_at を JOIN したもの）。領収日の唯一の元データ。
     * jstDatetimeLocalToIso が作る UTC の ISO 8601 形式。
     */
    event_start_at: '2026-09-06T00:00:00.000Z',
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
  /** 発行結果を保存する UPDATE に渡された bind 引数（宛名が入るか見る） */
  const savedBinds: unknown[][] = [];
  const calls = { select: 0, claim: 0, release: 0, save: 0 };
  const row = opts.booking === undefined ? booking() : opts.booking;

  const db = {
    prepare: vi.fn().mockImplementation((sql: string) => {
      sqls.push(sql);
      // 宛名解決用の SELECT（friends と LEFT JOIN）と、状態の読み直し（SELECT *）の両方
      const isSelect = sql.includes('FROM event_bookings');
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
          if (isClaim || isRelease || isSave) {
            if (isClaim) {
              calls.claim++;
              return opts.claim === false ? null : { id: 5, receipt_issued_at: CLAIMED_AT };
            }
            if (isSave) {
              calls.save++;
              savedBinds.push(bound);
              return opts.save === false ? null : { receipt_url: ISSUED_URL };
            }
            return null;
          }
          if (isSelect) {
            calls.select++;
            if (calls.select === 1) return row;
            return opts.fresh === undefined ? row : opts.fresh;
          }
          return null;
        }),
      };
    }),
  } as unknown as D1Database;

  return { db, sqls, calls, released, savedBinds };
}

/** 領収書を1件発行する最小の発行器 */
function makeIssuer(url = ISSUED_URL): FreeeReceiptIssuer {
  return {
    createReceipt: vi
      .fn()
      .mockResolvedValue({ receiptId: 1, receiptNumber: 'REC-0000000008', receiptUrl: url }),
  };
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

  it('領収日は JST の暦日で渡す', async () => {
    // UTC のまま渡すと日付が1日ずれた領収書が出る
    // events.start_at は UTC の ISO（JST 09/07 01:30 開始）
    const { db } = makeDb({ booking: booking({ event_start_at: '2026-09-06T16:30:00.000Z' }) });
    const issuer = makeIssuer();

    await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    const arg = vi.mocked(issuer.createReceipt).mock.calls[0][0];
    // UTC 16:30 = JST 翌日 01:30
    expect(arg.issueDate).toBe('2026-09-07');
  });

  it('領収日はイベント実施日にする（受領ボタンを押した日ではない）', async () => {
    // #113 の再現。夜のイベントで、片付け後に受領ボタンを押すと日付をまたぐ。
    //   イベント  JST 2026-09-11 19:00 開始
    //   ボタン    JST 2026-09-12 00:30（UTC 2026-09-11 15:30）
    // cash_received_at を見ていると領収日が 09-12 になり、イベント翌日の証憑になる。
    const { db } = makeDb({
      booking: booking({
        event_start_at: '2026-09-11T10:00:00.000Z',
        cash_received_at: '2026-09-11 15:30:00',
      }),
    });
    const issuer = makeIssuer();

    await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    const arg = vi.mocked(issuer.createReceipt).mock.calls[0][0];
    expect(arg.issueDate).toBe('2026-09-11');
  });

  it('受領した時刻が変わっても領収日は動かない', async () => {
    // 領収日がイベント日**だけ**に依存することを固定する。
    // 片方だけ直すと「昼のイベントでは合うが夜はずれる」状態に戻る。
    const issueDates = await Promise.all(
      ['2026-09-11 00:10:00', '2026-09-11 15:30:00', '2026-09-14 08:00:00'].map(async (receivedAt) => {
        const { db } = makeDb({
          booking: booking({ event_start_at: '2026-09-11T10:00:00.000Z', cash_received_at: receivedAt }),
        });
        const issuer = makeIssuer();
        await issueReceiptForBooking(ENV, db, 1, 5, issuer);
        return vi.mocked(issuer.createReceipt).mock.calls[0][0].issueDate;
      }),
    );

    expect(issueDates).toEqual(['2026-09-11', '2026-09-11', '2026-09-11']);
  });

  it('イベント実施日が取れなければ発行しない（受領日時にフォールバックしない）', async () => {
    // ⚠️ ここで cash_received_at に逃がすと #113 が「イベントが消えたときだけ再発する」
    //    形で戻り、しかも誰も気づけない。発行せずに運営者へ返す。
    const { db, calls } = makeDb({ booking: booking({ event_start_at: null }) });
    const issuer = makeIssuer();

    const res = await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    expect(res.issued).toBe(false);
    expect(res.code).toBe('bad_date');
    expect(issuer.createReceipt).not.toHaveBeenCalled();
    // 発行権も握らない（握ると次の試行がタイムアウトまで詰まる）
    expect(calls.claim).toBe(0);
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

describe('領収書が不要と答えられた予約（#80）', () => {
  it('【重要】freee を呼ばない', async () => {
    // 頼まれていない領収書を発行すると、freee 上で取消が必要な経理事故になる
    const { db } = makeDb({ booking: booking({ receipt_requested: 0 }) });
    const issuer = makeIssuer();

    const res = await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    expect(issuer.createReceipt).not.toHaveBeenCalled();
    expect(res.issued).toBe(false);
    expect(res.code).toBe('not_requested');
  });

  it('【重要】失敗として扱わない（管理者が原因を追いかけないように）', async () => {
    // error を入れると管理画面が「発行できていません（原因）」と警告を出し、
    // 運営者が freee の設定を疑って調べ始めてしまう
    const { db } = makeDb({ booking: booking({ receipt_requested: 0 }) });

    const res = await issueReceiptForBooking(ENV, db, 1, 5, makeIssuer());

    expect(res.error).toBeUndefined();
  });

  it('【重要】発行権を握らない（あとで気が変わっても詰まらない）', async () => {
    const { db, sqls } = makeDb({ booking: booking({ receipt_requested: 0 }) });

    await issueReceiptForBooking(ENV, db, 1, 5, makeIssuer());

    expect(sqls.some((q) => q.includes('receipt_issued_at = '))).toBe(false);
  });

  it('「必要」と答えた予約は今までどおり発行する', async () => {
    const { db } = makeDb({ booking: booking({ receipt_requested: 1 }) });
    const issuer = makeIssuer();

    const res = await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    expect(issuer.createReceipt).toHaveBeenCalled();
    expect(res.issued).toBe(true);
  });

  it('【重要】未回答（この機能より前の予約）は今までどおり発行する', async () => {
    // null を「不要」と読むと、既存の予約が黙って対象外になり、
    // 参加者に領収書が届かなくなっても誰も気づけない
    const { db } = makeDb({ booking: booking({ receipt_requested: null }) });
    const issuer = makeIssuer();

    const res = await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    expect(issuer.createReceipt).toHaveBeenCalled();
    expect(res.issued).toBe(true);
  });

  it('既に発行済みなら、不要と答えていても発行済みとして返す', async () => {
    // 冪等ガードのほうが優先。ここで not_requested を返すと、
    // 既に出ている領収書の URL が管理画面から消える
    const { db } = makeDb({
      booking: booking({ receipt_requested: 0, receipt_url: ISSUED_URL }),
    });

    const res = await issueReceiptForBooking(ENV, db, 1, 5, makeIssuer());

    expect(res.issued).toBe(true);
    expect(res.receiptUrl).toBe(ISSUED_URL);
  });
});

describe('あとから発行する（#82・運営者の明示指示）', () => {
  it('【重要】不要と答えられていても、明示指示なら発行する', async () => {
    // 当日「やっぱり領収書ください」と言われたときの唯一の経路
    const { db } = makeDb({ booking: booking({ receipt_requested: 0 }) });
    const issuer = makeIssuer();

    const res = await issueReceiptForBooking(ENV, db, 1, 5, issuer, { forceIssue: true });

    expect(issuer.createReceipt).toHaveBeenCalled();
    expect(res.issued).toBe(true);
  });

  it('【重要】指示された宛名で発行する（表示名にフォールバックしない）', async () => {
    // 「いいえ」の人は receipt_name が NULL なので、フォールバックすると
    // LINE の表示名（ニックネームのことがある）で領収書が出てしまう
    const { db } = makeDb({
      booking: booking({ receipt_requested: 0, receipt_name: null, name: 'やまだ' }),
    });
    const issuer = makeIssuer();

    await issueReceiptForBooking(ENV, db, 1, 5, issuer, {
      forceIssue: true, payeeName: '株式会社サンプル',
    });

    const arg = vi.mocked(issuer.createReceipt).mock.calls[0][0];
    expect(arg.payeeName).toBe('株式会社サンプル');
  });

  it('【重要】指示された宛名も正規化する（制御文字・長さ）', async () => {
    // 運営者の手入力なので、参加者入力と同じ扱いにする
    const { db } = makeDb({ booking: booking({ receipt_requested: 0 }) });
    const issuer = makeIssuer();

    await issueReceiptForBooking(ENV, db, 1, 5, issuer, {
      forceIssue: true, payeeName: '  株式会社\n\nサンプル  ',
    });

    const arg = vi.mocked(issuer.createReceipt).mock.calls[0][0];
    expect(arg.payeeName).not.toContain('\n');
    expect(arg.payeeName.trim()).toBe(arg.payeeName);
  });

  it('【重要】明示指示でも、既に発行済みなら二重発行しない', async () => {
    // 冪等ガードのほうが優先。freee 上で取消が必要な経理事故になる
    const { db } = makeDb({
      booking: booking({ receipt_requested: 0, receipt_url: ISSUED_URL }),
    });
    const issuer = makeIssuer();

    const res = await issueReceiptForBooking(ENV, db, 1, 5, issuer, { forceIssue: true });

    expect(issuer.createReceipt).not.toHaveBeenCalled();
    expect(res.issued).toBe(true);
    expect(res.receiptUrl).toBe(ISSUED_URL);
  });

  it('【重要】明示指示でも、現金を受け取っていなければ発行しない', async () => {
    // 受け取っていない金額の領収書を出してはいけない
    const { db } = makeDb({
      booking: booking({ receipt_requested: 0, cash_received_at: null }),
    });
    const issuer = makeIssuer();

    const res = await issueReceiptForBooking(ENV, db, 1, 5, issuer, { forceIssue: true });

    expect(issuer.createReceipt).not.toHaveBeenCalled();
    expect(res.code).toBe('not_received');
  });

  it('【重要】明示指示でも、キャンセル済みなら発行しない', async () => {
    const { db } = makeDb({
      booking: booking({ receipt_requested: 0, status: 'cancelled' }),
    });

    const res = await issueReceiptForBooking(ENV, db, 1, 5, makeIssuer(), { forceIssue: true });

    expect(res.code).toBe('cancelled');
  });

  it('【重要】参加者の回答（receipt_requested）は書き換えない', async () => {
    // 「参加者が不要と答えた」事実と「運営者が今回だけ発行した」判断は別の情報。
    // 上書きすると、あとから経緯が追えなくなる
    const { db, sqls } = makeDb({ booking: booking({ receipt_requested: 0 }) });

    await issueReceiptForBooking(ENV, db, 1, 5, makeIssuer(), { forceIssue: true });

    expect(sqls.some((q) => q.includes('receipt_requested'))).toBe(false);
  });

  it('【重要】指示された宛名を DB にも保存する', async () => {
    // 保存しないと、参加者への LINE は receipt_name のフォールバック（表示名）を出し、
    // PDF と食い違う。「宛名を書いておけば取り違えに本人が気づける」という
    // 第3.5層の防御が、誤配でないのに誤配のサインを出すことになる（#47 / receipt-notify.ts）
    const { db, sqls } = makeDb({ booking: booking({ receipt_requested: 0, receipt_name: null }) });

    await issueReceiptForBooking(ENV, db, 1, 5, makeIssuer(), {
      forceIssue: true, payeeName: '株式会社サンプル',
    });

    const save = sqls.find((q) => q.includes('receipt_url = ?')) ?? '';
    expect(save).toContain('receipt_name');
  });

  it('【重要】保存する宛名も正規化済みの値にする（PDF と同じ文字列）', async () => {
    // 画面に出す値と PDF の値がずれると、確認する意味が無くなる
    const { db, savedBinds } = makeDb({ booking: booking({ receipt_requested: 0, receipt_name: null }) });

    await issueReceiptForBooking(ENV, db, 1, 5, makeIssuer(), {
      forceIssue: true, payeeName: '  株式会社\nサンプル  ',
    });

    const saved = savedBinds[0]?.find(
      (v) => typeof v === 'string' && v.includes('株式会社'),
    ) as string;
    expect(saved).not.toContain('\n');
    expect(saved.trim()).toBe(saved);
  });

  it('宛名の指示が無ければ receipt_name は触らない', async () => {
    // 通常の発行（参加者が「はい」と答えた分）は既に receipt_name を持っている
    const { db, sqls } = makeDb({ booking: booking({ receipt_name: '株式会社サンプル' }) });

    await issueReceiptForBooking(ENV, db, 1, 5, makeIssuer());

    const save = sqls.find((q) => q.includes('receipt_url = ?')) ?? '';
    expect(save).not.toContain('receipt_name');
  });

  it('明示指示が無ければ従来どおりスキップする', async () => {
    const { db } = makeDb({ booking: booking({ receipt_requested: 0 }) });
    const issuer = makeIssuer();

    const res = await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    expect(issuer.createReceipt).not.toHaveBeenCalled();
    expect(res.code).toBe('not_requested');
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
    // 4xx = 作られていないと断言できる失敗＝発行権を返す経路
    const issuer: FreeeReceiptIssuer = {
      createReceipt: vi.fn().mockRejectedValue(new FreeeReceiptApiError('freee 400', 400)),
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
      createReceipt: vi.fn().mockRejectedValue(new FreeeReceiptApiError('freee 400', 400)),
    };

    const res = await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    expect(res.issued).toBe(false);
    expect(res.code).toBe('issue_failed');
    expect(calls.save).toBe(0);
  });

  it('【重要】freee が 4xx で拒否したら発行権を返す（作られていないと断言できる）', async () => {
    const { db, calls } = makeDb();
    const issuer: FreeeReceiptIssuer = {
      createReceipt: vi
        .fn()
        .mockRejectedValue(new FreeeReceiptApiError('freee 400: 取引先を指定してください。', 400)),
    };

    await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    expect(calls.release).toBe(1);
  });

  it('URL が空で返ってきたら保存しない', async () => {
    const { db, calls } = makeDb();
    const issuer: FreeeReceiptIssuer = {
      createReceipt: vi.fn().mockResolvedValue({ receiptId: 1, receiptUrl: '' }),
    };

    await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    expect(calls.save).toBe(0);
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

describe('issueReceiptForBooking（作られたか不明な失敗）', () => {
  // ここが二重発行の最後の砦。「失敗＝作られていない」と決めつけると、
  // タイムアウト後の押し直しで2枚目が出る

  it('【重要】タイムアウトしたら発行権を保持する（押し直しで2枚目を作らせない）', async () => {
    const { db, calls } = makeDb();
    const timeout = Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
    const issuer: FreeeReceiptIssuer = { createReceipt: vi.fn().mockRejectedValue(timeout) };

    await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    expect(calls.release).toBe(0);
  });

  it('【重要】freee が 5xx でも発行権を保持する（処理途中で落ちた可能性がある）', async () => {
    const { db, calls } = makeDb();
    const issuer: FreeeReceiptIssuer = {
      createReceipt: vi.fn().mockRejectedValue(new FreeeReceiptApiError('freee 503', 503)),
    };

    await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    expect(calls.release).toBe(0);
  });

  it('通信断でも発行権を保持する', async () => {
    const { db, calls } = makeDb();
    const issuer: FreeeReceiptIssuer = {
      createReceipt: vi.fn().mockRejectedValue(new TypeError('fetch failed')),
    };

    await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    expect(calls.release).toBe(0);
  });

  it('結果が不明なときは「発行済みかも」と伝える', async () => {
    // 「発行できませんでした」だけだと運営者が押し直して2枚目を作る
    const { db } = makeDb();
    const issuer: FreeeReceiptIssuer = {
      createReceipt: vi.fn().mockRejectedValue(new TypeError('fetch failed')),
    };

    const res = await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    expect(res.error).toContain('発行済み');
  });

  it('トークンを取れなかったときは発行権を返す（freee を呼んでいない）', async () => {
    mockToken.mockRejectedValue(new Error('FREEE_TEMPORARILY_UNAVAILABLE'));
    const { db, calls } = makeDb();

    await issueReceiptForBooking(ENV, db, 1, 5, makeIssuer());

    expect(calls.release).toBe(1);
  });
});

describe('issueReceiptForBooking（2xx なのに URL が無い）', () => {
  it('【重要】発行権を返さない（freee 側には領収書が存在する）', async () => {
    const { db, calls } = makeDb();
    const issuer: FreeeReceiptIssuer = {
      createReceipt: vi.fn().mockResolvedValue({ receiptId: 777, receiptUrl: '' }),
    };

    await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    expect(calls.release).toBe(0);
    expect(calls.save).toBe(0);
  });

  it('【重要】「発行できていません」と言わない（押し直しを誘発するため）', async () => {
    // issued:false にすると画面が
    //   「領収書は発行できていません（freee 側に領収書は作成されましたが…）」
    // という自己矛盾した文になる。読んだ運営者は押し直し、5分後に本物の2枚目が出る
    const { db } = makeDb();
    const issuer: FreeeReceiptIssuer = {
      createReceipt: vi.fn().mockResolvedValue({ receiptId: 777, receiptUrl: '' }),
    };

    const res = await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    expect(res.issued).toBe(true);
    expect(res.error).toBeUndefined();
    expect(res.warning).toContain('作成されました');
    expect(res.warning).toContain('2枚目');
    expect(res.receiptUrl).toBe(null);
  });

  it('【重要】領収書IDをログに残す（迷子の1枚を特定する唯一の手がかり）', async () => {
    // receipt_id は個人情報ではないので出してよい。receipt_url は出さない
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db } = makeDb();
    const issuer: FreeeReceiptIssuer = {
      createReceipt: vi.fn().mockResolvedValue({ receiptId: 777, receiptUrl: '' }),
    };

    await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    const logged = spy.mock.calls.flat().join(' ');
    expect(logged).toContain('777');
    spy.mockRestore();
  });


});

describe('issueReceiptForBooking（宛名のフォールバック）', () => {
  it('【重要】名前が空でも友だちの表示名で発行する', async () => {
    // LIFF の getProfile() が失敗すると name は空文字で保存される（/join は body.name ?? ''）。
    // 管理画面には友だちの表示名が出ているのに領収書だけ出ない、という食い違いを防ぐ
    const { db } = makeDb({
      booking: booking({ receipt_name: null, name: '', friend_display_name: 'あきひさ' }),
    });
    const issuer = makeIssuer();

    const res = await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    expect(res.issued).toBe(true);
    const arg = vi.mocked(issuer.createReceipt).mock.calls[0][0];
    expect(arg.payeeName).toBe('あきひさ');
  });

  it('友だちの表示名も無ければ発行しない', async () => {
    const { db } = makeDb({
      booking: booking({ receipt_name: null, name: '', friend_display_name: null }),
    });
    const issuer = makeIssuer();

    const res = await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    expect(res.code).toBe('no_payee');
    expect(issuer.createReceipt).not.toHaveBeenCalled();
  });

  it('【重要】友だちの表示名を取れる SELECT を使う（SELECT * だと3段目が効かない）', async () => {
    const { db, sqls } = makeDb();

    await issueReceiptForBooking(ENV, db, 1, 5, makeIssuer());

    const select = sqls.find((q) => q.includes('FROM event_bookings b')) ?? '';
    expect(select).toContain('LEFT JOIN friends');
    expect(select).toContain('friend_display_name');
  });

  it('指定があれば友だちの表示名より優先する', async () => {
    const { db } = makeDb({
      booking: booking({ receipt_name: '株式会社サンプル', name: '', friend_display_name: 'あきひさ' }),
    });
    const issuer = makeIssuer();

    await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    const arg = vi.mocked(issuer.createReceipt).mock.calls[0][0];
    expect(arg.payeeName).toBe('株式会社サンプル');
  });
});

describe('issueReceiptForBooking（重複時の手がかり）', () => {
  it('【重要】保存できなかったとき領収書IDをログに残す', async () => {
    // ここが最も領収書IDを必要とする場面。重複した1枚が確実に存在するのに、
    // 宛名はログから伏せているので、IDが無いとどれを取り消せばいいか分からない
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db } = makeDb({ save: false, fresh: booking({ receipt_url: 'https://x/other' }) });
    const issuer: FreeeReceiptIssuer = {
      createReceipt: vi.fn().mockResolvedValue({ receiptId: 4242, receiptUrl: ISSUED_URL }),
    };

    await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    expect(spy.mock.calls.flat().join(' ')).toContain('4242');
    spy.mockRestore();
  });
});

describe('issueReceiptForBooking（但し書き）', () => {
  it('イベント名と「参加費として」を並べる', async () => {
    const { db } = makeDb();
    const issuer = makeIssuer();

    await issueReceiptForBooking(ENV, db, 1, 5, issuer, { eventTitle: '沖縄AI勉強会' });

    const arg = vi.mocked(issuer.createReceipt).mock.calls[0][0];
    expect(arg.description).toBe('沖縄AI勉強会 参加費として');
  });

  it('【重要】長いイベント名でも「参加費として」を落とさない', async () => {
    // 連結後に切ると目的語が消え、何の対価か分からない領収書になる。
    // events.title は長さ無制限の TEXT なので実際に起こりうる
    const { db } = makeDb();
    const issuer = makeIssuer();

    await issueReceiptForBooking(ENV, db, 1, 5, issuer, { eventTitle: 'あ'.repeat(300) });

    const arg = vi.mocked(issuer.createReceipt).mock.calls[0][0];
    expect(arg.description).toMatch(/参加費として$/);
    expect(Array.from(arg.description).length).toBeLessThanOrEqual(255);
  });

  it('イベント名が無ければ既定の但し書きにする', async () => {
    const { db } = makeDb();
    const issuer = makeIssuer();

    await issueReceiptForBooking(ENV, db, 1, 5, issuer);

    const arg = vi.mocked(issuer.createReceipt).mock.calls[0][0];
    expect(arg.description).toBe('イベント参加費として');
  });
});

describe('issueReceiptForBooking（発行中の案内）', () => {
  it('【重要】「ほかの操作で」と言わない（同じ人の押し直しが多いため）', async () => {
    // タイムアウト後に本人が押し直した場合、他の操作は動いていない。
    // 「待てば完了する」と読ませると、待った末にまた押して2枚目を出す
    const { db } = makeDb({ claim: false });

    const res = await issueReceiptForBooking(ENV, db, 1, 5, makeIssuer());

    expect(res.code).toBe('issue_in_progress');
    expect(res.error).not.toContain('ほかの操作');
    expect(res.error).toContain('再発行できません');
    expect(res.error).toContain('確認');
  });

  it('画面の文言が入れ子カッコにならない', async () => {
    // 画面は「領収書は発行できていません（〜）」の〜に入れる
    const { db } = makeDb({ claim: false });

    const res = await issueReceiptForBooking(ENV, db, 1, 5, makeIssuer());

    expect(res.error).not.toContain('（');
    expect(res.error).not.toContain('）');
  });
});

describe('issueReceiptForBooking（領収書番号の保存）', () => {
  it('【重要】freee の領収書番号を保存する（#47 の照合に必要）', async () => {
    // 保存し忘れると、共有リンクが本人のものか機械的に照合できなくなる
    const { db, sqls } = makeDb();

    await issueReceiptForBooking(ENV, db, 1, 5, makeIssuer());

    const sql = sqls.find((q) => q.includes('receipt_url = ?')) ?? '';
    expect(sql).toContain('receipt_number');
  });
});
