/**
 * freee の領収書「共有リンク」を運営者が登録し、参加者へ送れる状態にする（Issue #47）。
 *
 * ## なぜ手動なのか
 *
 * freee請求書 API には領収書の送付・共有のエンドポイントが無く、共有リンクは
 * **画面操作でしか生成できない**（API から読むこともできない）。そのため
 * 「freee で共有リンクを作って貼る」だけを運営者にやってもらう。
 *
 * ## ⚠️ 取り違えは個人情報の漏洩
 *
 * A さんの領収書リンクを B さんに送ると、A の**氏名と金額**が B に渡る。
 * しかも LINE の送信は取り消せない。過去に実際に起きているので、多層で守る。
 *
 *   第1層 同じリンクを2人に登録できない（DB の一意制約）
 *   第4層 freee に問い合わせて領収書番号を照合する（receipt-share-verify.ts）
 *
 * ここはその1と4を担当する。第2層（無効化できるリダイレクタ）と
 * 第3層（ウィザードUI）はルート・管理画面側。
 */

import { parseShareUrl } from '../utils/receipt-share-url.js';
import { verifyShareUrl, freeeShareVerifier, type ShareFileFetcher } from './receipt-share-verify.js';

/** freee の共有リンクの既定の閲覧期限（日）。freee 側の初期値に合わせる */
export const SHARE_EXPIRY_DAYS = 60;

export type SaveShareUrlCode =
  | 'invalid_url'
  | 'not_found'
  | 'event_mismatch'
  | 'not_issued'
  | 'cancelled'
  | 'receipt_mismatch'
  | 'link_not_found'
  | 'duplicate'
  | 'save_failed';

export interface SaveShareUrlResult {
  ok: boolean;
  code?: SaveShareUrlCode;
  /** 運営者に出す説明（参加者には見せない） */
  error?: string;
  /** 参加者に送る URL のトークン */
  token?: string;
  /** freee との照合が通ったか。false = 未検証（人の確認に委ねる） */
  verified?: boolean;
}

interface BookingRow {
  id: number;
  event_id: number;
  name: string;
  status: string;
  receipt_url: string | null;
  receipt_number: string | null;
  receipt_share_url: string | null;
}

/** 一意制約に当たったかを、DB のメッセージに依存しすぎず判定する */
function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed/i.test(msg);
}

export async function saveReceiptShareUrl(
  db: D1Database,
  eventId: number,
  bookingId: number,
  input: string,
  fetcher: ShareFileFetcher = freeeShareVerifier,
): Promise<SaveShareUrlResult> {
  // ⚠️ 形式の検証は必ずサーバー側で行う。画面だけの検証は API 直叩きで迂回できる。
  //    ここで report_url（運営者用・ログイン必須）を弾くのが最重要
  //    ——管理画面に両方並ぶので、実際に最も混同しやすい。
  const parsed = parseShareUrl(input);
  if (!parsed.ok) {
    return {
      ok: false,
      code: 'invalid_url',
      error:
        'freee の共有リンクではありません。'
        + 'freee で領収書を開き「URL共有」で作ったリンク'
        + '（https://invoice.secure.freee.co.jp/ivex/dl/... の形）を貼ってください。',
    };
  }

  const booking = await db
    .prepare(
      `SELECT id, event_id, name, status, receipt_url, receipt_number, receipt_share_url
         FROM event_bookings WHERE id = ?`,
    )
    .bind(bookingId)
    .first<BookingRow>();

  if (!booking) return { ok: false, code: 'not_found', error: '予約が見つかりませんでした。' };
  if (booking.event_id !== eventId) {
    return { ok: false, code: 'event_mismatch', error: 'イベントが一致しません。' };
  }
  if (booking.status === 'cancelled') {
    return { ok: false, code: 'cancelled', error: 'キャンセル済みの予約です。' };
  }
  // freee に領収書が無いのに共有リンクだけある、という状態を作らない
  if (!booking.receipt_url) {
    return {
      ok: false,
      code: 'not_issued',
      error: 'この予約はまだ領収書が発行されていません。先に「現金受領」を記録してください。',
    };
  }

  // ── 第4層: freee に問い合わせて「本当にこの人の領収書か」を照合する ──
  const verification = await verifyShareUrl(parsed.uuid, booking.receipt_number, fetcher);

  if (verification.result === 'mismatch') {
    return {
      ok: false,
      code: 'receipt_mismatch',
      error:
        `このリンクは別の方の領収書です（${verification.receiptNumber}）。`
        + `${booking.name}さんの領収書は ${booking.receipt_number} です。`
        + 'freee で開き直してコピーしてください。',
    };
  }
  if (verification.result === 'not_found') {
    return {
      ok: false,
      code: 'link_not_found',
      error: 'このリンクは無効か、期限が切れています。freee で共有リンクを作り直してください。',
    };
  }
  const verified = verification.result === 'match';

  // 既存のトークンがあれば使い回す（貼り直しで参加者に送った URL が死なないように）
  const token = crypto.randomUUID();

  try {
    const saved = await db
      .prepare(
        `UPDATE event_bookings
            SET receipt_share_url = ?,
                receipt_share_expires_at = datetime('now', ?),
                receipt_share_verified_at = ${verified ? "datetime('now')" : 'NULL'},
                receipt_share_token = COALESCE(receipt_share_token, ?),
                receipt_share_revoked_at = NULL,
                updated_at = datetime('now')
          WHERE id = ?
        RETURNING id, receipt_share_token`,
      )
      .bind(parsed.url, `+${SHARE_EXPIRY_DAYS} days`, token, bookingId)
      .first<{ id: number; receipt_share_token: string }>();

    if (!saved) return { ok: false, code: 'save_failed', error: '保存できませんでした。' };
    return { ok: true, token: saved.receipt_share_token, verified };
  } catch (err) {
    // ── 第1層: 同じリンクが別の予約に登録済み ──
    //    「A のリンクをコピー → A に貼る → B でコピーし直すのを忘れて同じものを貼る」
    if (!isUniqueViolation(err)) {
      console.error('[receipt] 共有リンクを保存できませんでした:', bookingId, err);
      return { ok: false, code: 'save_failed', error: '保存できませんでした。' };
    }

    // 誰に登録済みかを出さないと、運営者は何を直せばいいか分からない
    const owner = await db
      .prepare('SELECT id, name FROM event_bookings WHERE receipt_share_url = ?')
      .bind(parsed.url)
      .first<{ id: number; name: string }>();

    return {
      ok: false,
      code: 'duplicate',
      error:
        `このリンクは既に${owner?.name ?? '別の参加者'}さんに登録されています。`
        + 'freee で該当の領収書を開き、リンクをコピーし直してください。',
    };
  }
}
