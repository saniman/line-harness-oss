# upstream 選択的同期の方針決定（2026-06-03）

## 背景

fork（saniman/line-harness-oss）が upstream（Shudesu/line-harness-oss）から大きく乖離し、
独自の Stripe 決済・Google Calendar 連携・診断システム等が追加された。
GitHub 上で「90 commits ahead, 48 commits behind」の状態になり、
「Sync fork」ボタンを押すと全コミットが消えるリスクがある状態になっていた。

## 決定事項

**全体 merge は行わない。upstream-sync エージェントによる選択的 cherry-pick 方式に移行する。**

### 理由

- fork は実質的に別プロジェクトになっており、upstream の変更を全て取り込む必要はない
- 全体 merge を試みると 18 ファイルのコンフリクトが発生し、特に events.ts は設計が根本的に異なる
- upstream の優れた機能だけを個別に取り込む方が安全かつ継続的

## 分析結果（2026-06-03 時点）

- 分析対象 upstream コミット: **48件**（merge-base: `f7f3a25`、upstream HEAD: `e791f2c`）
- 安全（取り込み推奨）: **約 240 ファイル**
- 要確認（競合リスク）: **26 ファイル**
- 貢献候補: **0件**（fork 固有機能は事業者依存のため現時点では PR 不可）

詳細レポートは `/upstream-sync` 実行後の `.claude/upstream-sync-report.md` を参照。

---

## 🔴 取り込む前に必ず手動対応が必要なファイル（4件）

### 1. `apps/worker/src/routes/events.ts`

| | upstream | fork |
|---|---|---|
| 規模 | 1371行 | 395行 |
| API パス | `/api/liff/events/*` と `/api/events/admin/events/*` | `/api/events/*` |
| 特徴 | スロット管理・冪等性制御・LIFF 認証を含む大型実装 | Stripe Checkout 統合が中核 |

**方針**: fork の Stripe フローを保持したまま、upstream の冪等性制御・availability 計算を
部分的に取り込む価値があるか検討する。全体置き換えは不可。

### 2. `apps/worker/src/routes/webhook.ts`

| | upstream | fork |
|---|---|---|
| 共通 | 1MiB ボディ制限・署名長事前チェック（両側で同一実装済み） | ← |
| upstream のみ | multi-account 署名検証・entry_routes リファラル処理 | — |
| fork のみ | — | WALOVER 固有ウェルカムメッセージ・診断・Stripe・Google Calendar |

**方針**: upstream の multi-account 署名検証は取り込む価値あり。fork の WALOVER 固有ロジックは保持必須。

### 3. `apps/worker/src/middleware/auth.ts`

upstream 追加: non-`/api/` 早期リターン・リッチメニュー画像パス・`LEGACY_API_KEY` フォールバック  
fork 追加: `/api/stripe/webhook`・Google Calendar OAuth・events 系 LIFF 公開エンドポイント

**方針**: 両側の追加を全て含む形でマージ可能。優先度中。

### 4. `packages/db/schema.sql`

upstream: broadcasts に multi-account 系カラム群・scenario_steps 拡張  
fork: diagnosis_sessions・events・event_bookings テーブル追加

**方針**: 今回の migration 適用（034-054）で fork の schema.sql を更新後、
upstream の追加カラムを取り込む。fork 固有テーブルは保持。

---

## ✅ 今すぐ取り込める主要ファイル

```bash
# 取り込みコマンドテンプレート
git checkout upstream/main -- <ファイルパス>
npx vitest run  # 各バッチ後にテスト実行
```

| カテゴリ | ファイル/ディレクトリ | 取り込み価値 |
|---------|---------------------|------------|
| 自己更新エンジン | `packages/update-engine/` 全体 | 高：OSS セルフアップデート機能 |
| 外部向け SDK | `packages/sdk/` | 高：外部連携用 SDK |
| セットアップ CLI | `packages/create-line-harness/` | 高：新規インストール自動化 |
| OGP 機能 | `apps/worker/src/lib/og-bot.ts`, `og-html.ts`, `og-resolver.ts` | 高：LINE リンクプレビュー |
| サロン予約 React UI | `apps/worker/src/client/salon-booking/` | 中：カレンダー予約 UI |
| 多言語 README | `README.md`, `README.en.md`, `README.es.md`, 等 | 低：コミュニティ向け |
| ドキュメント | `docs/manual/`, `docs/wiki/` | 低：操作マニュアル |
| CI テンプレート | `.github/ISSUE_TEMPLATE/`, `.github/PULL_REQUEST_TEMPLATE.md` | 低 |
| wrangler.toml | `nodejs_compat` フラグと `0 */6 * * *` cron のみ取り込み | 中 |

---

## ⚠️ マイグレーション衝突の対処済み状況

028-033 番号衝突は **2026-06-03 に解消済み**。

| 番号 | 内容 | 状態 |
|------|------|------|
| 028-033 | fork 固有（business_hours, events, Stripe）| fork の 800-805 に移植済み |
| 034-054 | upstream の 028-045 を移植 | fork に適用済み |
| 043_z | schema.sql 構築環境の gap-filler | 2026-06-03 適用済み |

upstream が今後追加するマイグレーションは `fork の最大番号 + 1`（現在 055 から）に採番すること。

---

## 今後の運用フロー

```
毎週月曜 9時（JST）
   ↓ /upstream-sync スケジュール自動実行
   ↓ .claude/upstream-sync-report.md 更新
   ↓ LINE push 通知
人間がレポートを確認して「取り込む / 保留 / 不要」を決定
   ↓
✅ 安全ファイル: git checkout upstream/main -- <path>
⚠️ 要確認ファイル: 差分を読んで手動マージ
   ↓ npx vitest run で確認
   ↓ git push origin main
```

### upstream-sync スキルの使い方

```bash
# 手動実行（即時レポート生成）
/upstream-sync

# dry-run（通知なし）
/upstream-sync --dry-run
```

### 状態管理ファイル

| ファイル | 役割 | git 管理 |
|---------|------|---------|
| `.claude/upstream-sync-state.json` | 最終分析コミット | ✅ コミット対象 |
| `.claude/upstream-sync-report.md` | 最新レポート（毎回上書き） | ❌ .gitignore 済み |
| `.claude/.env.upstream-sync` | LINE 認証情報 | ❌ .gitignore 済み |
