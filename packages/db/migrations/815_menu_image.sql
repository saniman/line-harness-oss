-- Fork-specific migration: 815_menu_image.sql
-- メニューに料理写真の URL を持たせる。モバイルオーダーの注文カードに表示する。
-- まずはサンプル/PR 用途（LoremFlickr 等の URL を貼るだけ）。将来は実写真の URL を入れる。
-- ADD COLUMN（CHECK 変更ではない）なのでテーブル再作成は不要。

ALTER TABLE menus ADD COLUMN image_url TEXT;
