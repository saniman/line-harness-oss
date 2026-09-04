-- Fork-specific migration: 823_event_bookings_cancel_reason.sql
-- Stripe 決済を途中でやめた申込を「本人都合のキャンセル」と区別できるようにする（Issue #56）。
--
-- 背景:
--   POST /api/events/:id/checkout-session は Stripe へ飛ばす前に pending 行を作るが、
--   name は決済完了時に Stripe の customer_details から埋める設計のため、
--   決済に到達しなかった行は「名前が空の pending / cancelled」として残り続けていた。
--   参加者一覧にこの残骸が並び、運営者が参加人数を読み違える事故が起きた（2026-09-04）。
--
-- 設計メモ（重要）:
--   status の CHECK 制約に 'expired' を足す案は採らない。SQLite は CHECK を ALTER できず
--   テーブル再作成が必要になるが、event_bookings の再作成は過去に本番データ消失リスクを
--   作った経緯がある（.claude/rules/migrations.md の 804 の項）。
--   離脱は status='cancelled' のまま、理由を cancel_reason で表す。
--
--   cancel_reason にも CHECK 制約は付けない。値が増えるたびにテーブル再作成が
--   必要になるのを避けるため。
--
-- 値の意味:
--   NULL                 … 本人都合のキャンセル（従来どおり。返金対象になり得る）
--   'checkout_abandoned'     … Stripe 決済画面から戻った（cancel_url 経由で LIFF が自動キャンセル）
--   'checkout_expired'       … Stripe セッションが期限切れ（webhook / cron スイープ）
--   'checkout_create_failed' … Stripe セッションを作れなかった（＝こちら側の障害。要確認）

-- キャンセルの理由。NULL = 本人都合のキャンセル。
ALTER TABLE event_bookings ADD COLUMN cancel_reason TEXT;

-- ------------------------------------------------------------
-- 既存のゴミ行を整理する（1回きりの backfill）
-- ------------------------------------------------------------
-- 入金済み・返金済みの行には絶対に触らない。
-- paid_at IS NULL / stripe_refund_id IS NULL / payment_status='unpaid' の3条件で守る。

-- 1) 放置された pending（Stripe 画面を閉じたまま戻ってこなかった申込）。
--    pending になるのは checkout-session ルートだけなので、無料・当日現金の申込
--    （/join が confirmed として作る）はここに入らない。
--
--    stripe_session_id では絞らない。Stripe のセッション作成に失敗した申込は
--    session_id が NULL のまま残り、Stripe 側にセッションが無いので expired webhook も
--    届かない。この backfill と cron スイープだけが受け皿になる。
--
--    理由は session_id の有無で出し分ける。session_id が NULL＝Stripe セッションを
--    作れなかった行で、申込者の離脱ではなくこちら側の障害（鍵ミス・API 障害）。
--    同じ理由にすると参加者一覧で見分けがつかなくなる。
--
--    猶予も session_id の有無で変える（cron スイープと同じルール）。
--
--    セッション未作成（-2 hours）… Stripe に到達していないので決済済みの可能性がゼロ。
--      短くてよい。このマイグレーションは CI のデプロイ中に流れるため、
--      ちょうど申込中の人を巻き込まない程度は空ける。
--
--    セッション作成済み（-4 days）… event_bookings に payment_status='paid' を書くのは
--      completed webhook だけなので、webhook が遅れている間は「実は決済済みなのに
--      pending / unpaid」の行が存在しうる。唯一のガードである paid_at も同じ webhook
--      由来なので保険にならない。Stripe がリトライを打ち切る（3日程度）まで待ってから
--      取り消し、支払った人の申込を消してしまう事故を防ぐ。
UPDATE event_bookings
   SET status        = 'cancelled',
       cancel_reason = CASE
                         WHEN stripe_session_id IS NULL THEN 'checkout_create_failed'
                         ELSE 'checkout_expired'
                       END,
       updated_at    = datetime('now')
 WHERE status             = 'pending'
   AND payment_status     = 'unpaid'
   AND paid_at           IS NULL
   AND stripe_refund_id  IS NULL
   AND (
         (stripe_session_id IS NULL     AND created_at < datetime('now', '-2 hours'))
      OR (stripe_session_id IS NOT NULL AND created_at < datetime('now', '-4 days'))
       );

-- 2) 名前が空のまま cancelled になっている行（決済画面から戻ったケース）。
--    名前が入っているキャンセルは本人都合なので cancel_reason は NULL のまま残す。
--
--    stripe_session_id IS NOT NULL でカード決済フローの行だけに絞る。
--    payment_status='unpaid' は無料イベントの申込にも当てはまり（'cash' だけが現金）、
--    /join は name に body.name ?? '' を入れるため、プロフィール取得に失敗した
--    無料申込は名前が空になり得る。それを本人がキャンセルした行まで離脱扱いにすると、
--    参加者一覧の折りたたみに隠れてしまう。
UPDATE event_bookings
   SET cancel_reason = 'checkout_abandoned',
       updated_at    = datetime('now')
 WHERE status                    = 'cancelled'
   AND cancel_reason            IS NULL
   AND TRIM(COALESCE(name, ''))  = ''
   AND payment_status            = 'unpaid'
   AND paid_at                  IS NULL
   AND stripe_refund_id         IS NULL
   AND stripe_session_id        IS NOT NULL;
