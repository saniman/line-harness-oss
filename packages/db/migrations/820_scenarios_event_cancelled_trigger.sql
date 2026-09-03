-- Fork-specific migration: 820_scenarios_event_cancelled_trigger.sql
-- scenarios.trigger_type の CHECK 制約に 'event_cancelled' を追加する。
--   変更前: CHECK (trigger_type IN ('friend_add', 'tag_added', 'manual', 'event_booking'))
--   変更後: CHECK (trigger_type IN ('friend_add', 'tag_added', 'manual', 'event_booking', 'event_cancelled'))
--
-- 用途: 参加確定後にイベントをキャンセルした人へ、参加者向けの「お礼」ではなく
--       キャンセル者向けの文言（「残念でした／またご案内します」）を配信する
--       （services/event-followup.ts の switchToCancelledFollowup）。
--
-- SQLite は ALTER TABLE による CHECK 制約変更が不可のためテーブル再作成フロー。
-- （既存 806 マイグレーションと同じパターン。806 以降 scenarios への ALTER は無い）
--
-- 実 DB(remote) の scenarios カラム構成（順序厳守。delivery_mode が line_account_id より前）:
--   id, name, description, trigger_type, trigger_tag_id, is_active,
--   created_at, updated_at, delivery_mode, line_account_id
--
-- FK 依存（子テーブルは触らず親のみ再作成。RENAME で参照名は自動追従）:
--   scenario_steps / friend_scenarios 等

CREATE TABLE scenarios_v3 (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT,
  trigger_type    TEXT NOT NULL CHECK (trigger_type IN ('friend_add', 'tag_added', 'manual', 'event_booking', 'event_cancelled')),
  trigger_tag_id  TEXT REFERENCES tags (id) ON DELETE SET NULL,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  delivery_mode   TEXT NOT NULL DEFAULT 'relative'
    CHECK (delivery_mode IN ('relative', 'elapsed', 'absolute_time')),
  line_account_id TEXT
);

INSERT INTO scenarios_v3
  (id, name, description, trigger_type, trigger_tag_id, is_active,
   created_at, updated_at, delivery_mode, line_account_id)
  SELECT
   id, name, description, trigger_type, trigger_tag_id, is_active,
   created_at, updated_at, delivery_mode, line_account_id
  FROM scenarios;

DROP TABLE scenarios;
ALTER TABLE scenarios_v3 RENAME TO scenarios;
