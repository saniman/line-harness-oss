-- Migration 028: 営業時間・休業日テーブル

CREATE TABLE IF NOT EXISTS business_hours (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  day_of_week  INTEGER NOT NULL UNIQUE CHECK (day_of_week BETWEEN 0 AND 6),
  is_open      INTEGER NOT NULL DEFAULT 1,
  start_hour   INTEGER NOT NULL DEFAULT 9,
  end_hour     INTEGER NOT NULL DEFAULT 18,
  slot_minutes INTEGER NOT NULL DEFAULT 60,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS business_holidays (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT NOT NULL UNIQUE,
  reason     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- シードデータ：月〜金 9-18時、土日休み
INSERT OR IGNORE INTO business_hours (day_of_week, is_open, start_hour, end_hour, slot_minutes) VALUES
  (0, 0, 9, 18, 60),
  (1, 1, 9, 18, 60),
  (2, 1, 9, 18, 60),
  (3, 1, 9, 18, 60),
  (4, 1, 9, 18, 60),
  (5, 1, 9, 18, 60),
  (6, 0, 9, 18, 60);
