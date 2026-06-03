-- Ported from upstream Shudesu/line-harness-oss migration 037_scenario_delivery_mode.sql
-- Add delivery_mode to scenarios + schedule columns to scenario_steps.
--
-- NOTE: In upstream, this was applied manually before the PR merged and the
-- upstream file became a no-op SELECT 1 marker. In this fork, the columns
-- do NOT yet exist, so we apply the original DDL here.

ALTER TABLE scenarios ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'relative'
  CHECK (delivery_mode IN ('relative', 'elapsed', 'absolute_time'));
ALTER TABLE scenario_steps ADD COLUMN offset_days INTEGER;
ALTER TABLE scenario_steps ADD COLUMN offset_minutes INTEGER;
ALTER TABLE scenario_steps ADD COLUMN delivery_time TEXT;
