---
name: feature-implement
description: GitHub Issue の計画を読み、ブランチを切って TDD で実装し、チェックを通して commit する。
argument-hint: "<issue番号>"
---

引数 `$ARGUMENTS` を GitHub Issue 番号として、その計画に沿って実装してください。
全体像は `docs/dev-workflow.md`。

## 手順

### 1. 計画を読む
- `gh issue view $ARGUMENTS -R saniman/line-harness-oss` で Issue 本文（計画）を読む。
- 計画に不明点・齟齬があれば、実装前にユーザーに確認する（推測で進めない）。

### 2. ブランチを作成（main で作業しない）
- `git switch main && git pull` で最新化。
- `git switch -c feature/$ARGUMENTS-<英小文字スラッグ>`（スラッグはタイトルから簡潔に）。

### 3. TDD で実装（RED → GREEN → REFACTOR）
- `CLAUDE.md` の TDD ルールに従う。ビジネスロジック（スロット計算・バリデーション・状態遷移）は**先にテストを書く**。
- 対象別の落とし穴は `.claude/rules/` を必ず参照（サービス関数=`api-coding.md`・LIFF=`liff.md`・LINE通知=`line-messaging.md`）。
- DB スキーマ変更を伴うなら `/migrate` に乗せ、`packages/db/schema.sql` を同期。**リモート適用の可否は人間に確認**する。
- 外部SDK を services に渡すなら、SDK クラス型でなく**ミニマルな構造的インターフェース**を定義する（`.claude/rules/api-coding.md`）。

### 4. チェックは最後の編集後にまとめて
- `npx vitest run`（apps/worker から。`pnpm --filter worker test` は Bun クラッシュの恐れ）。
- `npx tsc --noEmit`（vitest は型を見ないので必須）。
- 共有型を変えたら `cd packages/shared && npm run build && cd ../../apps/web && npx tsc --noEmit`。
- LIFF クライアント（`apps/worker/src/client/**`）を触ったら `.claude/rules/liff.md` の手動 tsc コマンドを実行（CI が型検査しないため）。

### 5. commit
- `/save` の手順（個別 `git add`・`.env` 等の混入確認・日本語 `feat:`/`fix:` メッセージ・`Co-Authored-By` trailer）で commit する。

### 6. 次の案内
- 「チェックが緑になったら `/feature-pr $ARGUMENTS` で PR を作成してください」と案内する。
- 実装中にスコープ外の作業が必要と分かったら、勝手に広げずユーザーに相談する。
