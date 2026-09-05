/**
 * 領収書の共有リンクを LINE で参加者に送る（Issue #47）。
 *
 * ## ⚠️ 送信先の取り違えは「誤配」では済まない
 *
 * 領収書には**宛名と金額**が載る。送信先を間違えると個人情報の漏洩になり、
 * しかも **LINE の送信は取り消せない**。だから宛先は当該予約の friend_id から
 * 厳密に引き、少しでも条件が揃わなければ送らない。
 *
 * ## 文面は Flex にしない
 *
 * カード型は「システムからの通知」に見える。領収書の送付は本来「人が送るもの」なので、
 * プレーンテキストで事務連絡として自然に読める形にする。
 */

import { formatJST } from '../utils/format-jst.js';
import { buildShareUrl } from '../utils/receipt-share-url.js';
import { resolveReceiptName } from './events.js';

/**
 * LINE 送信に使う最小のインターフェース。
 * `.claude/rules/api-coding.md` の「ミニマルな構造的インターフェース」に従う。
 */
export interface ReceiptLineClient {
  pushMessage(to: string, messages: { type: 'text'; text: string }[]): Promise<unknown>;
}

export interface ReceiptMessageParams {
  eventTitle: string | null;
  payeeName: string;
  shareUrl: string;
  /** 閲覧期限（DB の UTC 文字列）。null なら期限の案内を出さない */
  expiresAt: string | null;
}

/**
 * 期限の表示。
 *
 * ⚠️ **日付だけにしない。** 期限は UTC の瞬間なので、JST の暦日だけを出すと
 *    最大1日長く見える（例: 11-05 16:00 UTC は JST で 11/06 01:00。
 *    「11月6日を過ぎると」と書くと、11/6 の日中に開いた人が 410 を食らう）。
 *    時刻まで出せば、いつまで使えるかが正確に伝わる。
 */
function formatExpiry(expiresAt: string): string | null {
  const jst = formatJST(expiresAt);
  // formatJST は解釈できない値に '—' を返す。その文字列を案内に出さない
  return jst === '—' ? null : jst;
}

/**
 * 参加者に送る本文を組み立てる。
 *
 * ⚠️ 本文に出すのは**受信者自身の宛名だけ**。他の参加者の情報は絶対に入れない。
 *    宛名を書いておくと、万一取り違えても開いた PDF との食い違いに本人が気づける（第3.5層）。
 */
export function buildReceiptMessage(params: ReceiptMessageParams): string {
  const title = params.eventTitle?.trim();
  const greeting = title
    ? `${title}へのご参加ありがとうございました。`
    : 'ご参加ありがとうございました。';

  const lines = [
    greeting,
    '領収書を送付いたしますので、ご確認のほどよろしくお願いいたします🙇',
    '',
    `宛名：${params.payeeName}`,
    params.shareUrl,
  ];

  const expiry = params.expiresAt ? formatExpiry(params.expiresAt) : null;
  if (expiry) {
    lines.push('', `※${expiry} を過ぎるとダウンロードできなくなります`);
  }

  return lines.join('\n');
}

export type SendReceiptCode =
  | 'not_found'
  | 'event_mismatch'
  | 'cancelled'
  | 'no_share_url'
  | 'expired'
  | 'revoked'
  | 'already_sent'
  | 'no_friend'
  | 'no_payee'
  | 'unverified'
  | 'send_failed';

export interface SendReceiptResult {
  ok: boolean;
  code?: SendReceiptCode;
  error?: string;
}

interface BookingRow {
  id: number;
  event_id: number;
  friend_id: string | null;
  name: string;
  receipt_name: string | null;
  status: string;
  receipt_share_url: string | null;
  receipt_share_token: string | null;
  receipt_share_expires_at: string | null;
  receipt_share_revoked_at: string | null;
  receipt_share_verified_at: string | null;
  receipt_sent_at: string | null;
}

/** 期限切れか。解釈できない値は「切れている」側に倒す（黙って送らない） */
function isExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  const at = new Date(`${expiresAt.replace(' ', 'T')}Z`).getTime();
  if (Number.isNaN(at)) return true;
  return at <= Date.now();
}

export async function sendReceiptToParticipant(
  db: D1Database,
  line: ReceiptLineClient,
  workerBaseUrl: string,
  eventId: number,
  bookingId: number,
  /**
   * 運営者が「リンクを開いて宛名を確認した」と明示したか。
   * freee との照合が通っていない（receipt_share_verified_at が null）ときに必須。
   */
  confirmedUnverified = false,
): Promise<SendReceiptResult> {
  const booking = await db
    .prepare(
      `SELECT b.id, b.event_id, b.friend_id, b.name, b.receipt_name, b.status,
              b.receipt_share_url, b.receipt_share_token, b.receipt_share_expires_at,
              b.receipt_share_revoked_at, b.receipt_share_verified_at, b.receipt_sent_at,
              f.display_name AS friend_display_name
         FROM event_bookings b
         LEFT JOIN friends f ON f.id = b.friend_id
        WHERE b.id = ?`,
    )
    .bind(bookingId)
    .first<BookingRow & { friend_display_name: string | null }>();

  if (!booking) return { ok: false, code: 'not_found', error: '予約が見つかりませんでした。' };
  // ⚠️ 別イベントの予約に送れてしまうと、古いタブから押したときに取り違える
  if (booking.event_id !== eventId) {
    return { ok: false, code: 'event_mismatch', error: 'イベントが一致しません。' };
  }
  // ⚠️ 保存時にキャンセルを弾いていても、保存後にキャンセルされる。
  //    返金済みの予約に領収書を送ると、経理も参加者も混乱する
  if (booking.status === 'cancelled') {
    return { ok: false, code: 'cancelled', error: 'キャンセル済みの予約です。' };
  }
  // ⚠️ 無効化の判定を URL より先に置く。revokeReceiptShare は receipt_share_url を
  //    空にするので（同じリンクを正しい予約に登録し直せるようにするため）、
  //    URL を先に見ると「まだ登録されていません」と出て、運営者が状況を誤解する。
  //    リダイレクタ（routes/receipt.ts）と同じ順序に揃えること。
  if (booking.receipt_share_revoked_at) {
    return {
      ok: false,
      code: 'revoked',
      error: 'このリンクは無効化されています。freee で作り直して貼り直してください。',
    };
  }
  if (!booking.receipt_share_url || !booking.receipt_share_token) {
    return { ok: false, code: 'no_share_url', error: '共有リンクがまだ登録されていません。' };
  }
  // 届いても開けないものを送らない
  if (isExpired(booking.receipt_share_expires_at)) {
    return {
      ok: false,
      code: 'expired',
      error: '共有リンクの期限が切れています。freee で作り直して貼り直してください。',
    };
  }
  if (booking.receipt_sent_at) {
    return { ok: false, code: 'already_sent', error: '既に送信済みです。' };
  }
  // ⚠️ 宛先を特定できないまま送らない。無言で握りつぶさず理由を返す
  if (!booking.friend_id) {
    return {
      ok: false,
      code: 'no_friend',
      error: 'LINE の友だちが紐づいていないため送信できません。先に友だちを紐付けてください。',
    };
  }

  // ⚠️ **未照合のまま送らせない。サーバー側で止める。**
  //    取り違え対策の他の層（一意制約・freee 照合・無効化）はすべてサーバー側なのに、
  //    「開いて確認した」だけが画面の state だった。古いタブ・別のスタッフ・
  //    API の直叩きで迂回でき、しかも LINE の送信は取り消せない。
  if (!booking.receipt_share_verified_at && !confirmedUnverified) {
    return {
      ok: false,
      code: 'unverified',
      error:
        'freee と照合できていないリンクです。'
        + 'リンクを開いて宛名を確認し、確認欄にチェックしてから送信してください。',
    };
  }

  const payeeName = resolveReceiptName(booking);
  if (!payeeName) {
    return { ok: false, code: 'no_payee', error: '宛名を決められませんでした。' };
  }

  const friend = await db
    .prepare('SELECT line_user_id FROM friends WHERE id = ?')
    .bind(booking.friend_id)
    .first<{ line_user_id: string }>();

  if (!friend?.line_user_id) {
    return {
      ok: false,
      code: 'no_friend',
      error: 'LINE の友だちが見つかりませんでした。',
    };
  }

  const event = await db
    .prepare('SELECT title FROM events WHERE id = ?')
    .bind(eventId)
    .first<{ title: string }>();

  const text = buildReceiptMessage({
    eventTitle: event?.title ?? null,
    payeeName,
    // ⚠️ freee の URL を直接送らない。誤配に気づいたときに止められなくなる
    shareUrl: buildShareUrl(workerBaseUrl, booking.receipt_share_token),
    expiresAt: booking.receipt_share_expires_at,
  });

  // ⚠️ **送る前に送信権を取る**。上の receipt_sent_at チェックは SELECT を見た
  //    「読んでから書く」判定なので、2台の端末で同時に押すと両方すり抜けて2通届く。
  //    LINE の送信は取り消せないので、先に印を立てて、取れた1本だけが送る。
  const claimed = await db
    .prepare(
      `UPDATE event_bookings
          SET receipt_sent_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND receipt_sent_at IS NULL
      RETURNING receipt_sent_at`,
    )
    .bind(bookingId)
    .first<{ receipt_sent_at: string }>();

  if (!claimed) return { ok: false, code: 'already_sent', error: '既に送信済みです。' };

  try {
    await line.pushMessage(friend.line_user_id, [{ type: 'text', text }]);
  } catch (err) {
    // 送れなかったので送信権を返す。返さないと二度と送れなくなる。
    // ⚠️ 自分が立てた印のときだけ消す（別の送信が入っていたらそれを消さない）
    // ⚠️ ここで例外が出ても握る。投げるとルートが 500 を返し、
    //    運営者には原因が伝わらないうえ「送信済み」のまま固定されてしまう
    try {
      await db
        .prepare(
          `UPDATE event_bookings
              SET receipt_sent_at = NULL, updated_at = datetime('now')
            WHERE id = ? AND receipt_sent_at = ?`,
        )
        .bind(bookingId, claimed.receipt_sent_at)
        .run();
    } catch (rollbackErr) {
      console.error('[receipt] 送信権を返せませんでした（要手動確認）:', bookingId, rollbackErr);
    }
    console.error('[receipt] LINE 送信に失敗しました:', bookingId, err);
    return { ok: false, code: 'send_failed', error: '送信できませんでした。時間をおいて再度お試しください。' };
  }

  // ⚠️ 共有 URL・トークンをログに出さない（Workers Logs の閲覧権限だけで領収書が開ける）
  console.log('[receipt] 領収書を送信しました:', bookingId);
  return { ok: true };
}
