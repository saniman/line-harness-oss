-- Ported from upstream Shudesu/line-harness-oss migration 029_account_management_v2.sql
-- NOTE: INSERT statement adapted for fork's broadcasts table structure
-- (fork lacks line_account_id and alt_text columns that upstream has)

-- ============================================================
-- Part 1: line_accounts extensions
-- ============================================================

ALTER TABLE line_accounts ADD COLUMN country TEXT;
ALTER TABLE line_accounts ADD COLUMN role TEXT;
ALTER TABLE line_accounts ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_line_accounts_display_order
  ON line_accounts (display_order, created_at);

UPDATE line_accounts SET display_order = (
  SELECT COUNT(*) FROM line_accounts la2
  WHERE la2.created_at < line_accounts.created_at
     OR (la2.created_at = line_accounts.created_at AND la2.id < line_accounts.id)
) WHERE display_order = 0;

-- ============================================================
-- Part 2: broadcasts dedup metadata (table recreate)
-- ============================================================
-- Fork's broadcasts.target_type CHECK = ('all', 'tag') only.
-- Expanding to ('all', 'tag', 'segment', 'multi-account-dedup').

CREATE TABLE broadcasts_new (
  id                 TEXT PRIMARY KEY,
  title              TEXT NOT NULL,
  message_type       TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'flex')),
  message_content    TEXT NOT NULL,
  target_type        TEXT NOT NULL CHECK (target_type IN ('all', 'tag', 'segment', 'multi-account-dedup')) DEFAULT 'all',
  target_tag_id      TEXT REFERENCES tags (id) ON DELETE SET NULL,
  status             TEXT NOT NULL CHECK (status IN ('draft', 'scheduled', 'sending', 'sent')) DEFAULT 'draft',
  scheduled_at       TEXT,
  sent_at            TEXT,
  total_count        INTEGER NOT NULL DEFAULT 0,
  success_count      INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  line_account_id    TEXT,
  alt_text           TEXT,
  line_request_id    TEXT,
  aggregation_unit   TEXT,
  batch_offset       INTEGER NOT NULL DEFAULT 0,
  segment_conditions TEXT,
  account_ids        TEXT CHECK (account_ids IS NULL OR json_valid(account_ids)),
  dedup_priority     TEXT CHECK (dedup_priority IS NULL OR json_valid(dedup_priority)),
  failed_account_ids TEXT CHECK (failed_account_ids IS NULL OR json_valid(failed_account_ids))
);

INSERT INTO broadcasts_new (
  id, title, message_type, message_content, target_type, target_tag_id, status,
  scheduled_at, sent_at, total_count, success_count, created_at,
  line_request_id, aggregation_unit, batch_offset, segment_conditions
) SELECT
  id, title, message_type, message_content, target_type, target_tag_id, status,
  scheduled_at, sent_at, total_count, success_count, created_at,
  line_request_id, aggregation_unit, batch_offset, segment_conditions
FROM broadcasts;

DROP TABLE broadcasts;
ALTER TABLE broadcasts_new RENAME TO broadcasts;

CREATE INDEX IF NOT EXISTS idx_broadcasts_status ON broadcasts (status);
