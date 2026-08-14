/**
 * 友だち追加を促す画面の HTML 生成。
 *
 * main.ts は LIFF SDK のグローバルに依存し末尾で main() を実行するためテストから import できない。
 * 分岐のあるビュー生成だけを純関数として切り出してテスト対象にする。
 */

function escapeHtml(str: string): string {
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
}

/**
 * @param botBasicId LINE 公式アカウントのベーシックID（例: `@173djjvp`）。
 *   取得に失敗して空文字の場合は、**リンクを出さずに理由を表示する**。
 *   従来は `href="#"` のボタンを出していたため「タップしても何も起きない」状態になり、
 *   ユーザーも運営も原因に気付けなかった（#25）。
 */
export function buildFriendAddHtml(
  profile: { displayName: string; pictureUrl?: string },
  botBasicId: string,
): string {
  const action = botBasicId
    ? `<a href="https://line.me/R/ti/p/${botBasicId}" class="add-friend-btn" id="addFriendBtn">
        友だち追加して始める
      </a>
      <p class="sub-message">追加後、この画面に戻ってきてください</p>`
    : `<p class="error">友だち追加リンクを取得できませんでした。<br>通信環境を確認して、画面を開き直してください。</p>`

  return `
    <div class="card">
      <div class="profile">
        ${profile.pictureUrl ? `<img src="${profile.pictureUrl}" alt="" />` : ''}
        <p class="name">${escapeHtml(profile.displayName)} さん</p>
      </div>
      <p class="message">まずは友だち追加をお願いします</p>
      ${action}
    </div>
  `
}
