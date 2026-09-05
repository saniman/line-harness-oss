-- Fork-specific migration: 824_event_bookings_receipt_name.sql
-- 領収書の宛名を保存するカラムを event_bookings に追加する（Epic #41 / Issue #66）。
--
-- 用途: 当日現金の参加者へ freee で領収書を発行するとき（#46）の宛名。
--
-- なぜ既存の name を使わないか:
--   LIFF のイベント申込はワンタップで氏名の入力欄が無く、name には
--   **LINE の表示名がそのまま入る**（client/event-booking.ts が displayName を送る）。
--   ニックネーム登録の人も多く、そのまま領収書の宛名にはできない。
--
-- 入力は任意。NULL のときは name（LINE の表示名）にフォールバックする。
-- 値はサーバー側で正規化してから保存する（utils/receipt-name.ts）。
-- 参加者が自由に決められる文字列で、領収書に印字され管理画面にも出るため、
-- 制御文字・双方向制御文字・ゼロ幅文字を潰し、長さを切る。

ALTER TABLE event_bookings ADD COLUMN receipt_name TEXT;
