# イベント申込の運営者通知セットアップ

イベント申込（無料 / 当日現金 / Stripe決済）が確定したときに、運営者へ **LINE で通知**するための設定手順。

> 未設定でも申込フロー自体は動く（通知だけが no-op になる）。
> `LINE_CHANNEL_ACCESS_TOKEN` と `ADMIN_LINE_USER_ID` のどちらかが欠けていれば通知をスキップする設計。

## なぜメールではなく LINE なのか（#49・2026-09-02）

当初は Cloudflare Email Sending（`send_email` バインディング）で運営者にメール通知していたが、
**Email Sending は Workers Paid プラン限定（Beta）** で、無料プランのアカウントでは
ドメインを登録できず、**一度も送信できていなかった**。

さらに送信処理はベストエフォート（失敗しても申込は成功させる）で `console.error` に出すだけ、
かつ Workers のログ保持も無効だったため、**申込は成功・通知だけ無音で失敗・痕跡なし**という状態が
発覚まで放置された（`event_bookings.id = 34` の申込で発覚）。

そこで通知経路を、運営者が毎日見ていて追加コストもかからない **LINE に一本化**した。
メール通知のコードは削除済み。将来 Workers Paid にするなら PR #21 / #27 を git から復元できる。

同時に `wrangler.toml` に `[observability]` を追加し、
今後は「無音の失敗」を Workers Logs から追えるようにした。

## 1. 通知先の LINE ユーザーIDを secret に設定する

通知を受け取る運営者（自分）の LINE ユーザーID。

```bash
npx wrangler secret put ADMIN_LINE_USER_ID
# プロンプトに Uxxxxxxxxxxxxxxxx 形式の ID を入力
```

> `.env` には書かない（`AGENTS.md` の必須ルール）。必ず `wrangler secret put` を使う。
> `--env production` は付けない（このリポジトリの deploy はデフォルト環境を使う）。

自分の LINE ユーザーIDが分からない場合は、公式アカウントに何かメッセージを送って
`friends` テーブルの `line_user_id` を見るのが早い。

```bash
npx wrangler d1 execute line-harness --remote \
  --command="SELECT line_user_id, display_name FROM friends ORDER BY created_at DESC LIMIT 5"
```

## 2. 通知が届く条件を確認する

- `LINE_CHANNEL_ACCESS_TOKEN`（既存の secret）が設定されていること
- 運営者自身が**その公式アカウントの友だちであること**
  → 友だちでないと LINE の push API がエラーになる（通知は届かないが申込は成功する）

## 3. デプロイ

```bash
git push origin main   # CI が自動デプロイ（手動 wrangler deploy は禁止）
```

## 4. 動作確認

1. 管理画面でテスト用イベント（無料・定員1名など）を作成して公開する
2. LIFF から自分で申し込む
3. 運営者の LINE に「🎫 イベント申込がありました」が届くことを確認する
4. 開催日時が JST（例 `09/13(日) 14:00`）で表示されていることを確認する
5. フッターのボタンから管理画面の参加者一覧に飛べることを確認する

## 通知の中身

```
🎫 イベント申込がありました        ← ヘッダー（LINE グリーン）

沖縄AI活用セミナー                 ← イベント名
09/13(日) 14:00                    ← 開催日時（JST）
─────────────────
申込者    山田太郎
支払い    Stripe決済 ¥2,000        ← 当日現金 / 無料 / 未払い（要確認）も同じ行
申込状況  3 / 20 名
予約ID    34

[ 管理画面で参加者を確認 ]          ← フッターのボタン
```

支払いの区分は**クライアント申告ではなく DB の事実**から導出する。
有料イベントなのに入金が確認できていない申込は `未払い（要確認）` と出るので、取りっぱぐれに気づける。

## トラブルシュート

| 症状 | 原因 | 対処 |
|------|------|------|
| 通知が来ない | `ADMIN_LINE_USER_ID` 未設定 | `npx wrangler secret list` で確認し、手順1を実行 |
| 通知が来ない | 運営者が公式アカウントの友だちでない | 友だち追加する |
| 通知が来ない | LINE API エラー | Cloudflare ダッシュボード → Workers → line-harness → Logs で `[admin-notifier]` を探す |
| Stripe決済で2通届く | webhook のリトライ | 通常は `status = 'confirmed'` のガードで抑止される。Logs を確認 |

## 実装の場所

- 通知ロジック: `apps/worker/src/services/admin-notifier.ts`
- 呼び出し元: `apps/worker/src/routes/events.ts`（無料 / 当日現金）・`apps/worker/src/routes/stripe.ts`（Stripe決済）
- Flex の作法: `.claude/rules/line-messaging.md`（重要情報を先頭・CTA は footer・色は6桁HEX）
