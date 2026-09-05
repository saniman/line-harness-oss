---
name: feature-review
description: PR の差分を /code-review でレビューし、PR にコメントする。CRITICAL/HIGH を人間と合意する。
argument-hint: "<PR番号>"
---

引数 `$ARGUMENTS` を PR 番号として、その差分をレビューしてください。
全体像は `docs/dev-workflow.md`。

## 手順

### 1. PR を把握
- `gh pr view $ARGUMENTS -R saniman/line-harness-oss` で概要・ひもづく Issue（`Closes #n`）を読む。
- `gh pr diff $ARGUMENTS -R saniman/line-harness-oss` で差分の規模感をつかむ。

### 2. レビュー本体は /code-review に委譲
- **先に `git branch --show-current` で、作業ツリーが対象 PR のブランチかを確認する。**
  一致していなければレビューを回さない（サブエージェントは作業ツリーで動くため、
  別ブランチをレビューした結果が返る。2026-09-05 に発生）。
  並列レーン中なら `git worktree` で自分のレーンを分ける（`AGENTS.md` 参照）。
- `/code-review --comment` を**この PR に対して**実行し、指摘を PR のインラインコメントとして残す。
- **返ってきた結果が名乗る対象（ブランチ名・head SHA）が、意図した PR と一致するか確認してから
  指摘に着手する。** 違っていれば、その結果は捨てる。
- 深いレビューが要る大きめ変更なら、人間に `/code-review ultra` を提案する（クラウド多エージェント・課金あり・人間トリガー）。
- この repo 固有の観点を必ず含める（`.claude/rules/` の落とし穴）:
  - auth skip リストの追加漏れ（LIFF/Stripe 公開エンドポイントが 401 になる）
  - JST 変換漏れ（人目に触れる箇所で UTC ISO がそのまま出る）
  - テスト fixture / LINE SDK モック名の更新漏れ（CI の tsc で落ちる）
  - LIFF の相対パス fetch（VITE_API_BASE 経由の絶対URLか）
  - 二重デプロイ・二重 cron 発火

### 3. 要約と合意
- CRITICAL / HIGH の指摘を要約し、それぞれ「**今この PR で直す** / **別 Issue に切る**」を人間と合意する。
- LOW / nits は任意。スコープを広げない。

### 4. 次の案内
- 「直す指摘があれば `/feature-address $ARGUMENTS` で修正してください（review↔address を反復）」と案内する。
- 別 Issue に切ると決めたものは `/feature-plan` で起票する。
