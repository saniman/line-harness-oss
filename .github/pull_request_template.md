<!-- 関連 Issue を必ずリンク（main へ merge で自動クローズ）。例: Closes #12 -->
Closes #

## 変更概要
<!-- 何を・なぜ -->

## テスト結果
<!-- 該当するものにチェック。共有型/LIFF/DB を触った場合は追加分も -->

- [ ] `npx vitest run`
- [ ] `npx tsc --noEmit`
- [ ] （共有型変更時）`packages/shared` rebuild → `apps/web` tsc
- [ ] （LIFF client 変更時）`apps/worker/src/client` の手動 tsc
- [ ] （DB変更時）`schema.sql` 同期・マイグレーション適用方針を明記

## レビュー観点
<!-- 特に見てほしい点・トレードオフ・スコープ外 -->

---
<!-- マージ規約: CI green ＋ 人間の approve を確認してから、人間が gh pr merge する（= 本番デプロイ）。エージェントはマージしない。 -->
