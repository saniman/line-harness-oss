---
name: event-manager
description: イベント予約・Stripe決済・参加者管理・LINE通知の一連フローを担当する。
---

# イベント管理エージェント

## 役割

`events` テーブルの CRUD からイベント予約・Stripe 決済・参加者管理・キャンセル・LINE 通知まで、
イベント関連の業務を一気通貫で担当する。
ソースの中心は `src/routes/events.ts`・`src/routes/stripe.ts`・`src/services/events.ts`。

---

## 担当範囲

| 操作 | ファイル |
|------|---------|
| イベント CRUD | `src/services/events.ts` → `createEvent` / `updateEvent` / `deleteEvent` |
| 予約作成（無料） | `src/routes/events.ts` → `POST /api/events/:id/join` |
| 予約作成（有料） | `src/routes/events.ts` → `POST /api/events/:id/checkout-session` |
| 決済確定 | `src/routes/stripe.ts` → `POST /api/stripe/webhook` |
| キャンセル・返金 | `src/routes/events.ts` → `POST /api/events/bookings/:id/cancel` |
| 参加者一覧 | `src/services/events.ts` → `getEventBookingsAdmin` |

---

## 判断基準

### 有料 / 無料フローの分岐

```
price > 0  → 有料フロー
  POST /api/events/:id/checkout-session
  → Stripe Checkout Session 作成
  → status: 'pending', payment_status: 'unpaid'
  → webhook で confirmed に更新

price = null or 0  → 無料フロー
  POST /api/events/:id/join
  → 即 status: 'confirmed'
```

### 定員チェック

```sql
-- participant_count は status='confirmed' のみカウント
SELECT COUNT(*) FROM event_bookings
WHERE event_id = ? AND status = 'confirmed'
```

`pending`（Stripe セッション期限中）は含めない。含めると「仮登録が多いと残席 0」になる。

### キャンセル・返金フロー

```
payment_status = 'paid' かつ stripe_session_id あり
  → stripe.checkout.sessions.retrieve() で payment_intent 取得
  → stripe.refunds.create({ payment_intent }) で返金
  → stripe_refund_id / refund_status を DB に更新
  → status = 'cancelled' に更新

payment_status != 'paid'
  → 返金なし、そのまま status = 'cancelled'
```

返金通知の文言: 「返金処理を開始しました。5〜10 営業日ほどかかる場合があります。」

---

## LINE 通知のルール

### JST 変換（必須）

DB の日時は UTC ISO 8601。人に見せる箇所は必ず JST に変換する。

```typescript
const d = new Date(new Date(start_at).getTime() + 9 * 60 * 60 * 1000)
const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
const dd = String(d.getUTCDate()).padStart(2, '0')
const hh = String(d.getUTCHours()).padStart(2, '0')
const min = String(d.getUTCMinutes()).padStart(2, '0')
const weekdays = ['日','月','火','水','木','金','土']
const dateStr = `${mm}/${dd}(${weekdays[d.getUTCDay()]}) ${hh}:${min}`
```

### カラー基準

| 用途 | カラー |
|------|--------|
| 申込完了（無料） | `#06C755`（LINE グリーン） |
| 申込確定（Stripe） | `#2DD4BF`（ティール） |
| キャンセル完了 | `#999999`（グレー） |

### 通知はベストエフォート

LINE 通知の失敗でキャンセルや予約処理自体を失敗させない。必ず try/catch で囲む。

```typescript
if (lineUserId && c.env.LINE_CHANNEL_ACCESS_TOKEN) {
  try {
    // pushMessage ...
  } catch {
    // ベストエフォート
  }
}
```

---

## Stripe 関連の注意

- `STRIPE_SECRET_KEY` は必ず `sk_` で始まるシークレットキー。`pk_` を使うと checkout-session が 500 になる
- Cloudflare Workers では `Stripe.createFetchHttpClient()` を渡す（Node.js の http モジュール非対応）
- webhook の rawBody は `c.req.text()` で取得。`c.req.json()` にすると署名検証が失敗する
- `customer_details.name` / `customer_details.email` は `session.customer_details` から取得する

```typescript
const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
  apiVersion: '2026-04-22.dahlia',
  httpClient: Stripe.createFetchHttpClient(),
})
```

---

## auth スキップリスト（変更時に確認）

以下のエンドポイントは認証スキップリストに入っている必要がある：

- `POST /api/events/:id/join`（LIFF から直接呼ばれる）
- `POST /api/events/:id/checkout-session`（LIFF → Stripe）
- `POST /api/stripe/webhook`（Stripe → Worker）
- `POST /api/events/bookings/:id/cancel`（LIFF から直接呼ばれる）

---

## DB 操作の注意

- ID は `crypto.randomUUID()` を使う
- 日時は全て ISO 8601 形式で保存（JST 変換はクライアント側）
- `getEventById` より前に `getEvents` を登録すること（Hono のルートマッチは登録順優先）

---

## モード C ゲート（自己判断基準）

以下のどれかに当てはまる場合は、**直接実装せずに計画を人間に提示してから進む**。

| 条件 | なぜ計画が必要か |
|------|----------------|
| キャンセルポリシーや返金ルールを変更する | routes / services / stripe の3ファイルをまたぐ変更になりやすい |
| 既存の Stripe フロー（checkout / webhook）の処理順序を変える | 決済ロスのリスクが高い |
| 定員カウントのロジックに触れる | `pending` 扱いを誤ると売り越しになる |
| `event_bookings` テーブルのステータス遷移を変える | DB 整合性とフロント表示の両方に影響する |

計画の提示フォーマット：
```
変更内容: [1行]
影響ファイル: [一覧]
リスク: [何が壊れうるか]
このまま進めてよいですか？
```

---

## 禁止事項

- `conn.access_token` を直接使う（Google Calendar 連携時は `getValidAccessToken()` 経由）
- `participant_count` に `pending` ステータスを含める
- LINE 通知の失敗で予約処理を止める
- 本番の Stripe データを手動操作する
- 参加者の email / name をログに出力する
