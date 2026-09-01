---
description: D1/SQLite マイグレーションの採番・適用・SQLite制約ルール（fork固有）
paths:
  - "packages/db/**"
  - "**/*.sql"
---
# マイグレーションルール（fork 固有・重要）

## ⛔ 既存のマイグレーションファイルをリネーム・削除しない（最重要）

**適用済みのマイグレーションファイルは、いかなる理由があってもリネーム・リナンバ・削除しない。**

理由: D1 は適用済みマイグレーションを `d1_migrations` テーブルに**ファイル名で**記録する。
さらに `deploy-worker.yml` が deploy の前に `d1 migrations apply --remote` を自動実行する。
適用済みファイルをリネームすると wrangler は「未適用の新規マイグレーション」と判断して**再実行**し、
`ALTER TABLE ... ADD COLUMN` は `duplicate column name` で落ちるか、中途半端に適用される。

### 番号の重複は「衝突」ではない

fork には既に **009 / 018 / 043 が 2 本ずつ**存在し、本番で正常に動作している。

```
009_delivery_type.sql    009_token_expiry.sql
018_broadcast_queue.sql  018_message_templates.sql
043_scenario_delivery_mode.sql  043_z_schema_gaps.sql
```

ファイル名が違えば `d1_migrations` 上は**別レコード**なので、番号が重なっていること自体は
再適用を引き起こさない。**これを「衝突」「要対処」と判断しないこと。**

> ⚠️ ただし**同番号のファイル同士の適用順は保証されない**。wrangler は数値プレフィックスだけで
> ソートし、同番号は tie-break しないため readdir（ファイルシステム）の順序が残る（4.0.0 で確認）。
> 実際この fork では `043_z_schema_gaps.sql` が `043_scenario_delivery_mode.sql` より先に適用され、
> ファイル名順とは逆になる。既存の 009 / 018 / 043 が無事なのは 3 組とも互いに独立だから。
> **依存関係のあるマイグレーションを同じ番号で作ってはいけない**（新規 DB への一括適用が
> マシンによって成功したり失敗したりする）。だからこそ新規追加は常に「最大 + 1」を使う。

> 2026-08-17 の upstream sync レポートが、この誤解から「fork の 050〜054 を 070番台に
> リナンバせよ」を CRITICAL として提案した。実行していれば本番 D1 が壊れていた（Issue #32）。

## 採番（常に「最大 + 1」）

新しいマイグレーションを追加するときは、**出自（fork 独自 / upstream 取り込み）を問わず
常に「現在の最大番号 + 1」**を使う。

番号は推論せず、必ずスクリプトで取得する（ハードコードした番号はすぐ陳腐化する）:

```bash
node "$(git rev-parse --show-toplevel)/packages/db/scripts/next-migration-number.mjs"
# 次の採番: 819
# 現在の最大: 818 (818_tracked_links_short_code.sql)
# 番号の重複（正常・対処不要）: 009, 018, 043
```

upstream のファイルを取り込む場合は、先頭に出典コメントを入れる:

```sql
-- Ported from upstream Shudesu/line-harness-oss migration 046_xxx.sql
```

### ⚠️ worktree 並列レーンでは番号が衝突しうる

スクリプトは**自分のブランチの migrations しか見ない**。AGENTS.md が勧める worktree 並列レーンで
レーン A とレーン B が同じ時期に実行すると、**両方が同じ番号（例: 819）を得る**。
両方が main にマージされると `819_a.sql` と `819_b.sql` が並び、上で警告した
「同番号の適用順は保証されない」状態を新規に作り出してしまう。

✅ **main へ rebase / merge した直後にスクリプトを再実行し、番号が衝突していたら
自分のファイルをリネームする。**

```bash
git fetch origin && git rebase origin/main
node "$(git rev-parse --show-toplevel)/packages/db/scripts/next-migration-number.mjs"
# 自分が 819 を使っていて、出力が「次の採番: 820」なら → 自分のを 820 にリネームする
```

> リネーム禁止は**適用済み・マージ済みのファイル**に対する規則。
> **まだ一度も適用もマージもされていない自分のファイル**のリネームは安全（`d1_migrations`
> にも main にも記録が無いため）。衝突を残したままマージする方が危険。

### ⚠️ 番号帯から出自は判別できない

かつて「001〜799 ＝ upstream 由来 / 800〜999 ＝ fork 固有」と定めていたが、
**実態はそうなっていない**。実ファイルを確認した結果は次のとおり:

| 番号帯 | 出自 |
|---|---|
| `001`〜`027` | fork 作成前から両方にある共通の祖先 |
| `028`〜`033` | **fork 固有**（business_hours・events・Stripe）。`800`〜`805` に同内容の写しがある |
| `034`〜`054` | **upstream 移植**（upstream の 028〜045） |
| `043_z_schema_gaps` | fork 固有 |
| `800`〜`815` | fork 固有（`800`〜`805` は `028`〜`033` の参照用コピー。⛔ 後述） |
| `816`〜`818` | **upstream 移植**（upstream の 046 / 048 / 049） |

つまり `001〜799` にも `800〜` にも両方の出自が混在している。
**出自はファイル先頭の `-- Ported from upstream ...` コメントの有無で判断すること。**

2026-06-03 に upstream の 028-033 と fork の 028-033 が別内容で衝突したため、
upstream の 028-045 を fork の 034-054 に移植して解消した。その際 fork 固有分を
800番台に整理する方針を立てたが、`028`〜`033` は本番適用済みのため残され、
`800`〜`805` は参照用の写しとして併存している（だから同じ内容が2つの番号で存在する）。

> ⛔ **「写しだから片方は消せる／再実行しても平気」は成り立たない。**
> 写しの中身は冪等ではない。`802` / `803` / `805` は `ALTER TABLE ADD COLUMN` で
> `duplicate column name` になり、**`804` は `DROP TABLE event_bookings` を含む**。
> しかも `804` が作る v2 の定義には後から `805` が足した返金カラムが無いため、
> 再適用させると**本番の予約データと列が失われる**（`806` にも `DROP TABLE` がある）。
> DDL 別の影響は `packages/db/MIGRATIONS.md` の該当表を参照。

詳細な経緯・設計乖離については `packages/db/MIGRATIONS.md` を参照。

## マイグレーションの適用コマンド

```bash
# 未適用の確認（apps/worker から実行）
npx wrangler@latest d1 migrations list line-harness --remote

# 適用
npx wrangler@latest d1 migrations apply line-harness --remote
```

wrangler 4.0.0 には `d1 execute --file` で相対パスを使うバグがあるため、
`npx wrangler@latest`（4.97.0+）を使うこと。

## schema.sql との同期
マイグレーション適用後は必ず `packages/db/schema.sql` も更新する。
schema.sql は新規インストール用の正規ソース（マイグレーションファイルと乖離すると新規セットアップ不可）。

## 必須ルール
- DBスキーマを変更したら必ずローカル・リモート両方にマイグレーション実行する。
- リモート適用（`--remote`）は共有リソースへの操作。並列レーンでは走らせない・実行可否は人間に確認する。

## SQLite ALTER TABLE 制約
CHECK 制約は ALTER TABLE で変更不可。既存の CHECK 制約を変えたい場合はテーブル再作成が必要：
  1. 新テーブル作成（v2）
  2. INSERT INTO v2 SELECT * FROM 旧テーブル
  3. DROP TABLE 旧テーブル
  4. ALTER TABLE v2 RENAME TO 旧テーブル名

> テーブル再作成の詳細な注意（実DDLをカラム順まで確認する・`SELECT *` を使わない・enum廃止はCHECKを触らない等）は
> `.claude/rules/api-coding.md` の D1操作セクションを参照（worker src を触ると自動ロード）。
