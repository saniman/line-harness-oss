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

### Google Calendar トークン期限切れ（invalid_grant）
症状: wrangler tail で `invalid_grant` が出る / Google Calendar に予定が入らない

1. refresh_token の保存状態を確認：
   npx wrangler@latest d1 execute line-harness --remote \
     --command="SELECT refresh_token IS NOT NULL as has_refresh, token_expires_at FROM google_calendar_connections"

2. has_refresh = false または token_expires_at が過去なら再認証：
   https://api.walover-co.work/api/integrations/google-calendar/auth
   → Google アカウントでログイン（consent 画面が出ること）

3. 再認証後に refresh_token が保存されたか確認（上記クエリを再実行）

注意:
- access_token を直接使わない → 必ず getValidAccessToken(env, db, connectionId) 経由
- /auth と /callback は認証スキップリストに入っていること（入っていないと再認証が 401 になる）
- Google Cloud Console で OAuth アプリを「テスト」のままにすると 7 日で失効する
