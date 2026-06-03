-- Ported from upstream Shudesu/line-harness-oss migration 034_webhook_secret_required.sql
-- Issue #103: Webhook secret を必須化 (最低 32 文字) し、secret 未設定の
-- 既存 webhook を fail-closed で無効化する。

UPDATE incoming_webhooks
   SET is_active = 0,
       updated_at = strftime('%Y-%m-%dT%H:%M:%S', 'now', '+9 hours') || '.000+09:00'
 WHERE secret IS NULL
    OR LENGTH(secret) < 32;

UPDATE outgoing_webhooks
   SET is_active = 0,
       updated_at = strftime('%Y-%m-%dT%H:%M:%S', 'now', '+9 hours') || '.000+09:00'
 WHERE secret IS NULL
    OR LENGTH(secret) < 32
    OR url IS NULL
    OR url NOT LIKE 'https://_%'
    OR url LIKE 'https://:%'
    OR url LIKE 'https://?%'
    OR url LIKE 'https://#%'
    OR url LIKE 'https://[%';
