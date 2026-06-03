-- Fork-specific migration: 802_stripe_event_bookings.sql
-- event_bookings に Stripe 決済カラムを追加（本番D1には030として適用済み）

ALTER TABLE event_bookings ADD COLUMN stripe_session_id TEXT;
ALTER TABLE event_bookings ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'unpaid';
ALTER TABLE event_bookings ADD COLUMN paid_at DATETIME;
ALTER TABLE event_bookings ADD COLUMN amount INTEGER;
