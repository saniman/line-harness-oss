-- Fork-specific migration: 805_event_booking_refund.sql
-- event_bookings に返金カラムを追加（本番D1には033として適用済み）

ALTER TABLE event_bookings ADD COLUMN stripe_refund_id TEXT;
ALTER TABLE event_bookings ADD COLUMN refund_status TEXT;
