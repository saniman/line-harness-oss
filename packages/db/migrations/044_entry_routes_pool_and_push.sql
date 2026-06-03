-- Ported from upstream Shudesu/line-harness-oss migration 038_entry_routes_pool_and_push.sql
ALTER TABLE entry_routes
  ADD COLUMN pool_id TEXT REFERENCES traffic_pools (id) ON DELETE SET NULL;

ALTER TABLE entry_routes
  ADD COLUMN intro_template_id TEXT REFERENCES message_templates (id) ON DELETE SET NULL;

ALTER TABLE entry_routes
  ADD COLUMN run_account_friend_add_scenarios INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_entry_routes_pool ON entry_routes (pool_id);
