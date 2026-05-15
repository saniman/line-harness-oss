# Stripe決済統合 セットアップ手順書

## 概要
LIFFイベント参加画面からStripe Checkoutへ遷移し、決済完了後にWebhookでDBを確定する仕組み。

## アーキテクチャ

```
LIFF（ユーザー）
  → POST /api/events/:id/checkout-session
      └─ 仮登録（status=pending, payment_status=unpaid）
      └─ Stripe Checkout Session作成
      └─ Stripeの決済ページURLを返す
  → Stripe決済ページ（外部）
  → POST /api/stripe/webhook（Stripeから）
      └─ 署名検証
      └─ checkout.session.completed イベント処理
      └─ booking を confirmed / paid に更新
      └─ LINE Flex Messageで申込完了通知
```

## 必要なDBマイグレーション

以下の順で適用（ローカル・リモート両方）：

```bash
# 030: event_bookings に Stripe カラム追加
npx wrangler@latest d1 execute line-harness --remote \
  --command="ALTER TABLE event_bookings ADD COLUMN stripe_session_id TEXT"
npx wrangler@latest d1 execute line-harness --remote \
  --command="ALTER TABLE event_bookings ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'unpaid'"
npx wrangler@latest d1 execute line-harness --remote \
  --command="ALTER TABLE event_bookings ADD COLUMN paid_at DATETIME"
npx wrangler@latest d1 execute line-harness --remote \
  --command="ALTER TABLE event_bookings ADD COLUMN amount INTEGER"

# 031: events テーブルに price カラム追加
npx wrangler@latest d1 execute line-harness --remote \
  --command="ALTER TABLE events ADD COLUMN price INTEGER"

# 032: event_bookings の status CHECK 制約に 'pending' を追加（テーブル再作成）
# packages/db/migrations/032_event_bookings_pending.sql を実行
npx wrangler@latest d1 execute line-harness --remote \
  --file=packages/db/migrations/032_event_bookings_pending.sql
```

## Stripeシークレットの設定

### 1. STRIPE_SECRET_KEY
Stripeダッシュボード → APIキー → シークレットキー

```bash
npx wrangler secret put STRIPE_SECRET_KEY
# → sk_live_... を入力
```

### 2. STRIPE_WEBHOOK_SECRET
Stripeダッシュボード → Webhooks → エンドポイントを追加

- エンドポイントURL: `https://api.walover-co.work/api/stripe/webhook`
- 監視するイベント: `checkout.session.completed`
- 作成後、「署名シークレット」を取得

```bash
npx wrangler secret put STRIPE_WEBHOOK_SECRET
# → whsec_... を入力
```

### 3. LIFF_BASE_URL（wrangler.toml に記載済み）
```toml
[vars]
LIFF_BASE_URL = "https://liff.line.me/1661159603-5qlDj5wV"
```
これはsecretではなくplaintextなので`wrangler.toml`に直接記載してある。

## イベント価格の設定
`events`テーブルの`price`カラムに整数（円）を設定する。
現状は管理画面UIから設定できないため、D1コンソールまたはAPIで直接設定：

```bash
npx wrangler@latest d1 execute line-harness --remote \
  --command="UPDATE events SET price = 3000 WHERE id = 1"
```

## statusカラムの運用ルール

| status | payment_status | 意味 |
|--------|----------------|------|
| pending | unpaid | Stripeセッション作成済み、未決済 |
| confirmed | paid | 決済完了・参加確定 |
| cancelled | unpaid | キャンセル |

- `participant_count`（定員チェックに使う）は `status = 'confirmed'` のみカウント
- 管理画面の参加者一覧は全ステータスを表示（`getEventBookingsAdmin`使用）

## ローカルテスト

Stripe CLIを使ったWebhookテスト：

```bash
# Stripe CLIインストール後
stripe listen --forward-to localhost:8787/api/stripe/webhook

# 別ターミナルでテストイベント送信
stripe trigger checkout.session.completed
```

## 別クライアントへの展開時の変更点
- Stripeアカウントを別のものに切り替える場合は `wrangler secret put` で上書き
- Webhook URLをクライアントのWorker URLに変更
- `LIFF_BASE_URL` を `wrangler.toml` で変更
