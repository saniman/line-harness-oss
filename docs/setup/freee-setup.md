# freee 連携セットアップ

当日現金払いの参加者へ領収書を自動発行・送信するために、freee と OAuth2 で連携する。
実装は `apps/worker/src/services/freee-oauth.ts` / `apps/worker/src/routes/freee.ts`。

> 未設定でもイベント申込フロー自体は動く（領収書の自動化だけが使えない）。

## 前提：freee には「receipts」が2つある（取り違え注意）

| | パス | 何をするか |
|---|---|---|
| ❌ 使わない | freee**会計** `POST /api/1/receipts` | **受け取った**証憑をファイルボックスに**アップロード**する |
| ✅ 使う | freee**請求書** `POST /receipts` | 領収書を**発行**する |

Web 検索や `freee-accounting-sdk-*` の `ReceiptsApi` は前者を指す。参考にしないこと。

## 1. freee でアプリを登録する

1. [freee アプリストア 開発者ページ](https://app.secure.freee.co.jp/developers/applications) を開く
2. 「新規アプリ作成」→ アプリ名を入力
3. **コールバックURL** に本番のコールバックを登録する

```
https://api.walover-co.work/api/integrations/freee/callback
```

4. **利用可能なスコープ**で、freee請求書の読み取り／書き込みを有効にする

> ⚠️ **スコープはアプリ登録画面で設定する。** freee の認可URLには `scope` パラメータを
> 渡さない仕様のため、コード側でスコープを変えることはできない。
> 領収書を発行できない場合は、まずここの設定を疑う。

5. 発行された **Client ID** と **Client Secret** を控える

## 2. Worker にシークレットを設定する

`.env` には書かない（`wrangler secret put` を使う）。

```bash
cd apps/worker
npx wrangler secret put FREEE_CLIENT_ID
npx wrangler secret put FREEE_CLIENT_SECRET
```

コールバックURLを既定値から変える場合のみ:

```bash
npx wrangler secret put FREEE_REDIRECT_URI
```

## 3. 認可する

ブラウザで次を開く（`redirect=1` を付けると freee の認可画面へ直接飛ぶ）。

```
https://api.walover-co.work/api/integrations/freee/auth?redirect=1
```

1. freee にログイン
2. **事業所を選ぶ**（`prompt=select_company` を付けているため選択画面が出る）
3. 「許可する」
4. 完了画面に **接続ID** が表示される

トークンは `freee_accounts` テーブルに保存される。

## 4. 接続を有効化する（新規接続のみ）

> ⚠️ **新規の接続は「保留」（`is_active = 0`）で保存され、そのままでは使われない。**

`/callback` は freee からのブラウザリダイレクトを受けるため、**認証をかけられない公開
エンドポイント**になっている。つまり第三者が公開の認可URLを自分で踏み、**自分の freee
事業所**で認可を完走すると、その人のトークンがこの DB に入りうる。
自動で有効化してしまうと、領収書がその人の事業所に発行されてしまう。

そこで **新規接続は必ず保留で保存し、有効化は認証済みの管理画面から行う**。

- 管理画面の接続UI（#44）で、**`company_id`（freee の事業所ID）を確認してから**有効化する
- 身に覚えのない接続が並んでいたら有効化しない（消してよい）

> ℹ️ **今は事業所「名」が出ない。** `freee_accounts.company_name` は用意してあるが、
> 取得処理が未実装のため常に空。当面は **`company_id` の数字で見分ける**。
> 自分の事業所IDは freee の管理画面URL等で確認できる。名前の自動取得は #44 で対応する。

**再認可（90日ごと）の場合は保留にならない。** 同じ `company_id` の接続が既にあれば
トークンを上書き更新するだけで、`is_active` は触らないため、稼働中の連携は止まらない。

### state 署名で防げること・防げないこと

認可URLに載せる `state` は `FREEE_CLIENT_SECRET` を鍵にした署名付きで、コールバック時に
署名と有効期間（10分）を検証している。

| | |
|---|---|
| ✅ 防げる | 当サービスの認可導線を経ていない、偽造・改ざん・期限切れのコールバック |
| ❌ **防げない** | 第三者が**自分でこの公開の認可URLを踏んで**正規の `state` を取得し、自分の freee 事業所で認可を完走すること |

つまり **state だけでは第三者の登録を止められない**。実際に守っているのは
上記の「**保留にして、有効化を管理画面に限定する**」ほうである。
有効化するときに `company_id` を必ず確認すること。

## ⚠️ 最重要：リフレッシュトークンは「1回限り・90日」

Google Calendar 連携と**ここが決定的に違う**。

| | Google | freee |
|---|---|---|
| refresh_token の再利用 | 何度でも可 | **1回限り**（使うと新しい値が発行され、古い値は無効） |
| 有効期限 | 実質無期限 | **90日** |

つまり:

- **リフレッシュのたびに新しい `refresh_token` を保存し直す必要がある。**
  保存し忘れると次回のリフレッシュが失敗し、連携が死ぬ
- **90日間まったくリフレッシュしないと失効する。** 現金受領が3か月発生しないと切れる
- 同時に2回リフレッシュすると片方が無効化される

→ 再認証は手順3をもう一度実行するだけでよい。

出典: [freee 認可コードフロー](https://developer.freee.co.jp/reference/認可コード)

## トラブルシューティング

| 症状 | 原因 |
|---|---|
| 認可画面で「リダイレクトURIが一致しません」 | 手順1で登録したコールバックURLと `FREEE_REDIRECT_URI` の不一致 |
| 「リンクが無効か、時間切れです」 | `state` の期限切れ（10分）。手順3からやり直す |
| コールバックで「エラー」画面 | トークン交換の失敗。詳細は Workers Logs の `[freee callback]` を見る。**同じリンクを開き直しても直らない**（認可コードは消費済み）ので手順3からやり直す |
| 連携したのに領収書が発行されない | 接続が**保留のまま**の可能性。手順4で有効化する |
| 領収書の発行だけ失敗する | アプリ登録のスコープ不足（手順1の4）。認可をやり直す |

> トークンと領収書URLは**ログに出していない**（`console.log` に出すと、
> ログ閲覧権限だけで領収書が開けてしまうため）。追跡は接続IDと booking_id で行う。

## 関連

- 実装: `apps/worker/src/services/freee-oauth.ts` / `apps/worker/src/routes/freee.ts`
- テーブル: `packages/db/migrations/822_freee_accounts.sql`
- Epic: [#41 現金決済領収書自動化](https://github.com/saniman/line-harness-oss/issues/41)
