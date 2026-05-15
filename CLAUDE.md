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
- 決済: Stripe Checkout（stripe@22系, apiVersion: '2026-04-22.dahlia'）

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
- Stripe関連のsecretは wrangler secret put で設定する：
  STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET
  （セットアップ手順書: docs/setup/stripe-setup.md）

## CIルール
- mainへのpush前に pnpm --filter worker test を実行してパスを確認する
- CIが赤い状態でのpushは禁止

## CI/CDに関する既知の問題と対処

### Node.js 20 アクションの非互換問題（2026-05-15 対応済み）
GitHub のランナーが Node.js 24 に移行中のため、Node.js 20 ランタイムで動作する
GitHub Actions が CI で失敗する。対象アクション:
- `cloudflare/wrangler-action@v3` → `pnpm exec wrangler` の run ステップで代替
- `pnpm/action-setup@v4` → `corepack enable pnpm` の run ステップで代替

→ **原則**: アクション (uses:) は Node.js バージョン依存するため、
  代わりに `run:` ステップで直接コマンドを実行する

→ **deploy-liff.yml も注意**: wrangler-action@v3 が残っていたため同様に修正が必要

### wrangler 4系での破壊的変更
- `wrangler pages deploy` に `--account-id` フラグは存在しない
  → `CLOUDFLARE_ACCOUNT_ID` 環境変数で渡す
- `pnpm --filter worker exec wrangler` はワーキングディレクトリが `apps/worker` になる
  → Pages deploy の出力パスは `../web/out`（リポジトリルートからの `apps/web/out` ではない）
- GitHub Secrets の `CLOUDFLARE_ACCOUNT_ID` が未設定だと空文字列になり
  `wrangler.toml` の `account_id` を上書きしてしまう
  → 対処: deploy-worker.yml では env に渡さない、deploy-web.yml では値をハードコード

### SQLite ALTER TABLE 制約
CHECK 制約はALTER TABLEで変更不可。
既存のCHECK制約を変えたい場合はテーブル再作成が必要：
  1. 新テーブル作成（v2）
  2. INSERT INTO v2 SELECT * FROM 旧テーブル
  3. DROP TABLE 旧テーブル
  4. ALTER TABLE v2 RENAME TO 旧テーブル名

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
- Stripe決済統合: docs/setup/stripe-setup.md
- （今後追加予定）Worker初期セットアップ: docs/setup/worker-setup.md
- （今後追加予定）LINE連携設定: docs/setup/line-setup.md

@my-preferences.md
