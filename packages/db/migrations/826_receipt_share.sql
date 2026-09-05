-- Fork-specific migration: 826_receipt_share.sql
-- freee の領収書「共有リンク」を運営者が登録し、LINE で参加者へ送るための列を追加する（Issue #47）。
--
-- 背景（#47 で確定した事実）:
--   freee請求書 API には領収書の送付・共有のエンドポイントが無く、共有リンク
--   （https://invoice.secure.freee.co.jp/ivex/dl/<UUID v4>）は**画面操作でしか生成できない**。
--   API から読むこともできない（共有後に GET しても sending_status は unsent のまま）。
--   そのため「運営者が freee で共有リンクを作って貼る」だけを手動にする。
--
-- ⚠️ 採番は 826。825 は feature/67-event-day-reminder が使用中（Issue #69: 採番スクリプトが
--    ローカルのファイルしか見ないため、リモートブランチと衝突する）。
--
-- ⚠️ 日時は datetime('now') ＝ UTC・スペース区切り。JST ではない
--    （既存の cash_received_at / receipt_issued_at と同じ規約。821 のコメント参照）。

-- freee が採番した領収書番号（例: REC-0000000008）。
-- 貼られた共有リンクが「その予約の領収書か」を照合するのに使う（#47 第4層）。
ALTER TABLE event_bookings ADD COLUMN receipt_number TEXT;

-- 運営者が freee の画面で作って貼り付けた共有リンク。参加者に見せる実体。
-- ⚠️ receipt_url（freee の report_url = ログイン必須・運営者用）とは**別物**。
--    同じ列に入れると、ログインを求められる URL を参加者に送る事故が起きる。
ALTER TABLE event_bookings ADD COLUMN receipt_share_url TEXT;

-- 共有リンクの閲覧期限。freee の既定は 60 日。
ALTER TABLE event_bookings ADD COLUMN receipt_share_expires_at TEXT;

-- 第4層（freee へ問い合わせて領収書番号を照合）が通った日時。NULL = 未検証。
-- freee 側の障害で検証できなかった場合も NULL のまま（黙って「検証済み」にしない）。
ALTER TABLE event_bookings ADD COLUMN receipt_share_verified_at TEXT;

-- 参加者に送る URL のトークン。freee の URL を直接送らず、Worker 経由にするため。
-- 誤配に気づいたときに無効化できるようにするのが目的。
ALTER TABLE event_bookings ADD COLUMN receipt_share_token TEXT;

-- 誤配に気づいて無効化した日時。以降そのトークンは 410 を返す。
ALTER TABLE event_bookings ADD COLUMN receipt_share_revoked_at TEXT;

-- 参加者が最初にリンクを開いた日時（被害範囲の把握に使う）。
ALTER TABLE event_bookings ADD COLUMN receipt_share_opened_at TEXT;

-- LINE で送信した日時。二重送信の防止。
ALTER TABLE event_bookings ADD COLUMN receipt_sent_at TEXT;

-- ⚠️ 取り違え対策の第1層（#47）。
--    「A さんのリンクをコピー → A に貼る → B の番でコピーし直すのを忘れて同じものを貼る」
--    という事故を DB レベルで止める。イベント単位ではなく**全体で一意**にする
--    （過去イベントのリンクを貼っても弾く）。
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_bookings_receipt_share_url
  ON event_bookings (receipt_share_url) WHERE receipt_share_url IS NOT NULL;

-- 参加者がアクセスするたびに引くので索引を張る。
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_bookings_receipt_share_token
  ON event_bookings (receipt_share_token) WHERE receipt_share_token IS NOT NULL;
