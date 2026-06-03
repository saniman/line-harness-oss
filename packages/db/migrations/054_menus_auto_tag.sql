-- Ported from upstream Shudesu/line-harness-oss migration 045_menus_auto_tag.sql
-- menus に「予約申込時に friend に自動付与するタグ」を追加。null なら付与なし。
-- NOTE: menus table was created in 042_booking.sql (this fork's migration).

ALTER TABLE menus ADD COLUMN auto_tag_id TEXT REFERENCES tags(id) ON DELETE SET NULL;
