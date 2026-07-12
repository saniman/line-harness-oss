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

## 開発思想：Harness Engineering

AI は実装・調査・提案を担う。**最終判断は人間**が行う。
- 実装前に必ず設計を提案し、確認を取る。不明点は推測で進めず質問する
- スコープ外の機能を勝手に実装しない。品質・設計・安全性を速度より優先する

### 開発パイプライン（Issue→計画→実装→レビュー→PR→承認マージ）

機能追加は **`/feature-*` スラッシュコマンドのパイプライン**に乗せる（詳細な SSoT は `docs/dev-workflow.md`）。
計画の単一情報源は **GitHub Issue 本文**。独立 Issue が溜まったら **worktree 並列レーン**で消化する。

```
/feature-plan "<説明>"    → 調査・計画して Issue 作成（本文=計画）。作成後は人間の確認待ちで停止
/feature-implement <n>    → feature/<n>-… ブランチ→TDD→vitest/tsc→/save でcommit
/feature-pr <n>           → push→PR作成（Closes #n）
/feature-review <pr#>     → /code-review --comment で差分レビュー→PRにコメント
/feature-address <pr#>    → レビュー指摘を修正→push（review↔address を反復）
🧑 人間が approve → gh pr merge（= 本番デプロイ）
```

**マージ規約**: `main` への merge = CI が本番へ自動デプロイ。そのため「**CI green ＋ 人間の approve を確認してから、人間が `gh pr merge`**」を厳守する。**エージェントはマージしない**。
**設計原則（肥大化させない）**: コマンド/エージェント/スキルは薄いオーケストレータにし、詳細は `docs/dev-workflow.md`・`.claude/rules/`・既存スキルへ委譲する。同じことを二重に書かない。

## 詳細ルールの所在（`.claude/rules/` は `paths` で自動ロード）

対象ファイルを触ると該当ルールが自動でコンテキストに入る（常時ロードではない）。**該当領域を実装/修正する前に一読すること**。

| rule | 自動ロード対象 | 主な内容 |
|---|---|---|
| `api-coding.md` | `apps/worker/src/**`・`packages/line-sdk/**` | ルート/エラー/D1/共有型/テスト/Stripe/外部SDK型/日時/落とし穴/Google Calendar/TDD運用 |
| `liff.md` | `apps/worker/src/client/**` | LIFF初期化・ルーティング・絶対URL fetch・チャンネル公開 |
| `css.md` | `apps/worker/src/client/**` | index.html の共通クラス・カラーパレット |
| `line-messaging.md` | `apps/worker/src/**` | Flexレイアウト・トーン・6桁HEX・clipboard |
| `migrations.md` | `packages/db/**`・`*.sql` | 採番レンジ(800番台)・適用コマンド・schema.sql同期・SQLite制約 |
| `ci-cd.md` | `.github/workflows/**` | Node24移行・wrangler4破壊的変更・Pages日本語コミット拒否 |
| `deployment.md` | **常時**（デプロイ知識は横断的） | git push デプロイ・二重デプロイ禁止・fork の gh `-R`・サプライチェーン |

## 必須ルール（普遍・常時）
- wrangler secret は .env に書かない（`wrangler secret put` を使う）
- デプロイ前に TypeScript エラーがないことを確認する（`npx tsc --noEmit`。vitest は型を見ない）
- DBスキーマを変更したらローカル・リモート両方にマイグレーション実行（詳細は migrations rule）
- LIFFビルド時は3環境変数を必ず指定：VITE_LIFF_ID / VITE_API_BASE / VITE_CALENDAR_CONNECTION_ID

## やらないこと
- firebase / GCP 関連のコードを追加しない（Cloudflare統一）
- R2は現時点では使わない（画像アップロード機能は未実装）
- Gemini APIは使わない（Claude API or 直接ロジックで対応）
- 既存のauto_repliesロジックを勝手に変更しない

## デプロイ
通常は `git push origin main` で Worker / 管理画面 / LIFF すべて CI が自動デプロイする。
手動デプロイ（二重デプロイになるので CI が使えない例外時のみ）は `/deploy` スキル参照。
デプロイの規約・落とし穴の詳細は `.claude/rules/deployment.md`（常時ロード）。

## 本番環境
- Worker URL: https://api.walover-co.work
- LIFF URL: https://liff.line.me/1661159603-5qlDj5wV
- 管理画面: https://admin.walover-co.work
- D1: line-harness (b41a1c65-a224-41bc-a99a-3284b43ea440)
- Google Calendar connectionId: 0ba404af-3184-4640-bb56-d24c37c1f230

## セットアップ手順書
- 管理画面デプロイ: docs/setup/admin-deploy.md
- Stripe決済統合: docs/setup/stripe-setup.md
- 開発パイプライン: docs/dev-workflow.md

@my-preferences.md
