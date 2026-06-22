-- Fork-specific migration: 812_menu_group.sql
-- 飲食メニューを「ドリンク」と「お食事」で分けるため menu_group を追加する。
--   'food'  … お食事（おすすめ・フード・デザート等）。既存はすべてこれ（DEFAULT）
--   'drink' … ドリンク（調理しない）
-- LIFF のメニュー大分類タブ、厨房ディスプレイのドリンク/お食事分割表示に使う。
-- ADD COLUMN（CHECK 変更ではない）なのでテーブル再作成は不要。

ALTER TABLE menus ADD COLUMN menu_group TEXT NOT NULL DEFAULT 'food';

-- 既存の food メニューのうちドリンクカテゴリを 'drink' に補正（冪等）。
UPDATE menus SET menu_group = 'drink'
 WHERE menu_type = 'food' AND category_label = 'ドリンク' AND menu_group <> 'drink';

CREATE INDEX IF NOT EXISTS idx_menus_account_group ON menus (line_account_id, menu_type, menu_group, sort_order);
