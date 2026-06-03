-- Ported from upstream Shudesu/line-harness-oss migration 031_batch_lock_at.sql
-- 031_batch_lock_at.sql
--
-- batch_offset=-1 でロックを取った時刻を保持するカラムを追加する。
ALTER TABLE broadcasts ADD COLUMN batch_lock_at TEXT;

UPDATE broadcasts
   SET batch_lock_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
 WHERE status = 'sending' AND batch_offset = -1 AND batch_lock_at IS NULL;
