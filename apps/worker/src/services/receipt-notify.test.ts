import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildReceiptMessage, sendReceiptToParticipant } from './receipt-notify.js';

const SHARE_TOKEN = 'tok-abc';
const WORKER_URL = 'https://api.walover-co.work';

describe('buildReceiptMessage（文面）', () => {
  const base = {
    eventTitle: 'もくもく会',
    payeeName: 'テスト株式会社',
    shareUrl: 'https://api.walover-co.work/receipt/tok-abc',
    expiresAt: '2026-11-05 09:00:00',
  };

  it('人が送っているように読める（テンプレートどおり）', () => {
    expect(buildReceiptMessage(base)).toBe(
      'もくもく会へのご参加ありがとうございました。\n'
      + '領収書を送付いたしますので、ご確認のほどよろしくお願いいたします🙇\n'
      + '\n'
      + '宛名：テスト株式会社\n'
      + 'https://api.walover-co.work/receipt/tok-abc\n'
      + '\n'
      + '※11/05(木) 18:00 を過ぎるとダウンロードできなくなります',
    );
  });

  it('【重要】プレースホルダが残らない', () => {
    // [イベント名] のような文字列がそのまま参加者に届く壊れ方を防ぐ
    const msg = buildReceiptMessage(base);
    expect(msg).not.toMatch(/\[[^\]]+\]/);
  });

  it('期限は JST の読みやすい表記にする（ISO を出さない）', () => {
    // DB は UTC。そのまま出すと「2026-11-05T00:00:00.000Z」になって読めない
    const msg = buildReceiptMessage({ ...base, expiresAt: '2026-11-04 16:00:00' });
    // UTC 16:00 = JST 翌日 01:00
    expect(msg).toContain('11/05(木) 01:00');
    expect(msg).not.toContain('Z');
  });

  it('【重要】期限を日付だけにしない（最大1日長く見えてしまう）', () => {
    // 11-05 16:00 UTC は JST で 11/06 01:00。日付だけ出して「11月6日を過ぎると」と
    // 書くと、11/6 の日中に開いた人が 410 を食らう
    const msg = buildReceiptMessage({ ...base, expiresAt: '2026-11-05 16:00:00' });

    expect(msg).toContain('01:00');
    expect(msg).not.toMatch(/※\d+月\d+日を過ぎると/);
  });

  it('解釈できない期限は案内に出さない', () => {
    // '—' がそのまま参加者に届く壊れ方を防ぐ
    const msg = buildReceiptMessage({ ...base, expiresAt: 'not a date' });

    expect(msg).not.toContain('—');
    expect(msg).not.toContain('ダウンロードできなくなります');
  });

  it('イベント名が無くても文が壊れない', () => {
    const msg = buildReceiptMessage({ ...base, eventTitle: null });
    expect(msg).toContain('領収書を送付いたします');
    expect(msg).not.toContain('null');
  });

  it('期限が無ければ期限の行を出さない', () => {
    const msg = buildReceiptMessage({ ...base, expiresAt: null });
    expect(msg).not.toContain('ダウンロードできなくなります');
    expect(msg).toContain('宛名：テスト株式会社');
  });

  it('【重要】他の参加者の情報を含まない', () => {
    // 本文に出すのは受信者自身の宛名だけ（第3.5層）
    const msg = buildReceiptMessage(base);
    expect(msg).toContain('テスト株式会社');
    expect(msg.match(/宛名：/g)).toHaveLength(1);
  });

  it('長いイベント名でも文が壊れない', () => {
    const msg = buildReceiptMessage({ ...base, eventTitle: 'あ'.repeat(300) });
    expect(msg).toContain('へのご参加ありがとうございました');
    expect(msg).toContain('宛名：');
  });
});

// ────────────────────────────────────────────────

function booking(overrides: Record<string, unknown> = {}) {
  return {
    id: 5,
    event_id: 1,
    friend_id: 'f1',
    name: 'あきひさ',
    receipt_name: 'テスト株式会社',
    status: 'confirmed',
    receipt_share_url: 'https://invoice.secure.freee.co.jp/ivex/dl/x',
    receipt_share_token: SHARE_TOKEN,
    receipt_share_expires_at: '2099-01-01 00:00:00',
    receipt_share_revoked_at: null,
    receipt_share_verified_at: '2026-09-06 05:00:00',
    receipt_sent_at: null,
    ...overrides,
  };
}

/** 送信権を取ったときに立つ印の時刻 */
const CLAIMED_AT = '2026-09-06 05:00:00';

interface DbOptions {
  booking?: Record<string, unknown> | null;
  /** 送信権（CAS）を取れるか。false = 別のリクエストが先に取った */
  claimTaken?: boolean;
  /** friends テーブルから引ける line_user_id */
  lineUserId?: string | null;
  event?: { title: string } | null;
}

function makeDb(opts: DbOptions = {}) {
  const sqls: string[] = [];
  const row = opts.booking === undefined ? booking() : opts.booking;
  const bound: unknown[][] = [];

  const db = {
    prepare: vi.fn().mockImplementation((sql: string) => {
      sqls.push(sql);
      const stmt: Record<string, unknown> = {};
      stmt.bind = vi.fn().mockImplementation((...a: unknown[]) => { bound.push(a); return stmt; });
      stmt.first = vi.fn().mockImplementation(async () => {
        if (sql.includes('FROM friends')) {
          return opts.lineUserId === undefined
            ? { line_user_id: 'U123' }
            : opts.lineUserId === null ? null : { line_user_id: opts.lineUserId };
        }
        if (sql.includes('FROM events')) return opts.event === undefined ? { title: 'もくもく会' } : opts.event;
        if (sql.includes('UPDATE')) {
          // 送信権の取得（CAS）は receipt_sent_at を返す
          return opts.claimTaken === false ? null : { id: 5, receipt_sent_at: CLAIMED_AT };
        }
        return row;
      });
      stmt.run = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
      return stmt;
    }),
  } as unknown as D1Database;

  return { db, sqls, bound };
}

function makeLine() {
  return { pushMessage: vi.fn().mockResolvedValue(undefined) };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('sendReceiptToParticipant（送信）', () => {
  it('当該予約の友だちに送る', async () => {
    const { db } = makeDb();
    const line = makeLine();

    const res = await sendReceiptToParticipant(db, line, WORKER_URL, 1, 5);

    expect(res.ok).toBe(true);
    expect(line.pushMessage).toHaveBeenCalledWith('U123', [
      { type: 'text', text: expect.stringContaining('領収書を送付いたします') },
    ]);
  });

  it('【重要】参加者に送るのは自前の URL（freee の URL を直接送らない）', async () => {
    // freee の URL を送ると、誤配に気づいても止められない
    const { db } = makeDb();
    const line = makeLine();

    await sendReceiptToParticipant(db, line, WORKER_URL, 1, 5);

    const text = line.pushMessage.mock.calls[0][1][0].text as string;
    expect(text).toContain(`${WORKER_URL}/receipt/${SHARE_TOKEN}`);
    expect(text).not.toContain('invoice.secure.freee.co.jp');
  });

  it('【重要】friend_id が null なら送信しない', async () => {
    // 宛先を特定できない。無言で握りつぶさず理由を返す
    const { db } = makeDb({ booking: booking({ friend_id: null }) });
    const line = makeLine();

    const res = await sendReceiptToParticipant(db, line, WORKER_URL, 1, 5);

    expect(res.ok).toBe(false);
    expect(res.code).toBe('no_friend');
    expect(line.pushMessage).not.toHaveBeenCalled();
  });

  it('友だちが見つからなければ送信しない', async () => {
    const { db } = makeDb({ lineUserId: null });
    const line = makeLine();

    const res = await sendReceiptToParticipant(db, line, WORKER_URL, 1, 5);

    expect(res.code).toBe('no_friend');
    expect(line.pushMessage).not.toHaveBeenCalled();
  });

  it('【重要】二重送信しない', async () => {
    const { db } = makeDb({ booking: booking({ receipt_sent_at: '2026-09-06 00:00:00' }) });
    const line = makeLine();

    const res = await sendReceiptToParticipant(db, line, WORKER_URL, 1, 5);

    expect(res.code).toBe('already_sent');
    expect(line.pushMessage).not.toHaveBeenCalled();
  });

  it('共有リンクが未登録なら送信しない', async () => {
    const { db } = makeDb({ booking: booking({ receipt_share_url: null, receipt_share_token: null }) });
    const line = makeLine();

    const res = await sendReceiptToParticipant(db, line, WORKER_URL, 1, 5);

    expect(res.code).toBe('no_share_url');
    expect(line.pushMessage).not.toHaveBeenCalled();
  });

  it('【重要】期限切れのリンクは送信しない', async () => {
    // 届いても開けない。参加者に無駄な期待をさせない
    const { db } = makeDb({ booking: booking({ receipt_share_expires_at: '2020-01-01 00:00:00' }) });
    const line = makeLine();

    const res = await sendReceiptToParticipant(db, line, WORKER_URL, 1, 5);

    expect(res.code).toBe('expired');
    expect(line.pushMessage).not.toHaveBeenCalled();
  });

  it('【重要】無効化済みのリンクは送信せず、無効化されたと伝える', async () => {
    // ⚠️ fixture は **revokeReceiptShare が実際に作る状態** にする。
    //    「revoked_at あり ＋ url も残っている」はありえず、その形でテストしていたため
    //    判定順のバグ（no_share_url で先に止まる）を検出できていなかった
    const { db } = makeDb({
      booking: booking({
        receipt_share_revoked_at: '2026-09-06 00:00:00',
        receipt_share_url: null,
        receipt_share_verified_at: null,
      }),
    });
    const line = makeLine();

    const res = await sendReceiptToParticipant(db, line, WORKER_URL, 1, 5);

    expect(res.code).toBe('revoked');
    expect(res.error).toContain('無効化');
    expect(line.pushMessage).not.toHaveBeenCalled();
  });

  it('イベントIDが一致しなければ送信しない', async () => {
    const { db } = makeDb({ booking: booking({ event_id: 99 }) });
    const line = makeLine();

    const res = await sendReceiptToParticipant(db, line, WORKER_URL, 1, 5);

    expect(res.code).toBe('event_mismatch');
    expect(line.pushMessage).not.toHaveBeenCalled();
  });

  it('送信できたら receipt_sent_at を記録する', async () => {
    const { db, sqls } = makeDb();
    const line = makeLine();

    await sendReceiptToParticipant(db, line, WORKER_URL, 1, 5);

    // ⚠️ SELECT の列名にも receipt_sent_at が出るので、UPDATE であることまで見る
    expect(sqls.some((q) => q.includes('UPDATE') && q.includes('receipt_sent_at = '))).toBe(true);
  });

  it('【重要】LINE 送信が失敗したら送信権を返す（再送できる）', async () => {
    const { db, sqls } = makeDb();
    const line = { pushMessage: vi.fn().mockRejectedValue(new Error('LINE 500')) };

    const res = await sendReceiptToParticipant(db, line, WORKER_URL, 1, 5);

    expect(res.ok).toBe(false);
    expect(res.code).toBe('send_failed');
    // 送信権を返さないと二度と送れなくなる
    expect(sqls.some((q) => q.includes('receipt_sent_at = NULL'))).toBe(true);
  });

  it('【重要】共有 URL とトークンをログに出さない', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { db } = makeDb();

    await sendReceiptToParticipant(db, makeLine(), WORKER_URL, 1, 5);

    const logged = spy.mock.calls.flat().join(' ');
    expect(logged).not.toContain(SHARE_TOKEN);
    expect(logged).not.toContain('invoice.secure.freee.co.jp');
    spy.mockRestore();
  });
});

describe('sendReceiptToParticipant（同時押しと状態変化）', () => {
  it('【重要】送る前に送信権を取る（2台で同時に押しても1通）', async () => {
    // 上の receipt_sent_at チェックは SELECT を見た「読んでから書く」判定なので、
    // これが無いと2台の端末で両方すり抜けて2通届く。LINE の送信は取り消せない
    const { db, sqls } = makeDb();

    await sendReceiptToParticipant(db, makeLine(), WORKER_URL, 1, 5);

    const claim = sqls.find((q) => q.includes('UPDATE') && q.includes('receipt_sent_at = ')) ?? '';
    expect(claim).toContain('receipt_sent_at IS NULL');
  });

  it('【重要】送信権を取れなければ送らない', async () => {
    const { db, claimTaken } = { ...makeDb({ claimTaken: false }), claimTaken: false };
    const line = makeLine();

    const res = await sendReceiptToParticipant(db, line, WORKER_URL, 1, 5);

    expect(res.code).toBe('already_sent');
    expect(line.pushMessage).not.toHaveBeenCalled();
  });

  it('送信権を返すときは自分が立てた印だけ消す', async () => {
    // 条件を id だけにすると、別の送信が立てた印まで消してしまう
    const { db, bound } = makeDb();
    const line = { pushMessage: vi.fn().mockRejectedValue(new Error('LINE 500')) };

    await sendReceiptToParticipant(db, line, WORKER_URL, 1, 5);

    expect(bound.flat()).toContain(CLAIMED_AT);
  });

  it('【重要】保存後にキャンセルされた予約には送らない', async () => {
    // 返金済みの予約に領収書を送ると、経理も参加者も混乱する
    const { db } = makeDb({ booking: booking({ status: 'cancelled' }) });
    const line = makeLine();

    const res = await sendReceiptToParticipant(db, line, WORKER_URL, 1, 5);

    expect(res.code).toBe('cancelled');
    expect(line.pushMessage).not.toHaveBeenCalled();
  });
});

describe('sendReceiptToParticipant（未照合の送信をサーバーで止める）', () => {
  it('【重要】照合できていないリンクは、確認なしでは送れない', async () => {
    // 取り違え対策の他の層はすべてサーバー側なのに、「開いて確認した」だけが
    // 画面の state だった。古いタブ・別のスタッフ・API 直叩きで迂回できてしまう
    const { db } = makeDb({ booking: booking({ receipt_share_verified_at: null }) });
    const line = makeLine();

    const res = await sendReceiptToParticipant(db, line, WORKER_URL, 1, 5);

    expect(res.ok).toBe(false);
    expect(res.code).toBe('unverified');
    expect(line.pushMessage).not.toHaveBeenCalled();
  });

  it('運営者が確認したと明示すれば送れる', async () => {
    const { db } = makeDb({ booking: booking({ receipt_share_verified_at: null }) });
    const line = makeLine();

    const res = await sendReceiptToParticipant(db, line, WORKER_URL, 1, 5, true);

    expect(res.ok).toBe(true);
    expect(line.pushMessage).toHaveBeenCalled();
  });

  it('照合済みなら確認は要らない', async () => {
    // 機械で照合できたのに人にも確認させると、慣れて素通しするようになる
    const { db } = makeDb();
    const line = makeLine();

    const res = await sendReceiptToParticipant(db, line, WORKER_URL, 1, 5);

    expect(res.ok).toBe(true);
  });
});
