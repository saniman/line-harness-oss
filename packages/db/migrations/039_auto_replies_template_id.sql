-- Ported from upstream Shudesu/line-harness-oss migration 033_auto_replies_template_id.sql
-- auto_replies に template_id 追加。NULL のときは既存 response_content/response_type を使う
ALTER TABLE auto_replies ADD COLUMN template_id TEXT
  REFERENCES templates(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_auto_replies_template_id
  ON auto_replies(template_id);
