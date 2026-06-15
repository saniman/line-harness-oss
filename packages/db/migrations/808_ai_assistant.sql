-- Fork-specific migration: 808_ai_assistant.sql
-- パーソナルAIアシスタント返信（案A）用テーブル。
--
-- auto_replies / 既存キーワードに当たらない自由文に、Claude(Haiku) が
-- 店舗情報＋会話履歴を踏まえて 1:1 返信する機能の設定とレート制限を保持する。
--
-- 新規テーブルのみ（CHECK制約変更なし）＝テーブル再作成不要。

-- 設定（単一行 id='default'）
CREATE TABLE IF NOT EXISTS ai_assistant_config (
  id          TEXT PRIMARY KEY DEFAULT 'default',
  enabled     INTEGER NOT NULL DEFAULT 0,          -- グローバルON/OFF（既定OFF）
  model       TEXT NOT NULL DEFAULT 'claude-haiku-4-5-20251001',
  knowledge   TEXT NOT NULL DEFAULT '',            -- 店舗情報・FAQ・トーン（system prompt に注入）
  daily_limit INTEGER NOT NULL DEFAULT 10,         -- friend あたり1日の返信上限（コスト/濫用対策）
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

INSERT OR IGNORE INTO ai_assistant_config (id) VALUES ('default');

-- friend あたり日次の返信回数（レート制限）
CREATE TABLE IF NOT EXISTS ai_assistant_usage (
  friend_id TEXT NOT NULL,
  ymd       TEXT NOT NULL,                          -- 'YYYY-MM-DD' (JST)
  count     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (friend_id, ymd)
);
