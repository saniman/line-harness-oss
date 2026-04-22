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

## 既知の落とし穴
- friends テーブルに line_account_id カラムは存在しない（JOIN不可）
- LINE push のトークンは line_accounts テーブルが空のため env.LINE_CHANNEL_ACCESS_TOKEN を使う
- Google Calendar のアクセストークンは conn.access_token を直接使わず getValidAccessToken() を使う
