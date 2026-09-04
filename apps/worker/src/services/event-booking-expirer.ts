// Cron handler: Stripe Checkout を離脱したまま取り残された event_bookings の pending を掃除する。
//
// 本来は Stripe の checkout.session.expired webhook が即座に片付ける（routes/stripe.ts）。
// ただし webhook は Stripe ダッシュボードで送信イベントを有効化しないと飛んでこず、
// 設定漏れに気づく手立てが無い。ゴミ行が溜まり続けると参加者一覧が読めなくなるため、
// webhook が届かなくても最終的に片付く掃除ネットを置く（Issue #56）。

/** Stripe の expires_at（30分）に対する猶予。webhook 遅延との二重処理を避ける。 */
const EXPIRE_GRACE_HOURS = 2;

/** 1 tick で処理する上限。cron の実行時間が読めなくならないようにする。 */
const BATCH_LIMIT = 200;

export interface RunEventBookingExpirerParams {
  now: Date;
}

/**
 * 期限切れの pending 申込を cancelled + cancel_reason='checkout_expired' にする。
 *
 * 対象を絞る条件の意味:
 * - status='pending'            … 確定済み・キャンセル済みを巻き込まない
 * - stripe_session_id IS NOT NULL … カード決済フローに乗った行だけ。無料・当日現金の申込は
 *                                   /join で confirmed として作られるためここには入らない
 * - paid_at IS NULL             … 入金済みを取り消さないための保険
 */
export async function runEventBookingExpirer(
  db: D1Database,
  params: RunEventBookingExpirerParams,
): Promise<{ expired: number }> {
  const cutoff = new Date(params.now.getTime() - EXPIRE_GRACE_HOURS * 3600_000).toISOString();

  // UPDATE ... LIMIT は SQLite のビルドオプション依存なので、サブクエリで件数を絞る。
  const result = await db
    .prepare(
      `UPDATE event_bookings
          SET status = 'cancelled',
              cancel_reason = 'checkout_expired',
              updated_at = datetime('now')
        WHERE id IN (
                SELECT id FROM event_bookings
                 WHERE status = 'pending'
                   AND paid_at IS NULL
                   AND stripe_session_id IS NOT NULL
                   AND created_at < ?
                 LIMIT ${BATCH_LIMIT}
              )`,
    )
    .bind(cutoff)
    .run();

  const changes = (result as { meta?: { changes?: number } }).meta?.changes ?? 0;
  return { expired: changes };
}
