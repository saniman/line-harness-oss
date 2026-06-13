-- Fork-specific migration: 807_scenario_event_anchor.sql
-- イベント開催日アンカー配信のためのカラム追加。
--
-- 用途: trigger_type='event_booking' のシナリオで、ステップを
--       「イベント開催日(events.start_at の日付) の N日後 + 時刻HH:MM(JST)」に配信する。
--       既存の delay_minutes 相対モード（friend_add 等）には影響しない。
--
-- CHECK 制約変更を伴わない単純な ADD COLUMN のためテーブル再作成は不要。

-- enroll 時にイベントの start_at を格納する（相対モードのシナリオは NULL のまま）
ALTER TABLE friend_scenarios ADD COLUMN anchor_at TEXT;

-- 非 NULL = 開催日アンカーモード（開催日の何日後か。0=当日, 1=翌日 ...）
ALTER TABLE scenario_steps ADD COLUMN anchor_offset_days INTEGER;

-- アンカーモード時の配信時刻 'HH:MM'（JST）。相対モードは NULL
ALTER TABLE scenario_steps ADD COLUMN send_time TEXT;
