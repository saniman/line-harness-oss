-- Fork-specific migration: 810_menu_type.sql
-- menus を「サロン予約」と「飲食モバイルオーダー」で共用しているため、
-- 種別を判別する menu_type を追加する。
--   'salon' … サロン予約メニュー（既存はすべてこれ）
--   'food'  … 飲食モバイルオーダーのメニュー
-- 既存行は DEFAULT 'salon' になる。飲食シードは menu_type='food' を明示する。
-- ADD COLUMN（CHECK 変更ではない）なのでテーブル再作成は不要。

ALTER TABLE menus ADD COLUMN menu_type TEXT NOT NULL DEFAULT 'salon';

CREATE INDEX IF NOT EXISTS idx_menus_account_type ON menus (line_account_id, menu_type, sort_order);
