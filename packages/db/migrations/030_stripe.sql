-- event_bookings テーブルにStripe決済用カラムを追加
-- payment_status の運用ルール：
--   pending   : Checkout Session作成済み・決済待ち
--   confirmed : Stripe Webhookで決済確認済み
--   cancelled : キャンセル済み
ALTER TABLE event_bookings ADD COLUMN stripe_session_id TEXT;
ALTER TABLE event_bookings ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'unpaid';
ALTER TABLE event_bookings ADD COLUMN paid_at DATETIME;
ALTER TABLE event_bookings ADD COLUMN amount INTEGER;
