/**
 * 運営者が予約を取り消したことを、参加者に LINE で知らせる（Issue #65）。
 *
 * 現金受領済みの予約は参加者から取り消せないようにしたので、参加者は
 * 「主催者までご連絡ください」で止められる。そのあと運営者が取り消しても、
 * 通知が無いと**処理されたのかどうか分からないまま**になる。
 *
 * ⚠️ ベストエフォート。送信に失敗しても取り消し自体は成立しているので、
 *    例外を投げない（投げるとルートが 500 を返し、運営者が「取り消せなかった」と誤解する）。
 */

/** LINE 送信に使う最小のインターフェース（`.claude/rules/api-coding.md`） */
export interface CancelNotifyLineClient {
  pushMessage(to: string, messages: { type: 'text'; text: string }[]): Promise<unknown>;
}

/**
 * 取り消しの文面。
 *
 * ⚠️ **返金や金額に触れない。** 現金は対面で返す運用なので、ここで「返金します」と
 *    書くと二重に約束したことになる。Stripe の返金は参加者側のキャンセル導線が
 *    別途案内しているので、こちらでは重ねない。
 */
export function buildCancelledMessage(eventTitle: string | null): string {
  const title = eventTitle?.trim();
  const head = title ? `${title} のお申し込みを取り消しました。` : 'お申し込みを取り消しました。';
  return `${head}\nご不明な点がありましたら、お気軽にご連絡ください。`;
}

interface CancelNotifyRow {
  friend_id: string | null;
  line_user_id: string | null;
  title: string | null;
}

/**
 * @returns 送れたか。宛先が無い・失敗したときは false（例外は投げない）
 */
export async function notifyBookingCancelled(
  db: D1Database,
  line: CancelNotifyLineClient,
  bookingId: number,
): Promise<boolean> {
  try {
    // ⚠️ 宛先は**当該予約に紐づく友だち**から引く。別の経路で取ると取り違える
    const row = await db
      .prepare(
        `SELECT b.friend_id, f.line_user_id, e.title
           FROM event_bookings b
           LEFT JOIN friends f ON f.id = b.friend_id
           LEFT JOIN events e ON e.id = b.event_id
          WHERE b.id = ?`,
      )
      .bind(bookingId)
      .first<CancelNotifyRow>();

    // 宛先を特定できないまま送らない（誤配になる）
    if (!row?.friend_id || !row.line_user_id) return false;

    await line.pushMessage(row.line_user_id, [
      { type: 'text', text: buildCancelledMessage(row.title) },
    ]);
    return true;
  } catch (err) {
    console.error('[events] 取り消し通知に失敗しました:', bookingId, err);
    return false;
  }
}
