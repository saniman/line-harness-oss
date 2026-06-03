-- Ported from upstream Shudesu/line-harness-oss migration 039_default_main_pool.sql
INSERT OR IGNORE INTO traffic_pools (
  id, slug, name, active_account_id, is_active, created_at, updated_at
)
SELECT
  lower(hex(randomblob(16))),
  'main',
  'メインプール',
  (SELECT id FROM line_accounts ORDER BY created_at ASC LIMIT 1),
  1,
  datetime('now'),
  datetime('now')
WHERE NOT EXISTS (SELECT 1 FROM traffic_pools WHERE slug = 'main')
  AND EXISTS (SELECT 1 FROM line_accounts);

INSERT OR IGNORE INTO pool_accounts (
  id, pool_id, line_account_id, is_active, created_at
)
SELECT
  lower(hex(randomblob(16))),
  (SELECT id FROM traffic_pools WHERE slug = 'main'),
  la.id,
  1,
  datetime('now')
FROM line_accounts la
WHERE EXISTS (SELECT 1 FROM traffic_pools WHERE slug = 'main')
  AND NOT EXISTS (
    SELECT 1 FROM pool_accounts pa WHERE pa.line_account_id = la.id
  );
