---
description: LIFFアプリのルール
globs: "apps/worker/src/client/**/*.ts"
---
# LIFFコーディングルール

## ソースの場所
- LIFFクライアントは apps/worker/src/client/ にある（apps/liff/ は存在しない）
- ビルド出力: apps/worker/dist/client/
- Pagesデプロイ: npx wrangler pages deploy apps/worker/dist/client --project-name=line-harness-liff

## 環境変数
- VITE_LIFF_ID: LIFFアプリID（1661159603-5qlDj5wV）
- VITE_API_BASE: Worker URL（https://api.walover-co.work）
- VITE_CALENDAR_CONNECTION_ID: Google Calendar接続ID（0ba404af-3184-4640-bb56-d24c37c1f230）
- GitHub Actions の vars に設定が必要（未設定だと空文字でビルドされる）

## liff.init() の扱い
- 必ずtry/catchで囲む
- LINE外ブラウザでもエラーにならないよう続行させる
- liff.isInClient() で分岐する

## ルーティング
- ?page=book → initBooking()
- liff.state=%3Fpage%3Dbook の形式でも届く → getPage() で liff.state を展開して取得
- レンダリング先は document.getElementById('app')（#booking-root は存在しない）

## API呼び出し
- slots と book エンドポイントは認証不要（Bearer トークン不要）
- エラー時はユーザーに分かりやすいメッセージを表示する
- booking リクエストには lineUserId（liff.getProfile().userId）を含める
