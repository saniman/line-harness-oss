-- Fork-specific migration: 811_order_checkout_request.sql
-- モバイルオーダーの会計に「厨房承認ステップ」を追加する。
-- お客さん(LIFF)の「お会計」は会計完了ではなく "会計依頼" 止まりにし、
-- 厨房ディスプレイで承認して初めて status='closed' + payment_status='paid'（会計完了）にする。
--
-- payment_status は CHECK(IN('unpaid','paid')) のため 'requested' 追加はテーブル再作成が必要。
-- 代わりに checkout_requested_at（依頼時刻・nullable）を立てて「会計依頼中」を表現する。
-- ADD COLUMN（CHECK 変更ではない）なのでテーブル再作成は不要。既存行は NULL（=依頼なし）。

ALTER TABLE orders ADD COLUMN checkout_requested_at TEXT;
