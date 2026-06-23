-- Fork-specific migration: 813_dining_sessions.sql
-- 来店セッション（テーブルの1回の利用＝着席〜会計）を記録し、滞在時間・客単価分析に使う。
--   started_at … お客さんが最初に LIFF 注文ページを開いた時刻（滞在の起点）
--   ended_at   … 会計承認(会計完了)の時刻。NULL のあいだは滞在中
-- 会計後に同じテーブルへ再アクセスすると新しいセッションになる。
-- 集計は ended_at が入った（締まった）セッションのみを対象にする。

CREATE TABLE IF NOT EXISTS dining_sessions (
  id              TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL,
  table_id        TEXT REFERENCES dining_tables(id) ON DELETE SET NULL,
  table_number    TEXT NOT NULL,
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at        TEXT,
  order_count     INTEGER NOT NULL DEFAULT 0,
  total_amount    INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id)
);
CREATE INDEX IF NOT EXISTS idx_dining_sessions_open  ON dining_sessions (line_account_id, table_id, ended_at);
CREATE INDEX IF NOT EXISTS idx_dining_sessions_ended ON dining_sessions (line_account_id, ended_at);

-- 注文がどの来店セッションに属するか（任意。ADD COLUMN なので再作成不要）。
ALTER TABLE orders ADD COLUMN session_id TEXT;
