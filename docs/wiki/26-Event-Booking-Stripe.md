# 26. イベント予約 & Stripe決済 (Event Booking + Stripe)

## 概要

LINE Harness のイベント予約機能は、LIFF から Stripe Checkout を経由してイベント参加費を決済し、
Webhook で予約を確定する仕組み。有料・無料の両フローをサポートする。

SP6（2026-05-16 完了）として実装。

---

## データモデル

### events テーブル（関連カラム）

```sql
CREATE TABLE events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  description  TEXT,
  event_date   TEXT NOT NULL,              -- ISO 8601
  capacity     INTEGER NOT NULL DEFAULT 0, -- 0 = 無制限
  price        INTEGER,                    -- NULL or 0 = 無料、1以上 = 有料（円）
  location     TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### event_bookings テーブル

```sql
CREATE TABLE event_bookings (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id          INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  line_user_id      TEXT NOT NULL,
  name              TEXT NOT NULL DEFAULT '',
  email             TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK(status IN ('pending','confirmed','cancelled')),
  stripe_session_id TEXT,                          -- Stripe Checkout Session ID
  payment_status    TEXT NOT NULL DEFAULT 'unpaid'
                    CHECK(payment_status IN ('unpaid','paid','refunded')),
  paid_at           DATETIME,
  amount            INTEGER,                       -- 実際に決済された金額（円）
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### status / payment_status 運用ルール

| status    | payment_status | 意味                                  |
|-----------|----------------|---------------------------------------|
| pending   | unpaid         | Stripe Session 作成済み・未決済（30分で失効） |
| confirmed | paid           | 決済完了・参加確定                     |
| confirmed | unpaid         | 無料イベント・直接申込で確定           |
| cancelled | unpaid         | キャンセル済み                         |

**重要**: `participant_count`（定員チェック）は `status = 'confirmed'` のみカウントする。
`pending` を含めると「仮登録で満席になる」問題が発生する。

---

## 決済フロー全体図

```
[LIFF ユーザー]
    │
    ├─ price が null or 0（無料）
    │       → POST /api/events/:id/join
    │         name / email を受け取り即 confirmed に保存
    │         LINE Flex Message 送信
    │
    └─ price が 1 以上（有料）
            → POST /api/events/:id/checkout-session
              ┌─ 定員チェック（confirmed のみカウント）
              ├─ event_bookings に仮登録（status=pending）
              ├─ Stripe Checkout Session 作成
              │   success_url = LIFF_BASE_URL?page=event&eventId=:id&payment=success
              │   cancel_url  = LIFF_BASE_URL?page=event&eventId=:id&payment=cancel
              │   metadata: { bookingId, lineUserId, eventId }
              └─ session.url を返す
                    │
                    ↓
            [Stripe 決済ページ（外部）]
                    │
                    ↓
            POST /api/stripe/webhook（Stripe → Worker）
              ┌─ constructEventAsync で署名検証
              ├─ checkout.session.completed イベントを処理
              ├─ metadata から bookingId / lineUserId / eventId を取得
              ├─ confirmEventBooking:
              │   UPDATE event_bookings SET
              │     status = 'confirmed', payment_status = 'paid',
              │     paid_at = datetime('now'), amount = ?,
              │     name = COALESCE(?, name), email = COALESCE(?, email)
              │   WHERE id = ?
              └─ LINE Flex Message 送信（ベストエフォート）
                    │
                    ↓
            [LIFF: ?payment=success 画面] ← ユーザーはここに戻る
```

---

## API 仕様

### POST /api/events/:id/checkout-session

**認証**: 不要（auth skipリストに追加済み）

**リクエスト**:
```json
{ "lineUserId": "Uxxxxxxxxx" }
```

**レスポンス**:
```json
{ "success": true, "data": { "url": "https://checkout.stripe.com/..." } }
```

**エラーレスポンス**:
- 404: イベントが存在しない / 価格未設定
- 409: 定員オーバー
- 500: Stripe API エラー

### POST /api/stripe/webhook

**認証**: 不要（auth skipリストに追加済み）

**処理内容**:
1. `c.req.text()` で raw body 取得（`req.json()` は署名検証失敗するため使わない）
2. `stripe.webhooks.constructEventAsync(rawBody, sig, secret)` で署名検証
3. `checkout.session.completed` のみ処理（他は 200 で無視）
4. `session.metadata` から bookingId / lineUserId / eventId を取得
5. `session.customer_details.name` / `session.customer_details.email` を保存
6. `confirmEventBooking` でDB更新
7. LINE Flex Message 送信

### POST /api/events/:id/join（無料イベント用）

**認証**: 不要

**リクエスト**:
```json
{ "lineUserId": "Uxxxxxxxxx", "name": "山田太郎", "email": "yamada@example.com" }
```

---

## 実装ファイル一覧

| ファイル | 役割 |
|---------|------|
| `apps/worker/src/routes/events.ts` | `checkout-session` / `join` エンドポイント |
| `apps/worker/src/routes/stripe.ts` | Webhook 受信・booking 確定 |
| `apps/worker/src/services/events.ts` | `confirmEventBooking` / `getEventBookings` |
| `apps/worker/src/client/event-booking.ts` | LIFF: イベント一覧・詳細・申込UI |
| `apps/worker/src/client/main.ts` | `?page=event` ルーティング |
| `apps/web/src/app/events/` | 管理画面: イベント一覧・詳細 |
| `packages/db/migrations/030_stripe.sql` | event_bookings に Stripe カラム追加 |
| `packages/db/migrations/031_events_price.sql` | events に price カラム追加 |
| `packages/db/migrations/032_event_bookings_pending.sql` | status CHECK 制約にpending追加（テーブル再作成） |

---

## Stripe セットアップ手順

詳細は `docs/setup/stripe-setup.md` を参照。要点は以下：

### 1. シークレットキー登録

```bash
npx wrangler secret put STRIPE_SECRET_KEY
# → sk_live_... を入力

npx wrangler secret put STRIPE_WEBHOOK_SECRET
# → whsec_... を入力（Webhook エンドポイント作成後）
```

### 2. Stripe ダッシュボードで Webhook エンドポイント登録

- URL: `https://api.walover-co.work/api/stripe/webhook`
- イベント: `checkout.session.completed`
- 作成後に表示される「署名シークレット（whsec_...）」を上記コマンドで登録

### 3. Stripe インスタンスの初期化（Cloudflare Workers 必須設定）

```typescript
import Stripe from 'stripe'

const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
  apiVersion: '2026-04-22.dahlia',
  httpClient: Stripe.createFetchHttpClient(), // Node.js http モジュール非対応のため必須
})
```

---

## LIFF 実装の注意点

### 有料 / 無料の分岐ロジック

```typescript
if (!event.price || event.price === 0) {
  // 無料フロー: 名前・メール入力フォームを表示して /join へ POST
  renderFreeBookingForm(event)
} else {
  // 有料フロー: /checkout-session へ POST → liff.openWindow で Stripe へ遷移
  startCheckoutSession(event.id)
}
```

### 決済完了後の画面遷移

Stripe の `success_url` には `?payment=success` を付与し、
LIFF に戻った際に `URLSearchParams` で判定して完了メッセージを表示する：

```typescript
const payment = new URLSearchParams(window.location.search).get('payment')
if (payment === 'success') renderPaymentSuccess()
if (payment === 'cancel')  renderPaymentCancel()
```

---

## 管理画面（apps/web）

### イベント参加者一覧

`getEventBookingsAdmin` は全ステータスの予約を返す（ユーザー向け `getEventBookings` は confirmed のみ）。

表示カラム:
- 名前 / メール / ステータス / **決済バッジ** / **決済金額** / 申込日時

決済バッジ:
- `paid` → 緑「決済済」
- `unpaid` + `confirmed` → 青「無料」
- `unpaid` + `pending` → 黄「未決済」

---

## テスト

```bash
# 全テスト実行
npx vitest run

# Stripe Webhook テストのみ
npx vitest run src/routes/stripe.test.ts
```

### テストカバレッジ（stripe.test.ts）

- `checkout.session.completed` 正常系（name/email 保存確認）
- `customer_details` が null の場合も booking 確定される
- 不正な署名 → 400
- bookingId が metadata に存在しない → 200（スキップ）
- `checkout.session.completed` 以外のイベント → 200（無視）

---

## 既知の落とし穴・ハマりポイント

### 1. Webhook で name/email が保存されない
**原因**: `confirmEventBooking` に name/email の引数がなく、空文字のまま確定されていた。  
**対処**: `session.customer_details?.name` / `session.customer_details?.email` を取得して COALESCE で保存。  
コミット: `e5552b8`

### 2. checkout-session エンドポイントが 401 になる
**原因**: 認証スキップリストに未追加だった。  
**対処**: `apps/worker/src/middleware/auth.ts` の skipList に追加。  
コミット: `167d420`

### 3. Stripe Webhook エンドポイントが未登録だと stripe_events が 0 件
**症状**: Stripe ダッシュボードでは `checkout.session.completed` が発火しているのに Worker が受信しない。  
**対処**: Stripe ダッシュボード → Developers → Webhooks → Add endpoint で登録する。

### 4. participant_count に pending を含めると満席問題が起きる
**原因**: `pending` 仮登録が多い場合に定員オーバーと判定されてしまう。  
**対処**: 定員チェックは `status = 'confirmed'` のみ集計する。

### 5. Stripe の raw body は `req.text()` で取得する
**原因**: `req.json()` でパースすると署名検証が失敗する（改行コードやエスケープが変わるため）。  
**対処**: 必ず `const rawBody = await c.req.text()` で取得する。

---

## 本番動作確認ログ（2026-05-16）

```
booking ID: 6
name: AKIHISA TEST
email: saniman32@gmail.com
status: confirmed
payment_status: paid
paid_at: 2026-05-16 02:03:46
amount: (決済金額)
LINE 通知: 「お申込みが確定しました」受信確認
```

Stripe イベント ID: `evt_1TXXMHEFYi65EDjnMy8w7iCU`

フロー全体（LIFF → Stripe Checkout → Webhook → DB確定 → LINE通知）の完全動作を確認。
