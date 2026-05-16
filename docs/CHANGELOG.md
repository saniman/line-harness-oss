# Changelog

## v0.3.0 (2026-05-16)

### SP6: Stripe決済統合 + イベント予約フルフロー

#### DBマイグレーション（030〜032）
- `event_bookings` に `stripe_session_id / payment_status / paid_at / amount` カラム追加（030）
- `events` に `price` カラム追加（031）
- `event_bookings.status` CHECK制約に `pending` を追加（テーブル再作成）（032）

#### Worker API
- `POST /api/events/:id/checkout-session` — Stripe Checkout Session作成・仮登録
- `POST /api/stripe/webhook` — 署名検証 → booking確定 → LINE通知（全TDD）
- 両エンドポイントを認証スキップリストに追加（LIFF/Stripeから直接呼ばれるため）
- `confirmEventBooking` に `name / email` 保存を追加（customer_detailsから取得・COALESCE）

#### LIFFクライアント
- 有料イベント: `/checkout-session` → Stripe Checkout → `?payment=success/cancel` 画面遷移
- 無料イベント: 名前・メール入力フォームで直接申込（`/join` エンドポイント）
- 「イベント」キーワードでイベント一覧LIFFボタンを返す自動応答を追加

#### 管理画面
- イベント参加者一覧に `payment_status / paid_at / amount` カラムを追加
- イベント詳細ページに編集モーダルを追加（全フィールドをインライン編集可能に）

#### CI/CD
- `pnpm/action-setup@v4` を `corepack enable pnpm` に置き換え（Node.js 24 移行対応）
- `cloudflare/wrangler-action@v3` を `pnpm exec wrangler` の run ステップに置き換え
- 対象ワークフロー: deploy-web.yml / deploy-worker.yml / deploy-liff.yml / test.yml

#### バグ修正
- Stripe Webhookで `customer_details` の `name/email` が booking に保存されないバグを修正
- イベント作成時に `price` が保存されないバグを修正（POST/PUT）
- `checkout-session` エンドポイントの認証スキップ漏れを修正

#### テスト
- 全テスト: 170件グリーン（stripe.test.ts 新規追加含む）

## v0.2.0 (2026-03-25)

### Breaking Changes
- **DB Schema**: `line_account_id` column added to `friends`, `scenarios`, `broadcasts`, `reminders`, `automations`, `chats`
- **DB Schema**: `login_channel_id`, `login_channel_secret`, `liff_id` columns added to `line_accounts`
- **Timestamps**: All timestamps standardized to JST (+09:00). Existing UTC data is compatible via epoch comparison.

### Upgrade
```bash
wrangler d1 execute line-crm --file=packages/db/migrations/008_multi_account.sql --remote
```

### New Features
- **Multi-account support** — Webhook routing, cron delivery, and admin UI per LINE account
- **Account switcher UI** — Global dropdown in sidebar, all pages filter by selected account
- **Cross-provider UUID linking** — `?uid=` param in `/auth/line` for automatic identity linking across providers
- **Template variable expansion** — `{{name}}`, `{{uid}}`, `{{auth_url:CHANNEL_ID}}` in scenario messages
- **Delivery window** — 9:00-23:00 JST enforcement, per-user preferred hour via "配信時間はN時"
- **replyMessage for welcome** — First step (delay=0) uses free replyMessage instead of pushMessage
- **Bot profile in admin** — Account cards show LINE profile picture, display name, basic ID
- **Account stats** — Per-account friend count, active scenarios, monthly message count
- **GitHub Actions CI/CD** — Auto-deploy Worker on push to main
- **OAuth direct redirect** — `/auth/line` redirects to LINE Login OAuth directly (no LIFF needed)
- **Friend-add redirect** — After OAuth callback, auto-redirect to `line.me/R/ti/p/{basicId}`

### Bug Fixes
- JST timestamp standardization (was UTC, causing wrong delivery times)
- Auth unification (affiliates page + login fallback URL)
- Calendar slot time calculation (was offset by 9 hours)
- ID token verification using correct login channel for multi-account

## v0.1.0 (2026-03-22)

### Initial Release
- Step delivery (scenarios with delay_minutes timing)
- Broadcasts (scheduled, segmented, batch sending)
- Tag-based segmentation
- Rich menu management
- Forms & LIFF
- Tracked links
- Reminders
- Lead scoring
- IF-THEN automation engine
- Webhooks (incoming/outgoing) + notifications
- Operator chat + auto-reply
- Conversion tracking + affiliate system
- Multi-account tables (line_accounts)
- TypeScript SDK (41 tests)
- OpenAPI/Swagger docs
- Admin panel (Next.js 15)
