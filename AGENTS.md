# LINE Harness OSS — AGENTS.md

> **エージェント非依存のプロジェクト指示（SSoT）**。Claude Code / Codex / Cursor 等どのエージェントでも、
> まず本ファイルと `docs/dev-workflow.md` を読む。領域別の詳細は下記「詳細ルールの所在」の `.claude/rules/*.md` を
> **該当領域を触る前に Read** する（Claude Code は `paths` frontmatter で自動ロード。他エージェントは手動で開く）。
> このファイルは自己完結させる（`@import` を書かない＝Claude 以外もそのまま読めるようにする）。

## 作業スタイル（対人・全エージェント共通）
- ゴールから外れる提案をしないでください。
- ゴールに進む提案を必ずしてください。
- 回答には必ず「次のタスクはこれ」「今の進捗を全体像から整理するとこれ」を含めてください。
- 私が大学生だと思って、言語化してください。

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

機能追加は Issue ベースのパイプラインに乗せる（詳細な SSoT は `docs/dev-workflow.md`）。
計画の単一情報源は **GitHub Issue 本文**。独立 Issue が溜まったら **worktree 並列レーン**で消化する。

```
計画      → 調査・計画して Issue 作成（本文=計画）。作成後は人間の確認待ちで停止
実装      → feature/<n>-… ブランチ→TDD→vitest/tsc→commit
PR        → push→PR作成（Closes #n）
レビュー  → コード差分レビュー→PRにコメント
修正      → レビュー指摘を修正→push（レビュー↔修正を反復）
🧑 人間が approve → gh pr merge（= 本番デプロイ）
```

> Claude Code では各段が `/feature-plan` `/feature-implement` `/feature-pr` `/feature-review` `/feature-address`
> のスラッシュコマンド（`.claude/commands/`）。**他エージェント（Codex/Cursor）は `docs/dev-workflow.md` の手順を手動で辿る**。

**マージ規約**: `main` への merge = CI が本番へ自動デプロイ。そのため「**CI green ＋ 人間の approve を確認してから、人間が `gh pr merge`**」を厳守する。**エージェントはマージしない**。fork なので Issue/PR 操作は `-R saniman/line-harness-oss` を付ける。
**設計原則（肥大化させない）**: コマンド/エージェント/スキルは薄いオーケストレータにし、詳細は `docs/dev-workflow.md`・`.claude/rules/`・既存スキルへ委譲する。同じことを二重に書かない。

## 詳細ルールの所在（`.claude/rules/`）

該当領域を実装/修正する**前に一読すること**。Claude Code は `paths` で自動ロード、他エージェントは手動で Read する。

| rule | 対象領域 | 主な内容 |
|---|---|---|
| `api-coding.md` | `apps/worker/src/**`・`packages/line-sdk/**` | ルート/エラー/D1/共有型/テスト/Stripe/外部SDK型/日時/落とし穴/Google Calendar/TDD運用 |
| `liff.md` | `apps/worker/src/client/**` | LIFF初期化・ルーティング・絶対URL fetch・チャンネル公開 |
| `css.md` | `apps/worker/src/client/**` | index.html の共通クラス・カラーパレット |
| `line-messaging.md` | `apps/worker/src/**` | Flexレイアウト・トーン・6桁HEX・clipboard |
| `migrations.md` | `packages/db/**`・`*.sql` | 採番レンジ(800番台)・適用コマンド・schema.sql同期・SQLite制約 |
| `ci-cd.md` | `.github/workflows/**` | Node24移行・wrangler4破壊的変更・Pages日本語コミット拒否 |
| `deployment.md` | 全般（デプロイ時） | git push デプロイ・二重デプロイ禁止・fork の gh `-R`・サプライチェーン |

## 必須ルール（普遍・常時）
- wrangler secret は .env に書かない（`wrangler secret put` を使う）
- デプロイ前に TypeScript エラーがないことを確認する（`npx tsc --noEmit`。vitest は型を見ない）
- DBスキーマを変更したらローカル・リモート両方にマイグレーション実行（詳細は `.claude/rules/migrations.md`）
- LIFFビルド時は3環境変数を必ず指定：VITE_LIFF_ID / VITE_API_BASE / VITE_CALENDAR_CONNECTION_ID
- テスト実行はローカルでは `npx vitest run`（`pnpm --filter worker test` は Bun クラッシュの恐れ。CI は後者で可）

## やらないこと
- firebase / GCP 関連のコードを追加しない（Cloudflare統一）
- R2は現時点では使わない（画像アップロード機能は未実装）
- Gemini APIは使わない（Claude API or 直接ロジックで対応）
- 既存のauto_repliesロジックを勝手に変更しない

## デプロイ
通常は `git push origin main` で Worker / 管理画面 / LIFF すべて CI が自動デプロイする。
手動デプロイ（二重デプロイになるので CI が使えない例外時のみ）は `/deploy` スキル（Claude）または `.claude/rules/deployment.md` の手順参照。

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
