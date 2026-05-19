# Stripe決済統合 セットアップ・運用手順書

## 実装概要

LIFFイベント参加画面からStripe Checkoutへ遷移し、決済完了後にWebhookでDBを確定する仕組み。
有料・無料の両フローをサポートし、テスト環境での動作確認は完了済み（2026-05-16）。

### 決済フロー全体図

```
[LIFF ユーザー]
    │
    ├─ price が null or 0（無料イベント）
    │       → POST /api/events/:id/join
    │         name / email で即 confirmed に保存
    │         LINE Flex Message 送信
    │
    └─ price が 1 以上（有料イベント）
            → POST /api/events/:id/checkout-session
              ├─ 定員チェック（confirmed のみカウント）
              ├─ event_bookings に仮登録（status=pending, payment_status=unpaid）
              ├─ Stripe Checkout Session 作成（有効期限 30分）
              │   metadata: { bookingId, lineUserId, eventId }
              └─ session.url を返す → LIFF が liff.openWindow で遷移
                      │
                      ↓
              [Stripe 決済ページ（外部）]
                      │
                      ↓
              POST /api/stripe/webhook（Stripe → Worker）
                ├─ constructEventAsync で署名検証
                ├─ checkout.session.completed のみ処理
                ├─ confirmEventBooking で DB 更新
                │   status=confirmed / payment_status=paid / name・email 保存
                └─ LINE Flex Message でお申込み確定通知
                        │
                        ↓
              [LIFF: ?payment=success 画面] ← ユーザーが戻る
```

### 実装ファイル一覧

| ファイル | 役割 |
|---------|------|
| `apps/worker/src/routes/events.ts` | `checkout-session` / `join` エンドポイント |
| `apps/worker/src/routes/stripe.ts` | Webhook 受信・booking 確定・LINE通知 |
| `apps/worker/src/services/events.ts` | `confirmEventBooking` / `createPendingBooking` |
| `apps/worker/src/client/event-booking.ts` | LIFF: イベント詳細・申込UI・決済分岐 |
| `packages/db/migrations/030_stripe.sql` | event_bookings に Stripe カラム追加 |
| `packages/db/migrations/031_events_price.sql` | events に price カラム追加 |
| `packages/db/migrations/032_event_bookings_pending.sql` | status CHECK 制約に pending 追加 |

### DBスキーマ（Stripe関連カラム）

```sql
-- events テーブル
price INTEGER  -- NULL or 0 = 無料、1以上 = 有料（円）

-- event_bookings テーブル
status            TEXT CHECK(status IN ('pending','confirmed','cancelled'))
stripe_session_id TEXT        -- Stripe Checkout Session ID
payment_status    TEXT CHECK(payment_status IN ('unpaid','paid','refunded'))
paid_at           DATETIME    -- 決済完了時刻
amount            INTEGER     -- 実際に決済された金額（円）
```

| status | payment_status | 意味 |
|--------|----------------|------|
| pending | unpaid | Stripe Session 作成済み・未決済（30分で失効） |
| confirmed | paid | 決済完了・参加確定 |
| confirmed | unpaid | 無料イベント・直接申込で確定 |
| cancelled | unpaid | キャンセル済み |

---

## テスト環境での確認手順（Stripe テストモード）

### 1. テスト用シークレットキーの設定

Stripeダッシュボード右上の「テストモード」トグルをONにし、
**Developers → API keys → Secret key（sk_test_...）** をコピー。

```bash
npx wrangler secret put STRIPE_SECRET_KEY
# → sk_test_... を入力
```

### 2. Stripe CLI でローカルWebhookテスト

```bash
# Stripe CLI インストール（未インストールの場合）
brew install stripe/stripe-cli/stripe

# Stripe アカウントにログイン
stripe login

# ローカル Worker へ Webhook を転送（別ターミナルで起動しておく）
stripe listen --forward-to localhost:8787/api/stripe/webhook

# 出力される whsec_... をコピーして登録
npx wrangler secret put STRIPE_WEBHOOK_SECRET
# → stripe listen で表示された whsec_... を入力

# 別ターミナルでテストイベントを送信
stripe trigger checkout.session.completed
```

### 3. テスト用カード番号

Stripe テストモードで使える代表的なカード番号：

| カード番号 | 結果 |
|-----------|------|
| `4242 4242 4242 4242` | 決済成功 |
| `4000 0025 0000 3155` | 3Dセキュア認証が必要 |
| `4000 0000 0000 9995` | 残高不足で決済失敗 |
| `4000 0000 0000 0002` | カード拒否 |

- 有効期限: 未来の任意の日付（例: 12/34）
- CVC: 任意の3桁
- 郵便番号: 任意の5桁

### 4. テストの流れ

1. 管理画面でイベントに `price` を設定（例: 3000）
   ```bash
   npx wrangler@latest d1 execute line-harness \
     --command="UPDATE events SET price = 3000 WHERE id = <イベントID>"
   ```
2. LIFF（`https://liff.line.me/1661159603-5qlDj5wV?page=event`）でイベントを開く
3. 「申し込む」ボタン → Stripe Checkout ページへ遷移
4. テストカード番号で決済
5. LIFF に戻り `?payment=success` 画面が表示されることを確認
6. D1 で booking が `confirmed / paid` になっていることを確認
   ```bash
   npx wrangler@latest d1 execute line-harness \
     --command="SELECT id, status, payment_status, paid_at, name, email FROM event_bookings ORDER BY id DESC LIMIT 5"
   ```
7. LINE に「お申込みが確定しました」通知が届くことを確認

---

## 本番切り替え手順（Stripe ライブモード）

### 前提条件チェックリスト

- [ ] Stripe アカウントの本人確認が完了している（ライブモードの有効化）
- [ ] 銀行口座の登録が完了している（売上の受け取り先）
- [ ] テストモードでの全フロー動作確認が完了している

### Step 1. ライブキーへの切り替え

Stripeダッシュボードの「テストモード」トグルを **OFF** にしてライブモードへ。
**Developers → API keys → Secret key（sk_live_...）** をコピー。

```bash
npx wrangler secret put STRIPE_SECRET_KEY
# → sk_live_... を入力（上書き）
```

### Step 2. ライブ用 Webhook エンドポイントの登録

**Stripe ダッシュボード → Developers → Webhooks → Add endpoint**

- エンドポイント URL: `https://api.walover-co.work/api/stripe/webhook`
- 監視するイベント: `checkout.session.completed`
- 作成後に表示される「署名シークレット（whsec_...）」をコピー

```bash
npx wrangler secret put STRIPE_WEBHOOK_SECRET
# → whsec_... を入力（上書き）
```

### Step 3. Worker の再デプロイ

シークレットを更新しただけでは Worker には反映されないため、再デプロイが必要。

```bash
# テスト確認
npx vitest run

# デプロイ（CI/CDが実行される）
git push origin main
```

### Step 4. 本番動作確認

1. 実際のカードで少額テスト決済を実施（後でStripeから返金可能）
2. Stripe ダッシュボードのライブモードで `checkout.session.completed` イベントが記録されることを確認
3. D1 で booking が `confirmed / paid` になっていることを確認
4. LINE 通知が届くことを確認
5. テスト決済を Stripe ダッシュボードから返金

---

## Stripe ダッシュボードでの日常運用

### 決済履歴の確認

- ライブモード → **Payments** → 決済一覧
- 各決済の `Metadata` に `bookingId / lineUserId / eventId` が記録されている

### Webhook の死活監視

- **Developers → Webhooks → エンドポイントを選択**
- 「Recent deliveries」でWebhookの成功/失敗を確認
- 失敗した場合は「Send」ボタンで再送できる

### 返金処理

- **Payments → 対象の決済を選択 → Refund**
- D1 の `payment_status` は自動更新されない → 手動で更新が必要
  ```bash
  npx wrangler@latest d1 execute line-harness --remote \
    --command="UPDATE event_bookings SET payment_status = 'refunded', status = 'cancelled' WHERE stripe_session_id = '<session_id>'"
  ```

---

## イベント価格の設定

現状は管理画面UIに価格入力フォームがないため、D1で直接設定：

```bash
npx wrangler@latest d1 execute line-harness --remote \
  --command="UPDATE events SET price = 3000 WHERE id = <イベントID>"
```

- `price = NULL` または `price = 0` → 無料フロー（`/join` エンドポイントで直接確定）
- `price >= 1` → 有料フロー（Stripe Checkout経由）

---

## Stripe インスタンスの初期化（実装メモ）

Cloudflare Workers は Node.js の `http` モジュール非対応のため、`createFetchHttpClient()` が必須：

```typescript
const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
  apiVersion: '2026-04-22.dahlia',
  httpClient: Stripe.createFetchHttpClient(),
})
```

Webhook の署名検証は **rawBody（`c.req.text()`）** で行う。
`c.req.json()` でパースした後では署名が合わなくなるため厳禁：

```typescript
const rawBody = await c.req.text()
const event = await stripe.webhooks.constructEventAsync(rawBody, sig, secret)
```

---

## 別クライアントへの展開時

- `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` を別アカウントのものに `wrangler secret put` で上書き
- Webhook エンドポイント URL をクライアントの Worker URL に変更
- `LIFF_BASE_URL` を `wrangler.toml` で変更（success_url / cancel_url に使用）
- D1 マイグレーション（030〜032）を新環境にも適用

---

## トラブルシューティング

### Webhook が届かない（400 Invalid signature）

- `STRIPE_WEBHOOK_SECRET` が正しく設定されているか確認
- ライブモードのWebhook → `sk_live_` のシークレットキーと対応する `whsec_` が必要
- テストモードのWebhook → `sk_test_` と対応する `whsec_` が必要（混在不可）

### 決済後に `payment=success` に遷移するが booking が `pending` のまま

- Stripe ダッシュボード → Developers → Webhooks → Recent deliveries を確認
- Webhook が 4xx を返している場合は `STRIPE_WEBHOOK_SECRET` の設定ミスが疑われる
- `/api/stripe/webhook` が auth skipリストに入っているか確認（`apps/worker/src/middleware/auth.ts`）

### name / email が booking に保存されない

- Stripe Checkout の「お客様情報」フォームで入力された値は `session.customer_details` に入る
- `confirmEventBooking` の第3・第4引数に渡しているか確認

### 定員オーバーが正しく判定されない

- `participant_count` は `status = 'confirmed'` のみカウントしていることを確認
- `pending`（仮登録中）を含めると「仮登録が多いと残席0になる」問題が発生する
