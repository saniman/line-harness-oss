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
 * 属性値用のエスケープ。
 * textContent→innerHTML の escapeHtml は `"` を変換しないため属性値には使えない。
 * botBasicId は D1 / LINE API 由来で、空白や予期しない文字が混ざると href が壊れ、
 * 「タップしても何も起きない」（#25 の症状）が再発する。
 */
function escapeAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
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
  // 前後の空白は LINE API / D1 由来で混入しうる。残すと href が壊れる。
  const basicId = botBasicId.trim()
  const action = basicId
    ? `<a href="https://line.me/R/ti/p/${escapeAttr(basicId)}" class="add-friend-btn" id="addFriendBtn">
        友だち追加して始める
      </a>
      <p class="sub-message">追加後、この画面に戻ってきてください</p>`
    : `<p class="error">友だち追加リンクを取得できませんでした。<br>通信環境を確認して、画面を開き直してください。</p>`

  return `
    <div class="card">
      <div class="profile">
        ${profile.pictureUrl ? `<img src="${escapeAttr(profile.pictureUrl)}" alt="" />` : ''}
        <p class="name">${escapeHtml(profile.displayName)} さん</p>
      </div>
      <p class="message">まずは友だち追加をお願いします</p>
      ${action}
    </div>
  `
}
