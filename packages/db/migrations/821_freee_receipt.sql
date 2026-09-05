-- Fork-specific migration: 821_freee_receipt.sql
-- 当日現金払いの「現金受領」と「領収書発行」を記録するカラムを event_bookings に追加する。
--
-- 用途: 管理画面で「現金受領」ボタンを押す → freee で領収書を発行 → LINE で参加者へ送信、
--       という現金決済領収書自動化（Epic #41 / 子 Issue #42）の土台。
--
-- 設計メモ（重要・#42 で決定）:
--   payment_method カラムは追加しない。event_bookings.payment_status が既に
--     'paid'   … Stripe 決済完了
--     'cash'   … 当日現金（未収）
--     'unpaid' … 無料参加 / Stripe 途中離脱
--   の3値を持っており、'cash' が「当日現金・未受領」を表しているため。
--   受領時に payment_status を 'paid' に書き換えると管理画面のバッジで現金とカードの
--   区別がつかなくなる（Issue #14 で直した問題の再発）。
--   そこで payment_status は据え置き、受領は cash_received_at の有無で表す。
--
-- 状態の判定:
--   当日現金で申込（未受領） … payment_status = 'cash' AND cash_received_at IS NULL
--   現金受領済み             … cash_received_at IS NOT NULL
--   領収書発行済み           … receipt_url IS NOT NULL
--
-- 既存レコードは全件 NULL（＝未受領・領収書なし）で意味が合うため backfill は不要。

-- 現金を受け取った日時。NULL = 未受領。
-- ⚠️ 形式は datetime('now') ＝ **UTC・スペース区切り**（'YYYY-MM-DD HH:MM:SS'）。
--    paid_at / created_at / updated_at と同じ規約。JST では**ない**。
--    表示は formatJST()、領収日は formatJstDate() を通すこと。
ALTER TABLE event_bookings ADD COLUMN cash_received_at  TEXT;

-- freee が発行した領収書の URL。NULL = 未発行。
ALTER TABLE event_bookings ADD COLUMN receipt_url       TEXT;

-- 領収書を発行した日時。NULL = 未発行。
-- ⚠️ 形式は datetime('now') ＝ **UTC・スペース区切り**。JST では**ない**。
--    発行権の期限判定（services/freee-receipt.ts）が
--    receipt_issued_at < datetime('now','-5 minutes') という**文字列比較**なので、
--    strftime(...,'+9 hours') 形式で書くと比較が壊れて二重発行が復活する。
ALTER TABLE event_bookings ADD COLUMN receipt_issued_at TEXT;
