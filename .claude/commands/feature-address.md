---
name: feature-address
description: PR のレビュー指摘を取り込んで修正し、チェックを通して push する。review↔address を反復する。
argument-hint: "<PR番号>"
---

引数 `$ARGUMENTS` を PR 番号として、レビュー指摘を修正してください。
全体像は `docs/dev-workflow.md`。

## 手順

### 1. 指摘を収集
- `gh pr view $ARGUMENTS -R saniman/line-harness-oss --comments` でレビューコメント（Claude/人間/クラウド）を集める。
- 「今この PR で直す」と合意した指摘だけを対象にする（スコープを広げない）。別 Issue 合意分は起票のみ。

### 2. その PR のブランチで修正
- `gh pr checkout $ARGUMENTS -R saniman/line-harness-oss`（または該当 `feature/…` ブランチに switch）。
- 指摘を修正する。回帰を生みやすい変更（テスト fixture・auth skip・共有型）は `.claude/rules/` を再確認。
- 修正で新しい振る舞いが増えたらテストも足す（TDD）。

### 3. チェックは最後の編集後にまとめて
- `npx vitest run` と `npx tsc --noEmit`（共有型/LIFF/DB を触ったら `docs/dev-workflow.md`「品質ゲート」の追加手順も）。

### 4. commit & push
- `/save` の手順で commit し、`git push`（同じ PR が更新される）。

### 5. 反復
- 追加レビューが要れば `/feature-review $ARGUMENTS` に戻る（review↔address を反復）。
- すべて解消し CI が green になったら「approve & `gh pr merge`（= 本番デプロイ）は人間が行う」と案内する。**エージェントはマージしない**。
