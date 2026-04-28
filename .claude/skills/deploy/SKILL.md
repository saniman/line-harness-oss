# デプロイスキル

## 使い方
「デプロイして」「本番に反映して」と言われたら使う

## Worker デプロイ
pnpm deploy:worker

## LIFF デプロイ（ビルド → Pages）
VITE_LIFF_ID=1661159603-5qlDj5wV \
VITE_API_BASE=https://api.walover-co.work \
VITE_CALENDAR_CONNECTION_ID=0ba404af-3184-4640-bb56-d24c37c1f230 \
pnpm --filter worker build

npx wrangler pages deploy apps/worker/dist/client \
  --project-name=line-harness-liff \
  --branch=main \
  --commit-dirty=true

## 管理画面デプロイ（Cloudflare Pages）

### ビルド
NEXT_PUBLIC_API_URL=https://api.walover-co.work \
NEXT_PUBLIC_API_KEY=（API_KEY） \
pnpm --filter web run build

### デプロイ
npx wrangler pages deploy apps/web/out \
  --project-name=line-harness-web \
  --branch=main

### 本番URL
https://admin.walover-co.work

### 新規クライアントへの展開
1. プロジェクト作成: npx wrangler pages project create {client}-web
2. ビルド（NEXT_PUBLIC_API_URLを変更）
3. デプロイ（project-nameを変更）
4. カスタムドメイン設定: docs/setup/admin-deploy.md を参照

## デプロイ後の確認
curl https://api.walover-co.work/api/health

## 注意
- apps/liff/ は存在しない。LIFFは apps/worker/src/client/ でビルドし dist/client/ を Pages にデプロイ
- GitHub Actions で自動デプロイされるが VITE_CALENDAR_CONNECTION_ID が vars 未設定だと空文字になる
  → 手動デプロイで上書きするか GitHub vars に設定する
- mainへのpushでGitHub Actionsが自動テスト→デプロイを実行する
- テストが失敗するとデプロイは実行されない
- ローカルで pnpm --filter worker test を通してからpushすること
