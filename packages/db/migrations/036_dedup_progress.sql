-- Ported from upstream Shudesu/line-harness-oss migration 030_dedup_progress.sql
-- 030_dedup_progress.sql
--
-- multi-account-dedup broadcast の resume 用に per-account 進捗を保存するカラムを追加する。
--
-- Format: JSON `{"<accountId>": {"batchOffset": <int>, "success": <int>}}`
ALTER TABLE broadcasts ADD COLUMN dedup_progress TEXT;
