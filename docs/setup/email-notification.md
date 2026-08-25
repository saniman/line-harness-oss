# イベント申込のメール通知セットアップ

イベント申込（無料 / 当日現金 / Stripe決済）が確定したときに、運営者へ通知メールを送るための設定手順。
送信基盤は **Cloudflare Email Sending**（Workers の `send_email` バインディング）。外部の API キーは不要。

> 未設定でも申込フロー自体は動く（メール送信だけが no-op になる）。
> `EMAIL` バインディング・`ADMIN_NOTIFY_EMAIL`・`MAIL_FROM_ADDRESS` の
> どれか一つでも欠けていれば送信をスキップする設計。

## 1. ドメインを Email Sending に登録する

送信元アドレスのドメインを有効化する。**これをやらないと送信は必ず失敗する。**

```bash
npx wrangler@latest email sending enable walover-co.work
```

> ⚠️ **`@latest` は必須**。このリポジトリに入っている wrangler は 4.0.0 で、`email` コマンドがまだ無い。
> `npx wrangler ...` と書くとローカルの 4.0.0 が起動し `Unknown arguments: email, sending, enable` になる
> （D1 マイグレーションで `npx wrangler@latest` を使っているのと同じ理由。`.claude/rules/deployment.md`）。
>
> ⚠️ **`--env production` は付けない**。このリポジトリの deploy はデフォルト環境を使い、
> `[env.production]` は fork 向けテンプレート。そもそも Email Sending の有効化はゾーン単位の操作で環境に紐づかない。

- 対話に従って進める。DNS レコード（SPF / DKIM）の追加を求められる場合がある。
- Cloudflare で DNS を管理していれば自動で入ることが多い。
- 登録済みドメインの確認：

```bash
npx wrangler@latest email sending list
```

CLI がうまくいかない場合は Cloudflare ダッシュボード → 対象ドメイン → **Email → Email Sending** からでも有効化できる。

## 2. 通知先アドレスを secret に設定する

通知を受け取るメールアドレス（自分の Gmail など）。

```bash
npx wrangler secret put ADMIN_NOTIFY_EMAIL
# プロンプトに admin@example.com のようなアドレスを入力
```

> `.env` には書かない（`AGENTS.md` の必須ルール）。必ず `wrangler secret put` を使う。
> `secret put` は 4.0.0 にもあるので `@latest` は不要。ここでも `--env production` は付けない。

## 3. 送信元アドレスを確認する

`apps/worker/wrangler.toml` の `[vars]` に定義済み。秘密情報ではないので secret 不要。

```toml
[vars]
MAIL_FROM_ADDRESS = "noreply@walover-co.work"
```

手順 1 で有効化したドメインのアドレスにすること。別ドメインだと送信が拒否される。

## 4. デプロイ

```bash
git push origin main   # CI が自動デプロイ（手動 wrangler deploy は禁止）
```

## 5. 動作確認

1. 管理画面でテスト用イベント（無料・定員1名など）を作成して公開する
2. LIFF から自分で申し込む
3. `ADMIN_NOTIFY_EMAIL` の受信箱に「【イベント申込】<イベント名>（<申込者名>）」が届くことを確認する
4. **迷惑メールフォルダに入っていないか**も確認する
5. 開催日時が JST（例 `06/13(土) 14:00`）で表示されていることを確認する

## メールの中身

```
件名: 【イベント申込】沖縄AI活用セミナー（山田太郎）

イベントの申込がありました。

イベント: 沖縄AI活用セミナー
開催日時: 06/13(土) 14:00
申込者: 山田太郎
支払い: Stripe決済 ¥3,000    ← 当日現金 / 無料 も同じ行に出る
予約ID: 12
申込状況: 3 / 20 名

管理画面: https://admin.walover-co.work/events
```

## トラブルシュート

| 症状 | 原因 | 対処 |
|------|------|------|
| メールが全く届かない | ドメイン未登録 | `npx wrangler email sending list` で確認し、手順 1 を実行 |
| メールが全く届かない | `ADMIN_NOTIFY_EMAIL` 未設定 | `npx wrangler secret list` で確認し、手順 2 を実行 |
| 迷惑メールに入る | SPF / DKIM 未設定 | DNS レコードが入っているか Cloudflare ダッシュボードで確認 |
| Stripe決済で2通届く | webhook のリトライ | 通常は `status = 'confirmed'` のガードで抑止される。ログ（`[email-notifier]`）を確認 |

## 実装の場所

- 送信ロジック: `apps/worker/src/services/email-notifier.ts`
- 呼び出し元: `apps/worker/src/routes/events.ts`（無料 / 当日現金）・`apps/worker/src/routes/stripe.ts`（Stripe決済）
