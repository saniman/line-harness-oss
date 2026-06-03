-- Ported from upstream Shudesu/line-harness-oss migration 040_events_multi_account.sql
-- events を broadcasts と同型の multi-account-dedup 構造に拡張。
-- 既存 events はすべて target_type='single' で動作不変。
-- NOTE: events.line_account_id does not exist in this fork's schema,
-- but the ADD COLUMN operations below are safe as they add new columns.

ALTER TABLE events ADD COLUMN target_type TEXT NOT NULL DEFAULT 'single'
  CHECK (target_type IN ('single', 'multi-account-dedup'));
ALTER TABLE events ADD COLUMN account_ids TEXT
  CHECK (account_ids IS NULL OR json_valid(account_ids));
ALTER TABLE events ADD COLUMN dedup_priority TEXT
  CHECK (dedup_priority IS NULL OR json_valid(dedup_priority));
ALTER TABLE events ADD COLUMN failed_account_ids TEXT
  CHECK (failed_account_ids IS NULL OR json_valid(failed_account_ids));

ALTER TABLE event_bookings ADD COLUMN identity_key TEXT;
UPDATE event_bookings SET identity_key = 'solo:' || id WHERE identity_key IS NULL;

CREATE INDEX idx_event_bookings_identity_status
  ON event_bookings (event_id, identity_key, status);
