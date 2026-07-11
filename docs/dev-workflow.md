# 開発パイプライン（Issue → 計画 → 実装 → レビュー → PR → 承認マージ）

機能追加を毎回同じ品質・同じ導線で回すための仕組み。Claude Code のスラッシュコマンド群＋GitHub 連携で構成する。
（`~/@shopify/omusubi-app` のハーネス設計を、この repo の実態＝**main 直 push・CI 自動デプロイ・1環境**に合わせて移植したもの）

> **設計思想**: コマンドは薄いオーケストレータにする。詳細ロジックはこの `dev-workflow.md`・`.claude/rules/`・既存スキル（`/save`・`/retrospective`・`/migrate` 等）へ委譲し、**同じことを各コマンドに二重で書かない**（Harness Engineering の「肥大化させない」原則）。

## 全体像

```
[1] /feature-plan "<説明>"      調査→計画→自己レビュー→GitHub Issue 作成（本文=計画）
        └─ 🧑 人間: Issue の計画を確認・編集して GO
[2] /feature-implement <issue#>  ブランチ作成→TDD実装→チェック→commit
[3] /feature-pr <issue#>         push→PR 作成（Closes #n）
[4] /feature-review <pr#>        /code-review --comment で差分レビュー→PR にコメント
[5] /feature-address <pr#>       レビュー指摘を取り込み修正→push（[4]↔[5] を反復）
[6] 🧑 人間が approve → gh pr merge（規約）→ CI が本番へ自動デプロイ
```

- 計画の**単一情報源は GitHub Issue 本文**。GitHub 上で見え、編集でき、実装・PR から `gh issue view` で参照する。
- 各コマンドは `.claude/commands/*.md`。Claude が中で `gh` を実行する。

## この repo 固有の前提（omusubi との違い）

- **1環境・main 直**: `feature/* → PR → main`。omusubi の `develop→staging→main` の2環境昇格は無い。
- **CI 自動デプロイ**: `main` への merge で `Test / Deploy Worker / Deploy Web / Deploy LIFF` が発火（各 path filter 依存）。**merge = 本番反映**。だからこそ「人間が最後に merge」を厳守する。
- **`Closes #n` は自動発火する**: この repo は `main` がデフォルトブランチなので、PR が main に merge されれば Issue は自動クローズ（omusubi の手動クローズ問題は無い）。
- **fork の gh 注意**: upstream(Shudesu) remote があるため gh のデフォルト解決がズレる。**Issue/PR 操作は必ず `-R saniman/line-harness-oss` を付ける**（`.claude/rules/deployment.md` 参照）。

## 各コマンド

| コマンド | 役割 | 主な動作 |
|----------|------|----------|
| `/feature-plan "<説明>"` | 起点 | 既存コード/`.claude/rules/` を調査→計画ドラフト→自己レビュー→`gh issue create`。**作成後に停止し人間の確認を待つ** |
| `/feature-implement <issue#>` | 実装 | `gh issue view`→`feature/<issue#>-…` ブランチ→TDD（RED→GREEN→REFACTOR）→`vitest`/`tsc`→`/save` で commit |
| `/feature-pr <issue#>` | PR | push→`gh pr create --base main`（`Closes #<issue#>`・構造化本文） |
| `/feature-review <pr#>` | レビュー | `/code-review --comment` を PR に対して実行→CRITICAL/HIGH を要約し「今直す/別Issue」を合意 |
| `/feature-address <pr#>` | 修正 | レビュー指摘を収集→修正→チェック→push |

マージ用コマンドは**作らない**（最終承認とマージは人間）。

## 品質ゲート（実装・修正の push 前に必ず緑）

`.claude/rules/deployment.md` の「正しいデプロイ手順」に従う。最低限：

```bash
npx vitest run        # apps/worker から。pnpm --filter worker test は Bun クラッシュの恐れ
npx tsc --noEmit      # worker。vitest は型を見ないので必須
```

- **共有型（`@line-crm/shared`）を変えたら** `cd packages/shared && npm run build` → `cd apps/web && npx tsc --noEmit`（web は dist 参照。`.claude/rules/api-coding.md`）。
- **LIFF クライアント（`apps/worker/src/client/**`）を触ったら** CI が型検査しないので手動 tsc（コマンドは `.claude/rules/liff.md`）。
- **DB スキーマ変更を伴うなら** `/migrate` スキルに乗せ、`schema.sql` 同期とマイグレーション適用の可否は人間に確認する（`CLAUDE.md` のマイグレーション番号ルール）。

## 人間のチェックポイント

1. **計画**: `/feature-plan` 後、Issue の計画を読み、必要なら編集して GO を出す。
2. **実装後**: チェックが緑か、スコープが広がっていないかを確認。
3. **レビュー後**: CRITICAL/HIGH を「今直す/別Issue」で判断。
4. **マージ前**: CI green ＋ approve を確認し、自分で `gh pr merge` を押す（= 本番デプロイ）。

## マージ規約（重要）

- 人間が PR を `approve` し、CI が green であることを確認してから、**人間が** `gh pr merge <pr#> --squash -R saniman/line-harness-oss` する。
- **エージェントはマージしない**（merge = 本番反映のため特に厳守）。
- branch protection を将来足すなら GitHub 側のガードを追加するだけでよい（コマンド群は不変）。

## 並列開発（バックログが溜まったとき）

独立した Issue は **git worktree で分離した実装レーン**を並列に走らせて消化する。

```
メインセッション（オーケストレーター）
  ├─ レーンA: git worktree + サブエージェント（1 Issue = 1 worktree = 1 branch = 1 PR）
  ├─ レーンB: 〃
  └─ レーンC: 〃（同時 2〜3 レーンまで）
```

- **並列可否はファイルの重なりで決める**。複数レーンが同じホットファイルに触る組み合わせは同バッチに入れない。この repo のホットファイル例: `apps/worker/src/routes/webhook.ts`・`apps/worker/src/index.ts`・`packages/db/schema.sql`・`CLAUDE.md`・`packages/shared/src/index.ts`。
- **各レーンの規律は直列時と同じ**（`/feature-implement` 相当: TDD・チェック一括・`/save` commit 規約）。品質ゲートは緩めない。
- **テストは純ローカル**（`npx vitest run` は Miniflare/メモリで完結）なのでレーン間で衝突しにくい。ただし **`wrangler d1 ... --remote` や本番 D1 を触る作業は共有リソースなので並列にしない**（マイグレーション適用・remote シードは直列・人間確認）。
- worktree ごとに `node_modules` を張り直す必要がある場合は `pnpm install` を各 worktree で実行する。
- main が進んだら（他レーンの merge）、残レーンのブランチはオーケストレーターが rebase して追随させる。マージ順は「小さく独立なものから」。

## 一周の例

```
/feature-plan "予約リマインドを前日と当日の2回送れるようにする"
# → Issue #NN 作成。内容を確認・編集
/feature-implement NN
# → feature/NN-two-stage-reminder ブランチで実装・チェック緑・commit
/feature-pr NN
# → PR #MM 作成（Closes #NN）
/feature-review MM
# → /code-review が PR にコメント。CRITICAL/HIGH を相談
/feature-address MM
# → 指摘を修正して push（必要なら review↔address を反復）
# 🧑 approve して gh pr merge MM --squash -R saniman/line-harness-oss（= 本番デプロイ）
```

## 再利用している既存の仕組み

- `/code-review` … PR レビュー本体（`--comment` で PR にコメント、`--fix` で適用、`ultra` でクラウド多エージェント）。
- `/save` … commit 規約（個別 add・`.env` 混入確認・日本語 `feat:`/`fix:`・`Co-Authored-By`）。
- `/migrate` … DB マイグレーション（SQLite ALTER 制約の自動分岐）。
- `/retrospective` … セッション振り返り → `.claude/rules/` / memory へ自己改善フィードバック。
- `.claude/rules/*` … コーディング規約・落とし穴の SSoT（api-coding / css / deployment / line-messaging / liff）。
