# 管理画面デプロイ手順書

## 概要
Next.js製管理画面をCloudflare Pagesにデプロイし、
カスタムドメインを設定する手順。

## 前提条件
- Cloudflareアカウントがある
- 対象ドメインがCloudflareで管理されている
- GitHub SecretsにCLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_IDが設定済み

## 手順

### 1. Cloudflare Pagesプロジェクトを作成
```bash
cd apps/web
npx wrangler pages project create line-harness-web
```

### 2. 環境変数を設定
GitHub Secrets に以下を追加：

| Secret名 | 値 |
|---|---|
| CLOUDFLARE_API_TOKEN | Cloudflare APIトークン |
| CLOUDFLARE_ACCOUNT_ID | CloudflareアカウントID |
| API_KEY | WALOVERのAPIキー |

※ Cloudflare APIトークンの作成：
https://dash.cloudflare.com/profile/api-tokens
→「Edit Cloudflare Workers」テンプレートで作成

### 3. 初回手動デプロイ
```bash
NEXT_PUBLIC_API_URL=https://api.walover-co.work \
NEXT_PUBLIC_API_KEY=（API_KEY） \
pnpm --filter web run build

npx wrangler pages deploy apps/web/out \
  --project-name=line-harness-web \
  --branch=main
```

### 4. カスタムドメインの設定

#### Cloudflare Pagesでドメインを追加
1. https://dash.cloudflare.com にアクセス
2. Workers & Pages → line-harness-web
3. カスタムドメインタブ → 「カスタムドメインを設定する」
4. admin.（ドメイン名） を入力して「続行」

#### CloudflareのDNSにCNAMEレコードを追加
1. dash.cloudflare.com → 対象ドメイン → DNS → レコード
2. 「レコードを追加」をクリック
3. 以下を入力：
   - タイプ: CNAME
   - 名前: admin
   - ターゲット: Pagesの設定画面に表示されるTarget値
   - プロキシ: オン（オレンジ雲）
4. 保存

#### DNS反映確認
- Pagesの画面に戻り「Check DNS records」をクリック
- 「Verifying」→「Active」になれば完了
- Cloudflare同士なら数分で反映

### 5. 自動デプロイの確認
`apps/web/` 配下を変更してmainにpushすると
GitHub Actions（deploy-web.yml）が自動実行される

## 別クライアントへの展開時の変更点
- `project-name` を変更（例: client-name-web）
- カスタムドメインを変更（例: admin.client-domain.com）
- GitHub SecretsのAPI_KEYを変更
- NEXT_PUBLIC_API_URLを変更（クライアントのWorker URL）

## 将来的なClaude自動化の余地
以下の手順はCloudflare API / Wrangler CLIで自動化可能：
- Pagesプロジェクト作成: `wrangler pages project create`
- デプロイ: `wrangler pages deploy`
- DNSレコード追加: Cloudflare API `POST /zones/{zone_id}/dns_records`
- カスタムドメイン設定: Cloudflare API `POST /pages/projects/{name}/domains`

Cloudflare APIのドキュメント：
https://developers.cloudflare.com/api/
