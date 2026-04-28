---
description: Worker APIルートのコーディングルール
globs: "apps/worker/src/**/*.ts"
---
# Worker APIコーディングルール

## ルート設計
- 認証が必要なエンドポイントは authMiddleware を必ず通す
- 公開エンドポイント（LIFF向け等）は auth.ts のスキップリストに明示的に追加する
- レスポンス形式は必ず { success: boolean, data?: any, error?: string }

## エラーハンドリング
- try/catch で握りつぶさない
- console.error でログを残す
- LINEへの通知はベストエフォート（失敗しても予約自体は成功させる）

## D1操作
- スキーマ変更時は schema.sql を更新してからマイグレーション実行
- IDは必ず crypto.randomUUID() を使う
- 日時は全て ISO 8601 形式で保存（JST変換はクライアント側で行う）

## テストルール
- src/services/*.ts を変更したら src/services/*.test.ts も更新する
- テストファイルの命名：対象ファイルと同名で .test.ts 拡張子
- describe名：機能名（日本語OK）
- it名：「〜の場合〜になる」形式で日本語で書く

## 既知の落とし穴
- friends テーブルに line_account_id カラムは存在しない（JOIN不可）
- LINE push のトークンは line_accounts テーブルが空のため env.LINE_CHANNEL_ACCESS_TOKEN を使う
- Google Calendar のアクセストークンは conn.access_token を直接使わず getValidAccessToken() を使う

### Google Calendar OAuth
- sendUpdates は URLクエリパラメータで渡す（ボディに入れても無視される）
  ✅ 正: POST .../events?sendUpdates=all
  ❌ 誤: body に sendUpdates: 'all' を含める

- refresh_tokenを確実に取得するには認証URLに以下が必須：
  access_type: 'offline'
  prompt: 'consent'
  どちらか欠けるとrefresh_tokenが返ってこない

- getValidAccessToken()を使わずaccess_tokenを直接使うと
  1時間でトークンが切れてAPIが動かなくなる

- /auth と /callback は認証スキップリストに入れること
  入れないと再認証時に {"error":"Unauthorized"} になる

### トークン期限切れの症状と対処
症状: Google Calendar APIが invalid_grant を返す
原因: refresh_tokenが未保存 or 期限切れ
対処:
  1. https://api.walover-co.work/api/integrations/google-calendar/auth にアクセス
  2. Googleアカウントで再認証
  3. D1のrefresh_tokenが更新されたことを確認：
     npx wrangler d1 execute line-harness --remote \
       --command="SELECT refresh_token IS NOT NULL as has_refresh, token_expires_at FROM google_calendar_connections"
