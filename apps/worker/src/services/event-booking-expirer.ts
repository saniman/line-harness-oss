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
 * SQLite の `datetime('now')` と同じ 'YYYY-MM-DD HH:MM:SS'（UTC）に整形する。
 *
 * `created_at` の既定値はこの形式なので、比較する値も揃えないといけない。
 * ISO 形式（`toISOString()`）を渡すと SQLite の BINARY 照合では 10 文字目が
 * ' '(0x20) vs 'T'(0x54) となり「同じ日付なら常に締切より古い」と誤判定する。
 * その結果、猶予が効かず決済中の申込まで取り消してしまう。
 */
function toSqliteDatetime(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * 期限切れの pending 申込を cancelled + cancel_reason='checkout_expired' にする。
 *
 * 対象を絞る条件の意味:
 * - status='pending' … 確定済み・キャンセル済みを巻き込まない。
 *   pending になるのは checkout-session ルートだけで、無料・当日現金の申込は
 *   /join が confirmed として作るためここには入らない。
 * - paid_at IS NULL  … 入金済みを取り消さないための保険
 *
 * stripe_session_id では絞らない。Stripe のセッション作成が失敗した申込は
 * session_id が NULL のまま pending で残り、webhook も届かない（metadata が無い）ため、
 * この掃除ネットだけが最後の受け皿になる。
 */
export async function runEventBookingExpirer(
  db: D1Database,
  params: RunEventBookingExpirerParams,
): Promise<{ expired: number }> {
  const cutoff = toSqliteDatetime(new Date(params.now.getTime() - EXPIRE_GRACE_HOURS * 3600_000));

  // UPDATE ... LIMIT は SQLite のビルドオプション依存なので、サブクエリで件数を絞る。
  const result = await db
    .prepare(
      `UPDATE event_bookings
          SET status = 'cancelled',
              -- セッションを作れなかった行（session_id が NULL）は申込者の離脱ではなく
              -- こちら側の障害。同じ理由にすると折りたたみの中で見分けがつかなくなる
              cancel_reason = CASE
                WHEN stripe_session_id IS NULL THEN 'checkout_create_failed'
                ELSE 'checkout_expired'
              END,
              updated_at = datetime('now')
        WHERE id IN (
                SELECT id FROM event_bookings
                 WHERE status = 'pending'
                   AND paid_at IS NULL
                   AND created_at < ?
                 LIMIT ${BATCH_LIMIT}
              )`,
    )
    .bind(cutoff)
    .run();

  const changes = (result as { meta?: { changes?: number } }).meta?.changes ?? 0;
  return { expired: changes };
}
