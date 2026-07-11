---
name: feature-pr
description: 実装ブランチを push し、Issue にひもづく PR を作成する（Closes #n）。
argument-hint: "<issue番号>"
---

引数 `$ARGUMENTS` を GitHub Issue 番号として、実装ブランチの PR を作成してください。
全体像は `docs/dev-workflow.md`。

## 手順

### 1. push 前の最終チェック
- `git status` で対象ブランチ（`feature/$ARGUMENTS-…`）にいること・作業中の無関係ファイルが混ざっていないことを確認。
- 品質ゲートが緑であることを確認（`npx vitest run` と `npx tsc --noEmit`。詳細は `docs/dev-workflow.md`「品質ゲート」）。

### 2. push
- `git push -u origin feature/$ARGUMENTS-<スラッグ>`。

### 3. PR を作成
- Issue 本文を `gh issue view $ARGUMENTS -R saniman/line-harness-oss` で読み、概要を PR 本文に反映する。
- 本文を一時ファイルに書き、`gh pr create -R saniman/line-harness-oss --base main --head feature/$ARGUMENTS-<スラッグ> --title "<簡潔なタイトル>" --body-file <一時ファイル>` で作成する。
  （**fork なので `-R saniman/line-harness-oss` 必須**）
- 本文は `.github/pull_request_template.md` の構造にする。先頭に **`Closes #$ARGUMENTS`**（main へ merge されれば Issue が自動クローズ）。

```
Closes #$ARGUMENTS

## 変更概要
（何を・なぜ）

## テスト結果
- [x] npx vitest run
- [x] npx tsc --noEmit
（LIFF/共有型/DB変更があればその検証も）

## レビュー観点
（特に見てほしい点・トレードオフ・スコープ外）
```

### 4. 次の案内
- 作成した PR 番号と URL を出力する。
- 「`/feature-review <pr#>` でレビューしてください」と案内する。
- **マージはしない**（CI green ＋ 人間の approve を確認してから、人間が `gh pr merge` する。merge = 本番デプロイ）。
