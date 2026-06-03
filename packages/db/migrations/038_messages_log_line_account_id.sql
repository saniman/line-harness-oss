-- Ported from upstream Shudesu/line-harness-oss migration 032_messages_log_line_account_id.sql
-- 032_messages_log_line_account_id.sql
--
-- messages_log に line_account_id カラムを追加する。
ALTER TABLE messages_log ADD COLUMN line_account_id TEXT;

CREATE INDEX IF NOT EXISTS idx_messages_log_broadcast_id ON messages_log(broadcast_id);
