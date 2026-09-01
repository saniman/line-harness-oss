-- Fork-specific migration: 819_health_logs_account_created_idx.sql
-- account_health_logs の「アカウントごとの最新1件」を引くための複合インデックス。
--
-- ban-monitor が状態の変化時だけ記録するようになり、書き込み前に直近1件を読むように
-- なった（apps/worker/src/services/ban-monitor.ts）。そのクエリは
--   SELECT * FROM account_health_logs WHERE line_account_id = ? ORDER BY created_at DESC LIMIT 1
-- だが、既存の idx_health_logs_account は line_account_id のみで created_at を含まないため、
-- SQLite は該当アカウントの全行を取り出してからソートする。
--
-- このテーブルには初回リリース（2026-03-23）から cron */5 で 1日288行/アカウントが
-- 積まれており、2026-09 時点でアカウントあたり 4.6万行規模になる。インデックスが無いと
-- 「書き込みを減らすために、毎tick その全行を読む」ことになり D1 の rows_read が悪化する。
--
-- 既存の idx_health_logs_account は他のクエリが使う可能性があるため削除しない
-- （インデックス追加のみ・データ変更なし）。
CREATE INDEX IF NOT EXISTS idx_health_logs_account_created
  ON account_health_logs (line_account_id, created_at DESC);
