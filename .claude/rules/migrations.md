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
- **スキーマ変更は必ず番号付きのマイグレーションファイルにする。**
  `d1 execute --command` で直接流すと `d1_migrations` に残らず、CI の自動適用にも乗らないため、
  ローカル・他環境・新規インストールで再現できなくなる（`d1 execute` は確認用の読み取りに使う）。
- ローカルには `migrations apply --local` で適用して動作確認する。
- **本番への適用は通常 CI が行う**（`deploy-worker.yml` が deploy の前に
  `migrations apply --remote` を自動実行する）。手動適用は CI が使えない例外時のみ。
- リモート適用（`--remote`）は共有リソースへの操作。並列レーンでは走らせない・実行可否は人間に確認する。

## ⛔ テーブル再作成は子テーブルを道連れにする（#110・本番で消失）

CHECK 制約は `ALTER TABLE` で変更できないため、変えたいときはテーブル再作成になる。
**その素朴な手順は、子テーブルのデータを全部消す。**

```sql
-- ❌ この形で本番のデータが消えた（806 / 820）
CREATE TABLE scenarios_v3 (...);
INSERT INTO scenarios_v3 (明示列) SELECT 明示列 FROM scenarios;
DROP TABLE scenarios;        -- ← ここで子に ON DELETE が伝播する
ALTER TABLE scenarios_v3 RENAME TO scenarios;
```

SQLite は外部キーが有効なとき **`DROP TABLE` が暗黙の `DELETE FROM` を行い**、
子へ `ON DELETE CASCADE` / `SET NULL` が伝播する。
**親は `INSERT ... SELECT` で救われるのに、子は誰も救わない。**

2026-09-03 に 820 を適用し、`scenario_steps` が DB 全体で 0 件になった。
マイグレーションは成功し、親は残り、アプリもエラーを出さないため、
**配信されるはずの日に何も起きないことで 8 日後にようやく気づいた**。

### 伝播は 1 段では終わらない（#111）

子が CASCADE で消えるとき、**その子を参照している孫にも伝播する**。

```
DROP TABLE scenarios
  ├ scenario_steps    (CASCADE)   行が消える
  │   └ messages_log  (SET NULL)  紐付けが外れる   ← 2 段目。見落としやすい
  └ friend_scenarios  (CASCADE)   行が消える
```

### ⚠️ D1 では `PRAGMA foreign_keys = OFF` が効かない（2026-09-13 実測）

素の SQLite なら PRAGMA で止められるが、**D1 では止まらない**。
D1 は文ごとに実行するため PRAGMA の設定が次の文に持ち越されない
（`PRAGMA foreign_keys` を読むと既定で `1`）。

| 方法 | 素の SQLite | **D1** |
|---|---|---|
| 何もしない | 子が消える | 子が消える |
| `PRAGMA foreign_keys = OFF` | ✅ 子が残る | ❌ **子が消える** |
| `PRAGMA defer_foreign_keys = ON` | ❌ 子が消える | ❌ 子が消える |
| **子を退避して書き戻す** | ✅ 子が残る | ✅ **子が残る** |

> `defer_foreign_keys` は**制約チェックを遅らせるだけで、CASCADE 動作は止めない**。
> D1 のドキュメントで見かけるからと選ぶと、素の SQLite でも D1 でもデータが消える。

### ✅ 安全な型（D1 で実測済み・そのままコピペする）

**順序が命。** 下の順番を崩すと外部キー違反で途中失敗する（実際に踏んだ）。

```sql
-- ① 巻き添えになる子・孫を退避する
--    ⚠️ 退避対象は audit-cascade-loss.mjs で洗い出す。目視だと 2 段目を落とす。
CREATE TABLE _bk_scenario_steps AS SELECT * FROM scenario_steps;  -- CASCADE の子（行が消える）
CREATE TABLE _bk_messages_log   AS SELECT * FROM messages_log;    -- SET NULL の孫（紐付けが消える）

-- ② 親を作り直す
CREATE TABLE scenarios_v3 (...);
INSERT INTO scenarios_v3 (明示列リスト) SELECT 明示列リスト FROM scenarios;
DROP TABLE scenarios;                       -- ここで子は空・孫の紐付けは NULL になる（想定内）
ALTER TABLE scenarios_v3 RENAME TO scenarios;

-- ③ ★先に「子の行」を戻す
--    ⚠️ ここを飛ばして④をやると FOREIGN KEY constraint failed になる。
--       孫が指す先（子の行）がまだ存在しないため。
INSERT INTO scenario_steps (明示列リスト) SELECT 明示列リスト FROM _bk_scenario_steps;

-- ④ ★そのあと「孫の紐付け」を戻す
--    ⚠️ INSERT で戻そうとしてはいけない。SET NULL の孫は**行が残っている**ので
--       UNIQUE constraint failed になる。UPDATE で紐付け列だけ書き戻す。
UPDATE messages_log SET scenario_step_id = (
  SELECT b.scenario_step_id FROM _bk_messages_log b WHERE b.id = messages_log.id
) WHERE id IN (SELECT id FROM _bk_messages_log);

-- ⑤ 退避表を片付ける（残すと次の再作成で混乱する）
DROP TABLE _bk_scenario_steps;
DROP TABLE _bk_messages_log;
```

**復元の形は「消え方」で決まる**

| 巻き添えの種類 | 何が起きたか | 戻し方 |
|---|---|---|
| `ON DELETE CASCADE` | **行ごと消える** | `INSERT INTO <子> (明示列) SELECT ...` |
| `ON DELETE SET NULL` | 行は残り**紐付け列が NULL** | `UPDATE <子> SET <FK列> = (...)` |

**書くときのチェックリスト**

- [ ] `audit-cascade-loss.mjs` で**孫まで**洗い出したか（1 段で数えていないか）
- [ ] `SET NULL` の子も退避したか（行は残るが**紐付け列が NULL になる**）
- [ ] 戻す順番は「**子の行 → 孫の紐付け**」か（逆にすると FK 違反で落ちる）
- [ ] `SET NULL` の復元を `INSERT` で書いていないか（主キー衝突する）
- [ ] `INSERT` は**明示列リスト**か（`SELECT *` は実 DB の列順に依存して壊れる）
- [ ] 退避表を `DROP` したか
- [ ] **ローカル D1 に適用して、子・孫の件数と紐付け数が再作成の前後で一致**したか

```bash
# 適用前後で数えて比べる（apps/worker から実行）
pnpm exec wrangler d1 execute line-harness --local \
  --command="SELECT (SELECT COUNT(*) FROM <子>) AS child,
                    (SELECT COUNT(*) FROM <孫> WHERE <FK列> IS NOT NULL) AS link_kept"
```

### 影響範囲の洗い出し

```bash
# 本番の実スキーマで見る（schema.sql は実 DB とズレるので結論には使わない）
pnpm exec wrangler d1 execute line-harness --remote --json \
  --command="SELECT name, sql FROM sqlite_master WHERE type='table'" > /tmp/master.json
node packages/db/scripts/audit-cascade-loss.mjs --schema /tmp/master.json
```

過去 6 本の `DROP TABLE` の被害調査結果は `packages/db/MIGRATIONS.md` に記録済み。

> ⚠️ **適用済みのマイグレーションは修正しない。** ファイルを変えると再適用されて本番が壊れる。
> すでに消えたデータは、運営者が作り直すしかない。

> テーブル再作成の他の注意（実 DDL をカラム順まで確認する・enum 廃止は CHECK を触らない等）は
> `.claude/rules/api-coding.md` の D1 操作セクションを参照（worker src を触ると自動ロード）。


## 並列レーンでの採番（Issue #69・2026-09-06）

`next-migration-number.mjs` は**リモート追跡ブランチの採番も見る**ようになった。
ローカルだけを見ていたため、別ブランチで採番済みの番号が見えず、
**#66 と #67 が両方 824 を採番する**事故が起きた（2026-09-05）。
どちらもスクリプトの出力に従っただけで、手順の誤りではなかった。

### 採番の手順

```bash
git fetch                                                    # ← 先にこれ
node "$(git rev-parse --show-toplevel)/packages/db/scripts/next-migration-number.mjs"
```

⚠️ スクリプトは `git fetch` を**しない**（ネットワーク待ちで採番が止まるのを避けるため）。
見えるのは最後に fetch した時点のリモートなので、**採番の前に自分で fetch する**。

### 出力の読み方

```
次の採番: 827
現在の最大: 826 (826_receipt_share.sql)

リモートで採番済み（ローカルに無い番号を含む）:
  826 … origin/feature/47-receipt-share-link, origin/main
```

「リモートで採番済み」に**自分のブランチ以外**が出ていたら、その番号は使わない。

### 番号が衝突してしまったら

**push 済みの側が優先、未 push の側が振り直す。**
push 済みをリネームすると、`d1_migrations` がファイル名で適用済みを記録しているため
再適用されて本番が壊れる。

### git が使えない場所では

`⚠️ リモートの採番を確認できませんでした` と出る。
ローカルだけの結果なので、並列レーン中なら**別ブランチと衝突する可能性がある**。
`--no-remote` を明示すれば探索を省ける（CI やオフライン用）。

同じ⚠️は次の場合にも出る。いずれも「見たけど 0 件」ではなく**見ていない**という意味。

| 出る条件 | よくある原因 |
|---|---|
| リモート追跡ブランチが1本も無い | remote が `origin` という名前でない・新しい worktree でまだ fetch していない |
| 集計対象が `packages/db/migrations` ではない | `--dir` で別のディレクトリを指した・別リポジトリの中から絶対パスで叩いた |

### 一部のブランチだけ読めなかったとき

```
⚠️ 読めなかったリモートブランチ: origin/feature/xx
  これらのブランチが使っている番号は集計に入っていない（衝突の可能性あり）。
```

浅いクローンや壊れた ref で起きる。**そのブランチの番号は集計に入っていない**ので、
この警告が出たら `git fetch --unshallow` するか、そのブランチを直接見て確認する。
（読めた分の集計は続くので、採番自体は止まらない）
