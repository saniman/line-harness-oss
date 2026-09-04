// Cron handler: Stripe Checkout を離脱したまま取り残された event_bookings の pending を掃除する。
//
// 本来は Stripe の checkout.session.expired webhook が即座に片付ける（routes/stripe.ts）。
// ただし webhook は Stripe ダッシュボードで送信イベントを有効化しないと飛んでこず、
// 設定漏れに気づく手立てが無い。ゴミ行が溜まり続けると参加者一覧が読めなくなるため、
// webhook が届かなくても最終的に片付く掃除ネットを置く（Issue #56）。

/**
 * Stripe セッションを作れなかった行の猶予（時間）。
 * Stripe に到達していない＝決済済みの可能性がゼロなので、待つ理由がない。
 * Stripe の expires_at（30分）より長めに取り、webhook 遅延との二重処理を避ける。
 */
const NO_SESSION_GRACE_HOURS = 2;

/**
 * セッションを作れた行の猶予（日）。
 *
 * event_bookings に payment_status='paid' を書くのは completed webhook だけなので、
 * webhook が遅れている間は「実は決済済みなのに pending / unpaid」の行が存在しうる。
 * 唯一のガードである paid_at も同じ webhook 由来なので保険にならない。
 * Stripe がリトライを打ち切る（3日程度）まで待ってから取り消すことで、
 * 支払った人の申込を消してしまう事故を防ぐ。
 */
const SESSION_GRACE_DAYS = 4;

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
 * - paid_at IS NULL  … 入金済みを取り消さないための保険（ただし webhook 由来なので過信しない）
 *
 * 猶予は session_id の有無で変える。セッションを作れなかった行は Stripe に到達して
 * いないので短く、作れた行は「決済済みなのに webhook が届いていない」可能性があるため
 * Stripe のリトライ期間を過ぎるまで待つ。
 */
export async function runEventBookingExpirer(
  db: D1Database,
  params: RunEventBookingExpirerParams,
): Promise<{ expired: number }> {
  const noSessionCutoff = toSqliteDatetime(
    new Date(params.now.getTime() - NO_SESSION_GRACE_HOURS * 3600_000),
  );
  const sessionCutoff = toSqliteDatetime(
    new Date(params.now.getTime() - SESSION_GRACE_DAYS * 24 * 3600_000),
  );

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
                   AND (
                         (stripe_session_id IS NULL     AND created_at < ?)
                      OR (stripe_session_id IS NOT NULL AND created_at < ?)
                       )
                 LIMIT ${BATCH_LIMIT}
              )`,
    )
    .bind(noSessionCutoff, sessionCutoff)
    .run();

  const changes = (result as { meta?: { changes?: number } }).meta?.changes ?? 0;
  return { expired: changes };
}
