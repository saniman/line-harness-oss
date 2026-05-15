-- event_bookings の status CHECK に 'pending' を追加（Stripe決済フロー用）
-- SQLite は ALTER TABLE による CHECK 変更不可のためテーブル再作成

CREATE TABLE event_bookings_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  friend_id TEXT REFERENCES friends(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK(status IN ('pending','confirmed','cancelled')),
  stripe_session_id TEXT,
  payment_status TEXT NOT NULL DEFAULT 'unpaid',
  paid_at DATETIME,
  amount INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO event_bookings_v2
  SELECT id, event_id, friend_id, name, email, status,
         stripe_session_id, payment_status, paid_at, amount,
         created_at, updated_at
  FROM event_bookings;

DROP TABLE event_bookings;
ALTER TABLE event_bookings_v2 RENAME TO event_bookings;

CREATE INDEX IF NOT EXISTS idx_event_bookings_event_id ON event_bookings(event_id);
CREATE INDEX IF NOT EXISTS idx_event_bookings_status ON event_bookings(status);
