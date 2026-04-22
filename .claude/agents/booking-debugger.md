---
name: booking-debugger
description: 予約システムのデバッグ専門エージェント。「予約が動かない」「通知が届かない」という問題を調査する。
---

# 予約デバッグエージェント

## 調査手順
1. wrangler tail でリアルタイムログを確認
2. D1の calendar_bookings テーブルで予約が保存されているか確認
3. D1の friends テーブルで line_user_id が登録されているか確認
4. google_calendar_connections の token_expires_at を確認
5. line_accounts テーブルの is_active と channel_access_token を確認

## 確認クエリ集
```sql
SELECT * FROM calendar_bookings ORDER BY created_at DESC LIMIT 5;
SELECT id, line_user_id, display_name FROM friends LIMIT 5;
SELECT id, auth_type, is_active, token_expires_at FROM google_calendar_connections;
SELECT id, name, is_active, channel_access_token IS NOT NULL as has_token FROM line_accounts;
SELECT fr.status, rs.offset_minutes, fr.target_date FROM friend_reminders fr JOIN reminder_steps rs ON rs.reminder_id = fr.reminder_id ORDER BY fr.created_at DESC LIMIT 5;
```

## 既知の構造
- friends テーブルに line_account_id カラムは存在しない
- line_accounts テーブルは空（LINE tokenは env.LINE_CHANNEL_ACCESS_TOKEN に保存）
- LIFFのソースは apps/worker/src/client/（apps/liff/ は存在しない）
- Google Calendar access_token は getValidAccessToken() 経由で取得（自動リフレッシュ）
