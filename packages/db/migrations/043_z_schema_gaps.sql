-- Gap-filler: schema.sql から構築した DB に欠落している upstream テーブル・カラムを補完する。
-- schema.sql は一部の upstream マイグレーションを取り込まずに作られたため、
-- 以下のマイグレーションの DDL が実際には適用されていなかった:
--   003 (entry_routes, ref_tracking, friends.ref_code)
--   004 (friends.metadata)
--   005 (scenario_steps branching columns)
--   006 (tracked_links, link_clicks)
--   007 (forms, form_submissions)
--   008 (scenarios/reminders/automations/chats.line_account_id, line_accounts.*_channel_*, liff_id)
--          ※ friends.line_account_id と broadcasts.line_account_id は schema.sql 済みのため除外
--   009_token_expiry (line_accounts.token_expires_at)
--   010 (ref_tracking ad-click columns)
--   014 (forms.on_submit_message_*)
--   016 (traffic_pools)
--   017 (forms.on_submit_webhook_*)
--   020 (tracked_links.intro_template_id)
--   021 (tracked_links.reward_template_id)
--   022 (friends.first_tracked_link_id)
--   024 (form_opens)

-- ────────────────────────────────────────────────────────────────
-- 003: entry_routes, ref_tracking, friends.ref_code
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS entry_routes (
  id           TEXT PRIMARY KEY,
  ref_code     TEXT UNIQUE NOT NULL,
  name         TEXT NOT NULL,
  tag_id       TEXT REFERENCES tags (id) ON DELETE SET NULL,
  scenario_id  TEXT REFERENCES scenarios (id) ON DELETE SET NULL,
  redirect_url TEXT,
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_entry_routes_ref ON entry_routes (ref_code);

CREATE TABLE IF NOT EXISTS ref_tracking (
  id             TEXT PRIMARY KEY,
  ref_code       TEXT NOT NULL,
  friend_id      TEXT REFERENCES friends (id) ON DELETE CASCADE,
  entry_route_id TEXT REFERENCES entry_routes (id) ON DELETE SET NULL,
  source_url     TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ref_tracking_ref    ON ref_tracking (ref_code);
CREATE INDEX IF NOT EXISTS idx_ref_tracking_friend ON ref_tracking (friend_id);

ALTER TABLE friends ADD COLUMN ref_code TEXT;

-- ────────────────────────────────────────────────────────────────
-- 004: friends.metadata
-- ────────────────────────────────────────────────────────────────
ALTER TABLE friends ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}';

-- ────────────────────────────────────────────────────────────────
-- 005: scenario_steps branching
-- ────────────────────────────────────────────────────────────────
ALTER TABLE scenario_steps ADD COLUMN condition_type  TEXT;
ALTER TABLE scenario_steps ADD COLUMN condition_value TEXT;
ALTER TABLE scenario_steps ADD COLUMN next_step_on_false INTEGER;

-- ────────────────────────────────────────────────────────────────
-- 006: tracked_links, link_clicks
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tracked_links (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  original_url TEXT NOT NULL,
  tag_id       TEXT REFERENCES tags (id) ON DELETE SET NULL,
  scenario_id  TEXT REFERENCES scenarios (id) ON DELETE SET NULL,
  is_active    INTEGER NOT NULL DEFAULT 1,
  click_count  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS link_clicks (
  id              TEXT PRIMARY KEY,
  tracked_link_id TEXT NOT NULL REFERENCES tracked_links (id) ON DELETE CASCADE,
  friend_id       TEXT REFERENCES friends (id) ON DELETE SET NULL,
  clicked_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_link_clicks_link   ON link_clicks (tracked_link_id);
CREATE INDEX IF NOT EXISTS idx_link_clicks_friend ON link_clicks (friend_id);

-- ────────────────────────────────────────────────────────────────
-- 007: forms, form_submissions
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS forms (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  description           TEXT,
  fields                TEXT NOT NULL DEFAULT '[]',
  on_submit_tag_id      TEXT REFERENCES tags (id) ON DELETE SET NULL,
  on_submit_scenario_id TEXT REFERENCES scenarios (id) ON DELETE SET NULL,
  save_to_metadata      INTEGER NOT NULL DEFAULT 1,
  is_active             INTEGER NOT NULL DEFAULT 1,
  submit_count          INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS form_submissions (
  id         TEXT PRIMARY KEY,
  form_id    TEXT NOT NULL REFERENCES forms (id) ON DELETE CASCADE,
  friend_id  TEXT REFERENCES friends (id) ON DELETE SET NULL,
  data       TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_form_submissions_form   ON form_submissions (form_id);
CREATE INDEX IF NOT EXISTS idx_form_submissions_friend ON form_submissions (friend_id);

-- ────────────────────────────────────────────────────────────────
-- 008: マルチアカウント対応カラム（既存の line_account_id / broadcasts.line_account_id は schema.sql 済みのため除外）
-- ────────────────────────────────────────────────────────────────
ALTER TABLE scenarios   ADD COLUMN line_account_id TEXT;
ALTER TABLE reminders   ADD COLUMN line_account_id TEXT;
ALTER TABLE automations ADD COLUMN line_account_id TEXT;
ALTER TABLE chats       ADD COLUMN line_account_id TEXT;
ALTER TABLE line_accounts ADD COLUMN login_channel_id     TEXT;
ALTER TABLE line_accounts ADD COLUMN login_channel_secret TEXT;
ALTER TABLE line_accounts ADD COLUMN liff_id              TEXT;

-- ────────────────────────────────────────────────────────────────
-- 009_token_expiry: line_accounts.token_expires_at
-- ────────────────────────────────────────────────────────────────
ALTER TABLE line_accounts ADD COLUMN token_expires_at TEXT;

-- ────────────────────────────────────────────────────────────────
-- 010: ref_tracking 広告クリック ID カラム（ref_tracking が上で作成済み）
-- ────────────────────────────────────────────────────────────────
ALTER TABLE ref_tracking ADD COLUMN fbclid       TEXT;
ALTER TABLE ref_tracking ADD COLUMN gclid        TEXT;
ALTER TABLE ref_tracking ADD COLUMN twclid       TEXT;
ALTER TABLE ref_tracking ADD COLUMN ttclid       TEXT;
ALTER TABLE ref_tracking ADD COLUMN utm_source   TEXT;
ALTER TABLE ref_tracking ADD COLUMN utm_medium   TEXT;
ALTER TABLE ref_tracking ADD COLUMN utm_campaign TEXT;
ALTER TABLE ref_tracking ADD COLUMN user_agent   TEXT;
ALTER TABLE ref_tracking ADD COLUMN ip_address   TEXT;

-- ────────────────────────────────────────────────────────────────
-- 014: forms.on_submit_message_*（forms が上で作成済み）
-- ────────────────────────────────────────────────────────────────
ALTER TABLE forms ADD COLUMN on_submit_message_type    TEXT CHECK (on_submit_message_type IN ('text', 'flex')) DEFAULT NULL;
ALTER TABLE forms ADD COLUMN on_submit_message_content TEXT DEFAULT NULL;

-- ────────────────────────────────────────────────────────────────
-- 016: traffic_pools
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS traffic_pools (
  id                TEXT PRIMARY KEY,
  slug              TEXT UNIQUE NOT NULL,
  name              TEXT NOT NULL,
  active_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  is_active         INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- ────────────────────────────────────────────────────────────────
-- 017: forms.on_submit_webhook_*
-- ────────────────────────────────────────────────────────────────
ALTER TABLE forms ADD COLUMN on_submit_webhook_url          TEXT;
ALTER TABLE forms ADD COLUMN on_submit_webhook_headers      TEXT;
ALTER TABLE forms ADD COLUMN on_submit_webhook_fail_message TEXT;

-- ────────────────────────────────────────────────────────────────
-- 020: tracked_links.intro_template_id
-- ────────────────────────────────────────────────────────────────
ALTER TABLE tracked_links ADD COLUMN intro_template_id TEXT REFERENCES message_templates (id) ON DELETE SET NULL;

-- ────────────────────────────────────────────────────────────────
-- 021: tracked_links.reward_template_id
-- ────────────────────────────────────────────────────────────────
ALTER TABLE tracked_links ADD COLUMN reward_template_id TEXT REFERENCES message_templates (id) ON DELETE SET NULL;

-- ────────────────────────────────────────────────────────────────
-- 022: friends.first_tracked_link_id
-- ────────────────────────────────────────────────────────────────
ALTER TABLE friends ADD COLUMN first_tracked_link_id TEXT REFERENCES tracked_links (id) ON DELETE SET NULL;

-- ────────────────────────────────────────────────────────────────
-- 024: form_opens
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS form_opens (
  id          TEXT PRIMARY KEY,
  form_id     TEXT NOT NULL,
  friend_id   TEXT,
  friend_name TEXT,
  opened_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_form_opens_form ON form_opens (form_id, opened_at);
