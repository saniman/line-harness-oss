/**
 * 現金を受け取った予約に対して、freee で領収書を発行する。
 *
 * 呼び出し元は「現金受領」ボタン（POST /api/events/:id/bookings/:bookingId/cash-received）。
 *
 * ## 設計方針: 現金の受領記録と、領収書の発行を切り離す
 *
 * 現金は**物理的に受け取っている**。freee が落ちていても、宛名が空でも、その事実は変わらない。
 * ここで例外を投げて受領記録ごと巻き戻すと、「お金は受け取ったのに記録が無い」状態になり、
 * 経理が合わなくなる。だから **この関数は例外を投げない**。発行できなければ理由を返すだけにして、
 * 受領の記録は残す。未発行分の再送は #48 で扱う。
 */

import type { Env } from '../index.js';
import { getValidAccessTokenFreee } from './freee-oauth.js';
import { getEventBookingById, resolveReceiptName } from './events.js';
import { formatJstDate } from '../utils/format-jst.js';
import { freeeReceiptIssuer, type FreeeReceiptIssuer } from './freee-receipt-client.js';

export type { FreeeReceiptIssuer } from './freee-receipt-client.js';

/** 発行できなかった理由。文言ではなくこのコードで分岐する */
export type ReceiptIssueCode =
  | 'not_found'
  | 'event_mismatch'
  | 'cancelled'
  | 'not_received'
  | 'no_payee'
  | 'no_amount'
  | 'bad_date'
  | 'freee_unavailable'
  | 'issue_failed';

export interface IssueReceiptResult {
  /** 領収書の URL が確定しているか（既発行を含む） */
  issued: boolean;
  /** 既に発行済みで、今回は何もしなかった */
  alreadyIssued?: boolean;
  receiptUrl?: string | null;
  code?: ReceiptIssueCode;
  /** 管理画面に出す説明（参加者には見せない） */
  error?: string;
}

export interface IssueReceiptOptions {
  /** 但し書き・件名に使うイベント名 */
  eventTitle?: string;
}

/** 但し書き。「〜として」まで入れて領収書らしくする */
function buildDescription(eventTitle: string | undefined): string {
  const title = eventTitle?.trim();
  return title ? `${title} 参加費として` : 'イベント参加費として';
}

export async function issueReceiptForBooking(
  env: Env['Bindings'],
  db: D1Database,
  eventId: number,
  bookingId: number,
  issuer: FreeeReceiptIssuer = freeeReceiptIssuer,
  options: IssueReceiptOptions = {},
): Promise<IssueReceiptResult> {
  const booking = await getEventBookingById(db, bookingId);
  if (!booking) {
    return { issued: false, code: 'not_found', error: '予約が見つかりませんでした。' };
  }
  if (booking.event_id !== eventId) {
    return { issued: false, code: 'event_mismatch', error: 'イベントが一致しません。' };
  }

  // ⚠️ 冪等ガード。ここを外すと、ボタン連打・#48 のリトライ・管理画面の二重タブで
  //    同じ参加者に領収書が2枚発行される（freee 上は取消が必要な経理事故になる）。
  if (booking.receipt_url) {
    return { issued: true, alreadyIssued: true, receiptUrl: booking.receipt_url };
  }

  if (booking.status === 'cancelled') {
    return { issued: false, code: 'cancelled', error: 'キャンセル済みの予約です。' };
  }
  // 受け取っていない金額の領収書を出してはいけない
  if (!booking.cash_received_at) {
    return { issued: false, code: 'not_received', error: 'まだ現金を受領していません。' };
  }

  // 宛名は「指定 → 申込時の氏名」の順に解決する。全部空なら発行しない。
  // 空欄の宛名で発行すると freee 側で作り直しになるため、未発行のまま #48 に回す。
  const payeeName = resolveReceiptName(booking);
  if (!payeeName) {
    return { issued: false, code: 'no_payee', error: '領収書の宛名を決められませんでした。' };
  }

  // amount は現金受領時に events.price から焼き込まれる（markCashReceived 参照）。
  // それでも null なら、イベントの価格が未設定だった等なので発行しない。
  if (booking.amount == null || booking.amount <= 0) {
    return { issued: false, code: 'no_amount', error: '領収書に載せる金額がありません。' };
  }

  const issueDate = formatJstDate(booking.cash_received_at);
  if (!issueDate) {
    return { issued: false, code: 'bad_date', error: '受領日時を解釈できませんでした。' };
  }

  let accessToken: string;
  let companyId: number;
  try {
    ({ accessToken, companyId } = await getValidAccessTokenFreee(env, db));
  } catch (err) {
    // 未連携・要再認可・一時障害はどれも「今は出せない」。受領記録は壊さずに理由だけ返す。
    console.error('[freee] 領収書の発行前にトークンを取得できませんでした:', bookingId, err);
    return {
      issued: false,
      code: 'freee_unavailable',
      error: 'freee に接続できませんでした。連携状態を確認してください。',
    };
  }

  const partnerId = Number(env.FREEE_PARTNER_ID);
  let result: { receiptUrl: string };
  try {
    result = await issuer.createReceipt({
      accessToken,
      companyId,
      payeeName,
      amount: booking.amount,
      issueDate,
      description: buildDescription(options.eventTitle),
      subject: options.eventTitle?.trim() || 'イベント参加費',
      partnerId: Number.isInteger(partnerId) && partnerId > 0 ? partnerId : undefined,
      partnerCode: env.FREEE_PARTNER_CODE || undefined,
    });
  } catch (err) {
    // ⚠️ ここで throw しない（受領記録を巻き戻さないため。冒頭のコメント参照）
    console.error('[freee] 領収書の発行に失敗しました:', bookingId, err);
    return { issued: false, code: 'issue_failed', error: '領収書を発行できませんでした。' };
  }

  // URL が取れなければ保存しない。空文字を入れると上の冪等ガードが効かないまま
  // 「発行済み扱いの空 URL」になり、再発行も参加者への送付もできなくなる。
  if (!result.receiptUrl) {
    console.error('[freee] 領収書は作成されたが URL が取れませんでした:', bookingId);
    return { issued: false, code: 'issue_failed', error: '領収書の URL を取得できませんでした。' };
  }

  // ⚠️ receipt_url をログに出さない。URL を知っていれば誰でも開ける可能性があるため、
  //    ログに残すのは booking_id だけにする。
  await db
    .prepare(
      `UPDATE event_bookings
          SET receipt_url = ?,
              receipt_issued_at = datetime('now'),
              updated_at = datetime('now')
        WHERE id = ?
          AND receipt_url IS NULL`,
    )
    .bind(result.receiptUrl, bookingId)
    .run();

  console.log('[freee] 領収書を発行しました:', bookingId);
  return { issued: true, receiptUrl: result.receiptUrl };
}
