-- Fork-specific migration: 825_event_reminders.sql
-- イベント当日のリマインドを参加者へ自動配信する（Issue #67）。
--
-- 背景:
--   前回の勉強会当日、会場・地図URL・持ち物・事前確認の案内を手動で1通ずつ送っていた。
--   イベントのたびに発生する作業で、送り忘れれば当日の来場率と準備率に直結する。
--   イベントのリマインド配信は未実装だった（サロン予約には booking_reminders がある）。
--
-- 設計メモ:
--   本文を入れる events.reminder_message_extra は upstream 由来の migration 048 で
--   既に存在するが、これまでどのコードからも読まれていなかった
--   （.claude/rules/api-coding.md「スキーマにカラムがある＝実装済みではない」）。
--   このマイグレーションで足すのは「いつ送るか」と「送ったか」の2つだけ。
--
--   採番について: next-migration-number.mjs は 824 を出したが、これはローカルの
--   ファイルしか見ていないため。別ブランチ（feature/66-receipt-name）が push 済みの
--   824_event_bookings_receipt_name.sql を持っていたので 825 に振り直した。
--   .claude/rules/migrations.md「新規に重複を作らないこと」。
--
--   どちらも ADD COLUMN のみで CHECK 制約の変更ではないため、テーブル再作成は不要。
--   event_bookings の再作成は過去に本番データ消失リスクを作った経緯があるので避ける
--   （.claude/rules/migrations.md の 804 の項）。
--
--   送信済みの記録を「イベント単位」ではなく「申込単位」にするのは、一部の参加者への
--   push が失敗したときにその人だけ再試行できるようにするため。イベント単位だと
--   全員成功か全員未送信かの二択になり、取りこぼしを拾えない。

-- 送信日時（UTC ISO）。NULL = リマインドを配信しない。
-- 管理画面の datetime-local を JST の壁時計として解釈し、toISOString() で保存する
-- （start_at / end_at と同じ規則。apps/web の jstDatetimeLocalToIso）。
ALTER TABLE events ADD COLUMN reminder_at TEXT;

-- リマインドを送った日時。NULL = 未送信。
-- 「送ってから記録」なので at-least-once（送信直後に落ちるとまれに2通）。
-- 既存の booking-reminders.ts と同じ性質。
ALTER TABLE event_bookings ADD COLUMN reminder_sent_at TEXT;

-- cron が毎回引く「イベントごとの未送信」を絞るための複合インデックス。
CREATE INDEX IF NOT EXISTS idx_event_bookings_reminder
  ON event_bookings (event_id, reminder_sent_at);
