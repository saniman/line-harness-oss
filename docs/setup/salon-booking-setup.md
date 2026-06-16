# サロン予約機能 セットアップ & トラブルシュート

> 美容サロン向け「メニュー予約（スタッフ指名・シフトベース）」機能のセットアップ手順と、
> 本番投入時に実際に踏んだ落とし穴の対処をまとめたもの。
> 初期構築は 2026-06-16 のドライランで実証済み。

---

## 0. 2系統の予約があることを理解する

このプロダクトには**目的の違う予約が2つ**ある。混同しないこと。

| 予約システム | 用途 | テーブル | 管理画面 | 空き枠の決まり方 |
|---|---|---|---|---|
| 無料相談予約 | Google Calendar 連動の相談枠 | `calendar_bookings` | `/reservations`（無料相談予約） | Google Calendar の空き |
| サロン予約 | メニュー×スタッフ×シフトの本予約 | `bookings` | `/booking/bookings`（サロン予約） | **スタッフのシフト `staff_shifts`** |

- 両者は別テーブル・別ロジックなので、枠が直接かぶることはない。
- サロン納品時は「無料相談枠なし」前提でよい。相談を受けたい場合は**メニューとして作成し、担当スタッフを割り当てる**運用にする。

---

## 1. LINE Developers Console の設定（最重要・最初にやる）

サロン予約 LIFF（`?page=salon-book`）は、友だち判定とサーバー認証のため
**LINE Login チャネル側の設定が2つ**必要。これが無いと予約フローの手前でエラーになる。

### 1-1. 公式アカウント（bot）を LINE Login チャネルにリンクする

- **必要な理由**: `liff.getFriendship()`（友だち追加済み判定）に必須。
- **未設定時の症状**: LIFF画面に `There is no login bot linked to this channel.`
- **前提**: LINE Login チャネルと Messaging API チャネルが**同じプロバイダー**にあること。
- **手順**: LINE Developers Console → LINE Login チャネル → 「チャネル基本設定」最下部
  →「リンクされた LINE 公式アカウント」→ 編集 → 公式アカウントを選択して保存。

### 1-2. LIFF アプリのスコープに `openid` を追加する

- **必要な理由**: `liff.getIDToken()`（サーバー側で friend を特定するための ID トークン）に必須。
- **未設定時の症状**: `LINE 認証情報の取得に失敗しました。LINE アプリ内で再度開いてください。`
- **手順**: LINE Developers Console → LINE Login チャネル → 「LIFF」タブ → 対象 LIFF を開く
  → Scopes で `openid` にチェック（`profile` は既存）→ 保存。
- **反映**: スコープ変更後は LIFF を一度閉じて開き直す（初回は同意画面が出る）。

> いずれも「開発者アカウントでは気づきにくい」「該当フローを実機で通すまで顕在化しない」
> 種類の設定漏れ。LIFF 新規機能のリリース前は非開発者アカウントでE2Eを通すこと。

---

## 2. 管理画面での初期データ登録

順番が重要。**シフトまで登録しないと予約画面に枠が出ない。**

### 2-1. メニュー登録 — `/booking/menus`
- 名前・所要時間（分）・料金・バッファ（施術後の片付け時間）などを登録。

### 2-2. スタッフ登録 + メニュー紐付け — `/booking/staff`
- スタッフを登録する。
- **担当できるメニューを紐付ける**（`staff_menus`）。紐付けないと、そのメニューの担当として出てこない。
- 一人オーナーのサロンでは**オーナー自身をスタッフとして登録**してもらう（導入時に案内する）。

### 2-3. シフト登録 — `/booking/staff/shifts` （★空き枠の源）
- **空き枠はスタッフ個別のシフト `staff_shifts` から計算される**（店舗の営業時間テーブルではない）。
- シフトが1件も無いスタッフは、全日「この週に空きはありません」になる。
- 「空きが出ない」と言われたら**まずシフト登録を疑う**。

### 2-4. CVポイント登録 — `/conversions`
- 数字で効果を示すため、以下4つの CV ポイントを作成する。

| name | event_type |
|---|---|
| 友だち追加 | `friend_add` |
| 予約申込 | `booking_requested` |
| 予約確定 | `booking_confirmed` |
| 来店完了 | `booking_completed` |

---

## 3. CV自動記録の仕組み

予約のライフサイクルで `fireEvent` が発火し、`conversion_tracker` が対応する CV ポイントへ
`conversion_events` を自動記録する。

| 予約イベント | 発火タイミング | 記録される CV |
|---|---|---|
| `booking_requested` | LIFFで予約申込 | 予約申込 |
| `booking_confirmed` | 管理画面で承認 | 予約確定 |
| `booking_completed` | 管理画面で来店完了 | 来店完了 |

- CV は**友だち単位**で記録される（`payload.friendId` が無いとスキップ）。
- 予約フローは `friends.line_user_id` → `friendId` を解決して渡しているので、予約が動けば自動で積み上がる。
- 配線箇所: `apps/worker/src/routes/booking.ts`（fireEvent）→ `services/event-bus.ts` → `services/conversion-tracker.ts`

---

## 4. 既知のトラブルと対処（2026-06-16 ドライランで遭遇）

### 4-1. 管理画面でチャット履歴・友だちが表示されない
- **原因**: `line_accounts` に `default` 行を自動生成した結果、フロントが `lineAccountId=default` で
  フィルタするようになったが、既存の `friends`/`chats` は `line_account_id = NULL` だったため全件除外された。
- **対処**: 既存データを default 所属に移行する。
  ```bash
  npx wrangler@latest d1 execute line-harness --remote \
    --command="UPDATE friends SET line_account_id='default' WHERE line_account_id IS NULL;"
  npx wrangler@latest d1 execute line-harness --remote \
    --command="UPDATE chats SET line_account_id='default' WHERE line_account_id IS NULL;"
  ```

### 4-2. `There is no login bot linked to this channel.`
- → 「1-1. 公式アカウント（bot）リンク」を実施。

### 4-3. `LINE 認証情報の取得に失敗しました。`
- → 「1-2. LIFF スコープに `openid` 追加」を実施。

### 4-4. `メニュー情報の取得に失敗しました。The string did not match the expected pattern.`
- **原因**: サロン予約クライアントが `window.location.origin` ベースの**相対パス**でAPIを叩いていた。
  LIFFは Pages、APIは別ドメインの Worker のため、リクエストが Pages に飛び、返ってきたHTMLを
  `res.json()` がパースできず WebKit が上記エラーを出した。
- **対処**: クライアントの fetch は **`VITE_API_BASE` 経由の絶対 URL** にする
  （`apps/worker/src/client/salon-booking/lib/api.ts` の `withLiff` で対応済み）。

### 4-5. 日時選択で「この週に空きはありません」
- → 「2-3. シフト登録」を実施。空き枠はシフトベース。

---

## 5. 動作確認用 SQL

```bash
# 予約が入ったか
npx wrangler@latest d1 execute line-harness --remote \
  --command="SELECT id, status, starts_at FROM bookings ORDER BY created_at DESC LIMIT 5;"

# CVがイベント種別ごとに記録されたか
npx wrangler@latest d1 execute line-harness --remote \
  --command="SELECT cp.event_type, COUNT(*) AS n FROM conversion_events ce \
             JOIN conversion_points cp ON ce.conversion_point_id = cp.id \
             GROUP BY cp.event_type;"

# スタッフのシフトが登録されているか（空きが出ない時の最初の確認）
npx wrangler@latest d1 execute line-harness --remote \
  --command="SELECT COUNT(*) AS n FROM staff_shifts;"
```

---

## 6. 二重予約防止の仕様

- 空き枠計算（`services/availability.ts`）は、対象スタッフの `bookings`（status が
  `requested` / `confirmed`）を `staff_id` 単位で busy として差し引く。
- **メニューを区別しない**ため、同一スタッフが複数メニューを担当していても、
  片方のメニューで予約が入れば、その時間帯は他メニューでも選べなくなる。
- 回帰テスト: `apps/worker/src/services/availability.test.ts`
  「別メニューの予約でも同一スタッフなら同時間帯は除外（クロスメニュー二重予約防止）」。
