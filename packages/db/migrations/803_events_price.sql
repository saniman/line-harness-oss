-- Fork-specific migration: 803_events_price.sql
-- events に price カラムを追加（本番D1には031として適用済み）

ALTER TABLE events ADD COLUMN price INTEGER;
