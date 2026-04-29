# LINE Harness OSS — CLAUDE.md

## プロジェクト概要
LINE公式アカウント向けOSS CRM。
Cloudflare Workers + D1 + Next.js のモノレポ構成。
運営：WALOVER合同会社（沖縄県うるま市）

## 技術スタック
- API/Webhook: Cloudflare Workers + Hono (apps/worker)
- DB: Cloudflare D1 / SQLite (packages/db)
- 管理画面: Next.js 15 App Router (apps/web)
- 予約UI: Vite + vanilla TS (apps/worker/src/client/ → dist/client/)
- LINE SDK: 自作型付きラッパー (packages/line-sdk)

## ディレクトリ構成の原則
- APIルート追加 → apps/worker/src/routes/
- サービスロジック → apps/worker/src/services/
- DB変更 → packages/db/schema.sql に追記 + マイグレーション実行
- 共有型定義 → packages/shared/src/
- LIFFクライアント → apps/worker/src/client/（`apps/liff/` は存在しない）

## 必須ルール
- DBスキーマを変更したら必ずローカル・リモート両方にマイグレーション実行
- wrangler secret は .env に書かない（wrangler secret put を使う）
- LIFFビルド時は必ず3つの環境変数を指定する：
  VITE_LIFF_ID / VITE_API_BASE / VITE_CALENDAR_CONNECTION_ID
- デプロイ前に TypeScript のエラーがないことを確認する

## CIルール
- mainへのpush前に pnpm --filter worker test を実行してパスを確認する
- CIが赤い状態でのpushは禁止

## TDDルール
- 新しい関数を実装したら必ず同名の .test.ts ファイルにテストを書く
- テストは実装前に書く（RED → GREEN → REFACTOR）
- pnpm --filter worker test がpassしない状態でコミットしない
- テスト実行は必ず npx vitest run を使う
  （pnpm --filter worker test はBunが起動してクラッシュする場合がある）
- CI（GitHub Actions）では pnpm --filter worker test のままでOK
  （CI環境ではBunクラッシュは発生しない）
- テスト対象の優先順位：
  1. ビジネスロジック（スロット計算、バリデーション）
  2. サービス関数（google-calendar.ts, reminder処理）
  3. APIルートは統合テストで対応（Phase 2以降）

## Google Calendar認証管理
- OAuthトークンはgetValidAccessToken()経由で必ず取得する
  （access_tokenを直接使わない）
- refresh_tokenはOAuth初回認証時のみ取得できる
  （prompt:'consent' + access_type:'offline' が必須）
- トークン期限切れ時はADMIN_LINE_USER_IDに自動通知される
- 再認証URL：https://api.walover-co.work/api/integrations/google-calendar/auth
- Google Cloud ConsoleのOAuthアプリをテスト→本番に変更しないと7日で失効する

## やらないこと
- firebase / GCP 関連のコードを追加しない（Cloudflare統一）
- R2は現時点では使わない（画像アップロード機能は未実装）
- Gemini APIは使わない（Claude API or 直接ロジックで対応）
- 既存のauto_repliesロジックを勝手に変更しない

## デプロイコマンド
- Worker: pnpm deploy:worker
- LIFF: 以下をまとめて実行（/deploy スキル参照）
  VITE_LIFF_ID=1661159603-5qlDj5wV \
  VITE_API_BASE=https://api.walover-co.work \
  VITE_CALENDAR_CONNECTION_ID=0ba404af-3184-4640-bb56-d24c37c1f230 \
  pnpm --filter worker build && \
  npx wrangler pages deploy apps/worker/dist/client --project-name=line-harness-liff --branch=main
- 管理画面: pnpm --filter web run build

## 本番環境
- Worker URL: https://api.walover-co.work
- LIFF URL: https://liff.line.me/1661159603-5qlDj5wV
- 管理画面: https://admin.walover-co.work
- D1: line-harness (b41a1c65-a224-41bc-a99a-3284b43ea440)
- Google Calendar connectionId: 0ba404af-3184-4640-bb56-d24c37c1f230

## セットアップ手順書
- 管理画面デプロイ: docs/setup/admin-deploy.md
- （今後追加予定）Worker初期セットアップ: docs/setup/worker-setup.md
- （今後追加予定）LINE連携設定: docs/setup/line-setup.md

@my-preferences.md
