-- Ported from upstream Shudesu/line-harness-oss migration 046_link_tracking_controls.sql
--
-- 1. tracked_links.line_account_id — リンクを所有する LINE アカウント。
--    /t/:linkId が LINE アプリ内クリックを「所有アカウントの LIFF」へ飛ばすために使う。
--    これが無いと全リンクがグローバルの env.LIFF_URL（アカウント①）に飛び、他アカウントの
--    友だちに見覚えのない同意画面が出てアトリビューションも壊れる。
--    NULL = 旧リンク/所有者なし → scenario 経由の解決、最終的に env.LIFF_URL にフォールバック。
--
-- 2. broadcasts.track_links — 配信ごとの URL 自動短縮（auto-track）のオン/オフ。
--    1 = URL を /t/ トラッキングリンクに変換する（従来の挙動）
--    0 = メッセージ本文をそのまま送る（/t/ 変換なし）

ALTER TABLE tracked_links ADD COLUMN line_account_id TEXT REFERENCES line_accounts(id) ON DELETE SET NULL;
ALTER TABLE broadcasts ADD COLUMN track_links INTEGER NOT NULL DEFAULT 1;
