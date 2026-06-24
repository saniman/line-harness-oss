# サプライチェーン対策スキル（依存の公開直後インストール防止）

## 使い方
「サプライチェーン攻撃が怖い」「公開直後のバージョンを入れたくない」
「依存のクールダウンを設定して」と言われたら使う。

公開直後に差し替えられたマルウェア版（npm のアカウント乗っ取り等）を
取り込まないよう、**公開からN日未満のバージョンをインストールさせない**設定。

## 現在の設定（2026-06-24 導入済み）
- `package.json` の `packageManager`: **`pnpm@10.34.4`**
- `pnpm-workspace.yaml`: **`minimumReleaseAge: 10080`**（7日 = 7×24×60分）
- CI は `corepack enable pnpm` が `packageManager` を見るため、ワークフロー変更は不要

## 前提
- `minimumReleaseAge` は **pnpm 10.16+ の機能**。pnpm 9 以前には存在しない。
- pnpm 10 は **lockfile 9.0 をそのまま使う**ため、9→10 の更新で `pnpm-lock.yaml` は書き換わらない（低リスク）。
- pnpm 11 は lockfile 形式が変わる可能性があるため、最小リスクなら **10.x 系最新**に留めるのが無難。

## 新規に設定する／値を変える手順
1. pnpm が 10.16+ か確認。低ければ `package.json` の `packageManager` を `pnpm@<10.x最新>` に上げる
   （最新10.x: `npm view 'pnpm@^10' version | tail -1`）。
2. `pnpm-workspace.yaml` に設定（分単位）:
   ```yaml
   minimumReleaseAge: 10080   # 7日。3日なら 4320 など
   # 信頼するパッケージを即時許可したい場合だけ:
   # minimumReleaseAgeExclude:
   #   - "@line-crm/*"
   ```
3. 検証（既存 lockfile が壊れないこと・設定が読まれること）:
   ```bash
   npx --yes pnpm@10.34.4 install --frozen-lockfile
   # → "Lockfile is up to date" が出て、git diff で pnpm-lock.yaml が無変更なら OK
   git diff --stat pnpm-lock.yaml
   ```
4. `package.json` と `pnpm-workspace.yaml` のみコミット（lockfile は無変更なので add しない）。

## 運用の注意（重要）
- 設定後は **公開7日未満のバージョンへの追加・更新がブロックされる**（＝狙い通り）。
  依存追加・`pnpm update` のPRで最新パッチが7日未満だと失敗するので、慌てず日数を待つ。
- **緊急で新しい版が必要なとき**だけ一時回避:
  ```bash
  pnpm install --config.minimumReleaseAge=0
  ```
- ローカルも揃えるには各自 `corepack enable`（Node同梱）または `npm i -g pnpm@10.34.4`。

## やってはいけない
- 既存の `pnpm-lock.yaml` を pnpm 11 で不用意に書き換えない（形式差分が出る）。
- クールダウンを回避するために設定を消さない。回避は `--config.minimumReleaseAge=0` の一時フラグで。
