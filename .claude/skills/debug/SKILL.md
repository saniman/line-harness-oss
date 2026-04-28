# デバッグスキル

## 使い方
「動かない」「エラーが出る」と言われたら使う

## ログ確認
npx wrangler tail line-harness --format pretty

## D1データ確認
npx wrangler@latest d1 execute line-harness --remote \
  --command="SELECT * FROM <テーブル名> ORDER BY created_at DESC LIMIT 10"

## よくある原因と対処

### LIFF「空き枠なし」
→ VITE_CALENDAR_CONNECTION_ID が空文字でビルドされている
→ 手動ビルド: VITE_CALENDAR_CONNECTION_ID=0ba404af-... pnpm --filter worker build && wrangler pages deploy ...

### LINE通知が届かない
→ line_accounts テーブルが空 → env.LINE_CHANNEL_ACCESS_TOKEN を使う（calendar.ts 参照）
→ lineUserId が未設定 → LIFF の booking.ts で liff.getProfile().userId を渡しているか確認

### Google Calendar登録されない
→ access_token 期限切れ → getValidAccessToken() を使う（conn.access_token 直接使用はNG）

### Google Calendar招待メールが届かない
1. D1のrefresh_tokenを確認：
   npx wrangler d1 execute line-harness --remote \
     --command="SELECT refresh_token IS NOT NULL as has_refresh FROM google_calendar_connections"
2. falseなら再認証が必要：
   https://api.walover-co.work/api/integrations/google-calendar/auth
3. wrangler tailで invalid_grant エラーが出ていないか確認

### リマインダーが届かない
→ friend_reminders の status が 'active' か確認
→ target_date + offset_minutes が現在時刻以前か確認
→ cron は */5 * * * * で動作中

### liff.state ルーティングが効かない
→ getPage() が liff.state パラメータを展開しているか確認（main.ts 参照）
