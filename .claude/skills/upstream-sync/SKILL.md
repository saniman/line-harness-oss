# upstream-sync スキル

## 仕組み（2026-09 更新）

upstream との差分は **GitHub Actions が毎週自動で Issue 化**する。

```
毎週月曜 09:00 JST（.github/workflows/upstream-sync.yml）
  → upstream を fetch
  → scripts/upstream-sync-report.mjs が事実を集計
  → 未取り込み 0 件 / 同じ upstream HEAD の Open Issue あり → 何もしない
  → それ以外は Issue を起票（label: upstream-sync）
  → 🧑 人間が読む → /feature-plan で計画に育てる → /feature-implement
```

> 以前はクラウド定期エージェント（`/schedule`）が Gmail の下書きを作っていたが、
> **クラウドからは GitHub に書き込めない**（`gh` CLI が無く、GitHub MCP は 403）ことが
> Issue #17 の実測で判明したため Actions に移行した。

### ⚠️ 起票されるのは「事実」だけ

コミット一覧・変更ファイルの4分類・マイグレーションの採番のみを載せる。
**リスク評価と取り込み推奨は載せない。**

過去に自動生成した推奨は3回とも危険か不要だった:

| 推奨 | 実際 |
|---|---|
| 「050〜054 を 070番台にリナンバせよ」 | 実行すれば本番 D1 が壊れた（#32） |
| 「`git checkout upstream/main -- scheduled.test.ts`」 | fork に `scheduled.ts` が無くテストが落ちる（#37） |
| 「5分ティック最適化を適用検討」 | fork の cron は既に5分間隔で不要（#37） |

一方で事実は毎回正確だった。Issue 本文は計画の SSoT なので、検証していない推奨を
そこに置かない。**取り込むかどうかは `/feature-plan` で調査してから判断する。**

## 手動実行

```bash
# ローカルでレポートを見る（Issue は作らない）
git fetch upstream
node scripts/upstream-sync-report.mjs           # Markdown
node scripts/upstream-sync-report.mjs --json    # 件数だけ

# Actions を手動で走らせる（Issue が作られる）
gh workflow run upstream-sync.yml -R saniman/line-harness-oss
```

## ファイルの4分類

| 分類 | 条件 | 意味 |
|---|---|---|
| ✅ 更新候補 | upstream のみ変更・**fork にも存在** | そのまま取り込める可能性が高い |
| 🆕 未導入機能 | upstream のみ変更・**fork に無い** | 新機能。取り込み判断は #34 |
| ⚠️ 要確認 | 両側で変更 | 手動マージが要る |
| 💡 貢献候補 | fork のみ変更 | upstream への PR 候補（`docs/OSS-SYNC-CHARTER.md` セクション6） |

「upstream のみ変更」をひとまとめにすると、fork が採用していない機能まで
「取り込み可」に混ざる（実測で 83 件中 53 件がそれだった）ため存在判定で分けている。

## 取り込むときの注意

- **既存の migration ファイルはリネーム・削除しない**。採番は
  `node "$(git rev-parse --show-toplevel)/packages/db/scripts/next-migration-number.mjs"`
  で取得する（詳細は `.claude/rules/migrations.md`）
- upstream のファイルをそのまま `git checkout` すると、**fork に無いモジュールを import する
  テストが混ざって落ちる**ことがある（#37 の `scheduled.test.ts`）。取り込む前に
  依存が fork に存在するか確認する
- fork に無い機能のファイルは「取り込み可」ではない。#34 の判断に乗せる

## 同期地点の更新

`.claude/upstream-sync-state.json` の `last_synced_commit` は **実際に取り込んだときに人間か
エージェントが更新する**（CI は更新しない）。更新するまで同じ差分が毎週報告されるが、
それは backlog として正しい挙動。

## 状態管理ファイル

| ファイル | 役割 |
|---------|------|
| `.claude/upstream-sync-state.json` | 最終同期コミット |
| `scripts/upstream-sync-report.mjs` | 事実の集計（依存なし・読み取り専用） |
| `.github/workflows/upstream-sync.yml` | 週次実行と起票 |
