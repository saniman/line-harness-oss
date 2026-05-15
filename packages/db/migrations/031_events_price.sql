-- events テーブルに決済金額カラムを追加（円単位・NULL は無料）
ALTER TABLE events ADD COLUMN price INTEGER;
