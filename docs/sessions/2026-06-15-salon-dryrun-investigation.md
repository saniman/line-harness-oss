# サロン外販・ドライラン調査レポート（2026-06-15）

## 目的

美容サロン1業種 × マネージド運用代行での外販を前提に、以下を調査した。

1. 売り方・事業ポジション（WordPress アナロジー含む）
2. LINE プラットフォーム依存リスク
3. ドライラン（成果計測込み）の実行可能性
4. upstream（[Shudesu/line-harness-oss](https://github.com/Shudesu/line-harness-oss)）との機能差分

**結論**: サロン予約 API は upstream に実装済み。fork には UI と DB マイグレーションのみ存在し API 層が欠落している。**新規実装ではなく upstream から booking バンドルを surgical に取り込む**のが正しい。CV 計測メニューは活用可能だが、自動記録の配線は upstream にも fork にも未実装。

---

## 1. 事業方向の決定事項

### 採用モデル

| 項目 | 決定 |
|------|------|
| ターゲット | 美容サロン1業種に絞る |
| 提供形態 | マネージド運用代行（月額ストック） |
| 検証環境 | WALOVER 本番 LINE アカウント（テスト用アカウントは不要） |
| 次の一手 | サロン1店舗ドライラン（成果を数字で証明する事例づくり） |

### 堀の置き方（WordPress アナロジー整理）

**WordPress アナロジーで正しい部分**

- OSS が「成果は欲しいが自分で作りたくない事業者」と「作れる人」の間に制作市場を生む
- 地域 × ニッチで先にポジションを取るのは全国競争より防御可能

**WordPress アナロジーで危険な部分**

- LINE Harness は「Claude Code から全操作可能」を売りにしており、**制作スキル単体の堀は短命**
- AI により供給側（作れる人）が一瞬で増える一方、需要側（沖縄 SMB オーナーの認知・支払い）は人間速度
- 「構築だけ」の単価は潰れやすい。**成果層（売上・予約数）の値付けは供給過剰の影響を受けにくい**

**堀の正しい置き方**

| 優先 | 内容 |
|------|------|
| 1 | 地域の信頼と顔 |
| 2 | 特定業種（サロン）の予約・集客パターンの暗黙知 |
| 3 | クライアントの売上という成果（数字で証明） |

**事業の正体**

- 開発会社でも純マーケ代理店でもなく、**「自動化の不当な武器を持ったマーケ運用者」**
- 技術（update-engine / MCP / API-first / CV 計測）は商品ではなく**利益率と再現性**として裏に隠す
- 対外ブランド: **「LINE 予約・自動化の専門家（実装は LINE Harness）」** — LINE Harness 専門家にしない

**収益モデル**

| フェーズ | 内容 |
|----------|------|
| 橋渡し | 初期構築費（LINE 側手作業 30 分/店 — Claude Code では触れない小さな堀） |
| 本丸 | 運用代行月額（シナリオ設計・配信戦略） |
| 前倒し | 成果報酬（CV 計測・bookings テーブルで証明できる客だけ） |

---

## 2. LINE プラットフォーム依存リスク（要約）

詳細は別途「LINE プラットフォーム依存リスク分析レポート（2026-06-14）」を参照。

| リスク | 発生可能性 | 「使えなくなる」影響 |
|--------|------------|---------------------|
| ① 料金改定（2026/10〜） | 高 | 低（トランザクショナル配信中心） |
| ② API 破壊的変更 | 中 | 低（保守で対応可） |
| ③ 規約変更 | 低 | 中 |
| ④ プラットフォーム戦略転換 | 不明 | 高 |
| 運用（規約違反 BAN） | 運用次第 | 高（個別） |

**技術的ヘッジ（コード調査結果）**

| 層 | チャネル中立度 | 備考 |
|----|----------------|------|
| 業務データ（予約・友だち・タグ・UUID） | ◎ | D1 に正規化。資産は手元に残る |
| 配信ロジック（タイミング・セグメント） | ◎ | LINE 非依存 |
| 送信窓口 | ○ | 大半は `LineClient` 経由。`calendar.ts` に直叩き push が2箇所残存 |
| メッセージ形式 | △ | Flex 等 LINE 専用 |
| UI（LIFF） | ✕ | 別チャネル移行時は作り直し |

「アダプタ1枚差し替え」は楽観的。**フロント＋変換層の作り直し（中核は再利用）**が正確な見積もり。

**今やるべきヘッジ（低コスト）**

1. 契約・顧問文面に「プラットフォーム追従」を明記
2. データエクスポートを営業武器として確実に持つ
3. 送信を `LineClient` 経由に統一（`calendar.ts` 直叩き潰し）

**今やらないこと**: マルチチャネル抽象化（ゴールから外れる）

---

## 3. 製造ライン（create-line-harness CLI）

`npx create-line-harness setup` の調査結果。

| 工程 | 状態 | 備考 |
|------|------|------|
| CF リソース（D1/R2/Worker/Admin） | ✅ 自動 | |
| マイグレーション | ✅ 自動 | |
| 再開・冪等性 | ✅ state 保存 | |
| LINE 側設定 | ⚠️ 手動 | Developers Console・LIFF・Webhook・応答設定 |
| 非対話バッチ | ❌ 未実装 | `--config` モードなし |
| CF アカウント設計 | ⚠️ 未決 | 集約 vs 顧客別 |

**1店舗あたり**: CLI 数分 + LINE 手作業約 30 分。最初の数店舗は手作業込みで十分。

---

## 4. CV 計測メニューの調査

管理画面 **CV計測**（`/conversions`）の実態。

### 使える部分 ✅

- CV ポイント CRUD（名前・イベントタイプ・金額）
- レポート（CV 数・売上合計）
- curl 不要でドライラン用ポイント定義可能

### 使えない部分（現状の穴）❌

**CV ポイントを作っただけでは数字は自動で増えない。**

```
【スコアリング】友だち追加 → event-bus → ルール照合 → 自動加算 ✅
【CV計測】     友だち追加 → event-bus → ??? → conversion_events に未記録 ❌
```

`trackConversion` が呼ばれるのは `POST /api/conversions/track` を明示的に叩いたときのみ。
管理画面のイベントタイプ（`friend_add` 等）は**ラベル**であり、自動計測トリガーではない。

**upstream 調査**: upstream にも CV 自動記録は未実装（`event-bus.ts` に `trackConversion` なし、`booking.ts` にも conversion フックなし）。

### ドライランでの計測設計（3層）

| 層 | データソース | 今すぐ | 用途 |
|----|--------------|--------|------|
| A | `conversion_events`（CV計測画面） | ポイント定義可、自動記録は要配線 | 営業用1枚レポート |
| B | `ref_tracking` / `friends` / `bookings` | ✅ ほぼ今すぐ | ファネル実数・成果報酬根拠 |
| C | `friend_scores`（スコアリング） | ✅ 自動 | 行動の厚み |

**推奨 CV ポイント（管理画面から作成）**

| CV名 | eventType | 備考 |
|------|-----------|------|
| 友だち追加 | `friend_add` | |
| 予約LIFF起動 | `liff_view` | |
| 予約申込 | `custom` | |
| 予約確定 | `custom` | メニュー単価 |
| 来店完了 | `purchase` | メニュー単価 |

**fork 独自で足すもの**: `event-bus` → CV 自動記録（upstream にも無い）

---

## 5. サロン予約機能 — upstream 調査（核心）

### 調査方法

```bash
git fetch upstream main
git diff --name-status HEAD upstream/main  # booking 関連
git show upstream/main:apps/worker/src/routes/booking.ts
```

upstream HEAD: `1c4adff`（2026-06-07 時点 v0.15.0 系）。fork との差分: **482 files, +76k / -22k lines**。

### upstream に存在するもの ✅

**Worker API** — `apps/worker/src/routes/booking.ts`（約 1,024 行）

LIFF 向け:

| エンドポイント | 用途 |
|----------------|------|
| `GET /api/liff/booking/menus` | メニュー一覧 |
| `GET /api/liff/booking/menus/:id/staff` | 担当スタッフ |
| `GET /api/liff/booking/availability` | 空き枠 |
| `POST /api/liff/booking/requests` | 予約申込 |
| `GET /api/liff/booking/me` | 予約履歴 |

管理向け（抜粋）:

- `/api/booking/admin/menus` CRUD
- `/api/booking/admin/staff` CRUD
- `/api/booking/admin/staff/:id/shifts` シフト管理
- `/api/booking/admin/requests` 予約一覧・承認

**付随サービス**（fork にすべて欠落）:

```
apps/worker/src/services/availability.ts
apps/worker/src/services/booking-state.ts
apps/worker/src/services/booking-idempotency.ts
apps/worker/src/services/booking-notifier.ts
apps/worker/src/services/booking-reminders.ts
apps/worker/src/services/booking-expirer.ts
apps/worker/src/services/booking-types.ts
（各 *.test.ts 含む）
```

**管理画面**（fork にすべて欠落）:

```
apps/web/src/app/booking/bookings/page.tsx   # 予約管理
apps/web/src/app/booking/menus/page.tsx      # メニュー
apps/web/src/app/booking/menus/staff/page.tsx
apps/web/src/app/booking/staff/page.tsx      # スタッフ
apps/web/src/app/booking/staff/shifts/page.tsx
```

**Cron 配線** — `apps/worker/src/index.ts` に booking-reminders / booking-expirer あり。

upstream コミット履歴（booking 追加）:

- `377d8f5` — LIFF booking app + inflow-links + events Phase 1
- `8dd667d` — booking friend-link + image inbox
- `d9abb90` — latest LINE OSS update

### fork の現状

| レイヤー | 状態 |
|----------|------|
| LIFF UI `apps/worker/src/client/salon-booking/` | ✅ あり（`?page=salon-book`） |
| DB マイグレーション `042_booking.sql` | 🟡 ファイルあり（upstream `036_booking.sql` と同系） |
| `packages/db/schema.sql` | ❌ **booking テーブル未反映**（`calendar_bookings` / `event_bookings` のみ） |
| `migrations_bootstrap.sql` | ❌ `042_booking.sql` 未登録 |
| Worker `routes/booking.ts` | ❌ **欠落** |
| booking サービス群 | ❌ **すべて欠落** |
| 管理画面 `/booking/*` | ❌ **欠落** |
| `index.ts` Cron 配線 | ❌ 未配線 |

**診断**: UI だけ先行取り込み済みで、**API・管理・Cron 層が未取り込み**。「API が無い」と判断したのは fork ローカルの事実。upstream にはフル実装あり。

### 取り込み時の競合リスク

| 項目 | 内容 |
|------|------|
| `index.ts` | fork 固有（ai-assistant, business-hours, Stripe events 等）と upstream 大規模再構成が競合 |
| マイグレーション番号 | upstream `036` ↔ fork `042`（中身同系、番号ルール上 fork は 800 番台と upstream 001-799 を分離） |
| イベント予約 | upstream は `event-booking-*` 分離、fork は Stripe 800 番台で別実装 |
| 全体 merge | **不可** — 2026-06-03 方針（選択的 cherry-pick）を継続 |

参照: `docs/sessions/2026-06-03-upstream-sync-strategy.md`

---

## 6. ドライラン計画（修正版）

### 目的

構築練習ではなく、**成果を数字で証明できる最初の事例**（Before/After）を作る。

### 北極星 KPI

- **月間確定予約数**（または 友だち追加 → 予約確定 のコンバージョン率）

### ファネル

```
ref 流入 / QR
  → 友だち追加          [ref_tracking / friends]
    → 予約 LIFF 起動    [liff_view CV / ログ]
      → 予約申込        [bookings.status=requested]
        → 確定          [bookings.status=confirmed]
          → 来店        [bookings.status=completed]
```

### Before（ドライラン前に必須）

過去 1〜3 ヶ月のベースラインをメモ:

- 月間予約数（チャネル別）
- 新規 vs リピート
- キャンセル率
- 平均単価

### 実行順序

| Phase | 内容 | 依存 |
|-------|------|------|
| 0 | 管理画面で CV ポイント5件 + エントリールート作成 | 今すぐ可 |
| 1 | **upstream から booking バンドル cherry-pick** | ブロッカー |
| 2 | `schema.sql` / D1 マイグレーション反映 | Phase 1 後 |
| 3 | メニュー・スタッフ・シフト投入 | Phase 2 後 |
| 4 | 本番 LINE で内部テスト（知人 2〜3 名） | Phase 3 後 |
| 5 | CV 自動記録配線（fork 独自） | Phase 4 と並行可 |
| 6 | モニター運用 + Before/After レポート | Phase 4 後 |

### 本番 LINE 使用時の注意

- テスト予約は自分・知人のみ
- 一斉配信はドライラン中控える
- 将来のクライアントは **1 店舗 = 1 公式アカウント**

---

## 7. 推奨アクション（優先順）

### 最優先: upstream booking バンドル取り込み

```bash
# 例: surgical checkout（index.ts / sidebar は手動マージ）
git checkout upstream/main -- \
  apps/worker/src/routes/booking.ts \
  apps/worker/src/services/availability.ts \
  apps/worker/src/services/booking-*.ts \
  apps/web/src/app/booking/
```

その後:

1. `apps/worker/src/index.ts` — route 登録 + Cron 手動マージ
2. `apps/web/src/components/layout/sidebar.tsx` — 「予約」セクション追加
3. `packages/db/schema.sql` — booking テーブル群追記
4. 本番 D1: `npx wrangler@latest d1 migrations list line-harness --remote` で pending 確認
5. `pnpm --filter worker test` → デプロイ

### 次点: fork 独自追加分

- `event-bus` → CV 自動記録（upstream に無い）
- 予約確定時 `booking_confirmed` CV 発火
- `calendar.ts` 直叩き push → `LineClient` 統一

### やらないこと（現時点）

- upstream 全体 merge（482 ファイル）
- サロン API のゼロから新規実装
- マルチチャネル抽象化
- テスト用 LINE アカウントの新規作成（本番で十分）

---

## 8. 進捗スナップショット

| 領域 | 状態 |
|------|------|
| 売り方の方向 | ✅ 美容サロン × マネージド × 成果報酬 |
| 事業ポジション | ✅ 予約・自動化スペシャリスト（技術は裏） |
| リスク設計 | ✅ 文書化済み |
| upstream 調査 | ✅ **booking は upstream 実装済み・fork 未取り込み** |
| CV 計測 | 🟡 UI 活用可、自動記録は fork 独自実装 |
| サロン予約 E2E | ❌ booking 取り込み待ち |
| 実績・数字 | ❌ 取り込み後にドライラン |

---

## 9. upstream booking バンドル取り込み（2026-06-15 実施）

upstream `1c4adff` から surgical cherry-pick を実施。

### 取り込んだファイル

**Worker**

- `apps/worker/src/routes/booking.ts`
- `apps/worker/src/services/availability.ts` (+ test)
- `apps/worker/src/services/booking-*.ts` (+ tests)

**管理画面**

- `apps/web/src/app/booking/**`（5 ページ）

**手動マージ**

- `apps/worker/src/index.ts` — route 登録 + Cron（reminders / expirer）
- `apps/worker/wrangler.toml` — `0 */6 * * *` cron 追加
- `apps/web/src/components/layout/sidebar.tsx` — 「予約」セクション
- `apps/web/src/lib/api.ts` — `bookingApi` クライアント
- `packages/db/schema.sql` — booking テーブル群追記

### テスト結果

```
apps/worker: 395 tests passed（booking 関連 50+ 含む）
```

### 本番デプロイ前の必須作業

042_booking.sql は **本番 D1 未適用**（MIGRATIONS.md 参照）。デプロイ前に:

```bash
cd apps/worker
npx wrangler@latest d1 migrations list line-harness --remote
npx wrangler@latest d1 migrations apply line-harness --remote
```

### 未実装（次フェーズ）

- CV 自動記録（`event-bus` → `trackConversion`）
- ドライラン用 CV ポイント定義 + Before ベースライン取得

---

## 参考

- [Shudesu/line-harness-oss](https://github.com/Shudesu/line-harness-oss) — upstream（v0.15.0 系）
- `docs/OSS-SYNC-CHARTER.md` — Private ↔ OSS 同期ルール
- `docs/sessions/2026-06-03-upstream-sync-strategy.md` — 選択的 cherry-pick 方針
- `docs/wiki/17-CV-Tracking-and-Affiliates.md` — CV 計測 API リファレンス
- `packages/db/migrations/042_booking.sql` — fork 側 booking スキーマ（API 未接続）
- upstream `apps/worker/src/routes/booking.ts` — サロン予約 API 本体
