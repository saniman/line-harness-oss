import { describe, it, expect, vi, beforeEach } from 'vitest';
import { notifyBookingCancelled, buildCancelledMessage } from './booking-cancel-notify.js';

describe('buildCancelledMessage（文面）', () => {
  it('イベント名を入れて、事務連絡として自然に読める', () => {
    expect(buildCancelledMessage('もくもく会')).toBe(
      'もくもく会 のお申し込みを取り消しました。\n'
      + 'ご不明な点がありましたら、お気軽にご連絡ください。',
    );
  });

  it('イベント名が無くても文が壊れない', () => {
    const msg = buildCancelledMessage(null);
    expect(msg).toContain('お申し込みを取り消しました');
    expect(msg).not.toContain('null');
  });

  it('【重要】現金の取り消しでは返金に触れない', () => {
    // 現金は対面で返す運用。ここで「返金します」と書くと二重に約束したことになる
    const msg = buildCancelledMessage('もくもく会');
    expect(msg).not.toContain('返金');
    expect(msg).not.toContain('¥');
  });

  it('【重要】Stripe の返金が走ったときだけ返金を案内する', () => {
    // 運営者経路は LIFF の返金案内画面を通らないので、ここで伝えないと届かない
    const msg = buildCancelledMessage('もくもく会', true);
    expect(msg).toContain('ご返金の手続きを開始しました');
    expect(msg).not.toContain('¥');
  });
});

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 5,
    friend_id: 'f1',
    line_user_id: 'U123',
    title: 'もくもく会',
    ...overrides,
  };
}

function makeDb(found: Record<string, unknown> | null = row()) {
  const sqls: string[] = [];
  const db = {
    prepare: vi.fn().mockImplementation((sql: string) => {
      sqls.push(sql);
      return {
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue(found),
      };
    }),
  } as unknown as D1Database;
  return { db, sqls };
}

function makeLine() {
  return { pushMessage: vi.fn().mockResolvedValue(undefined) };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('notifyBookingCancelled（送信）', () => {
  it('当該予約の友だちに送る', async () => {
    const { db } = makeDb();
    const line = makeLine();

    const sent = await notifyBookingCancelled(db, line, 5);

    expect(sent).toBe(true);
    expect(line.pushMessage).toHaveBeenCalledWith('U123', [
      { type: 'text', text: expect.stringContaining('取り消しました') },
    ]);
  });

  it('【重要】友だちが紐づいていなければ送らない', async () => {
    // 宛先を特定できないまま送ると誤配になる
    const { db } = makeDb(row({ friend_id: null, line_user_id: null }));
    const line = makeLine();

    const sent = await notifyBookingCancelled(db, line, 5);

    expect(sent).toBe(false);
    expect(line.pushMessage).not.toHaveBeenCalled();
  });

  it('予約が見つからなければ送らない', async () => {
    const { db } = makeDb(null);
    const line = makeLine();

    expect(await notifyBookingCancelled(db, line, 5)).toBe(false);
    expect(line.pushMessage).not.toHaveBeenCalled();
  });

  it('【重要】送信に失敗しても例外を投げない（取り消しは成立している）', async () => {
    // ここで投げると、キャンセル済みなのにルートが 500 を返してしまう
    const { db } = makeDb();
    const line = { pushMessage: vi.fn().mockRejectedValue(new Error('LINE 500')) };

    await expect(notifyBookingCancelled(db, line, 5)).resolves.toBe(false);
  });

  it('宛先は予約に紐づく友だちから引く（取り違えない）', async () => {
    const { db, sqls } = makeDb();

    await notifyBookingCancelled(db, makeLine(), 5);

    const sql = sqls[0] ?? '';
    expect(sql).toContain('event_bookings');
    expect(sql).toContain('friends');
    expect(sql).toContain('WHERE b.id = ?');
  });
});

describe('notifyBookingCancelled（返金の案内）', () => {
  it('返金が走ったときだけ本文に案内を入れる', async () => {
    const { db } = makeDb();
    const line = makeLine();

    await notifyBookingCancelled(db, line, 5, true);

    const text = line.pushMessage.mock.calls[0][1][0].text as string;
    expect(text).toContain('ご返金の手続きを開始しました');
  });

  it('返金が走っていなければ入れない', async () => {
    const { db } = makeDb();
    const line = makeLine();

    await notifyBookingCancelled(db, line, 5);

    expect(line.pushMessage.mock.calls[0][1][0].text).not.toContain('返金');
  });
});
