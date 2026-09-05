/**
 * 領収書の宛名を保存できる形に正規化する。
 *
 * ⚠️ 宛名は**参加者が自由に決められる文字列**で、領収書に印字され、
 *    管理画面の参加者一覧にも表示される。放置すると細工できる:
 *
 *      - 改行を大量に入れて一覧のレイアウトを崩す
 *      - RLO（U+202E）で後続の描画順を反転させ、別の名前に見せかける
 *      - 「見た目は空なのに非 null」な文字列を送り、氏名へのフォールバックを殺す
 *        （宛名が空欄の領収書が発行される）
 *
 * ⚠️ **クライアント側の検証だけに頼らない。** LIFF を経由せず API を直接叩けるため、
 *    サーバー側でこの関数を必ず通すこと。
 *
 * ## 方針: 不可視なものを弾くのではなく、可視なものを要求する
 *
 * 「不可視文字を列挙して弾く」は 2 回失敗した。
 *
 *   1回目  4文字を列挙 → 隣の U+2061 INVISIBLE TIMES が漏れた
 *   2回目  Unicode カテゴリ（Cc/Cf/Zl/Zp）→ U+2800 点字空白（So）と
 *          U+034F 結合書記素接合子（Mn）が漏れた
 *
 * 不可視の表現はカテゴリを跨いで無限にあるので、ブロックリストでは終わらない。
 * **「文字・数字・記号が1つも無ければ受け付けない」**に反転させる。
 * こうすると、未知の不可視文字が増えても素通りしない。
 */

/** 保存する宛名の最大長（コードポイント単位） */
export const RECEIPT_NAME_MAX_LENGTH = 60;

/**
 * 走査に入る前に切り落とす上限（UTF-16 コードユニット）。
 *
 * `bodyLimit` ミドルウェアが無いため receiptName はメガバイト級を投げられる。
 * 1文字ずつ走査すると Workers の CPU 時間を食い潰すので、先に切る。
 * サロゲートペアを考慮して最大長の 4 倍を確保しておく。
 */
const SCAN_LIMIT = RECEIPT_NAME_MAX_LENGTH * 4;

/**
 * 空白に畳む文字。
 *
 * \p{Cc} 制御文字（C0 / C1。改行・タブを含む）
 * \p{Cf} 書式文字（ゼロ幅・BIDI 制御・BOM・TAG 文字・不可視演算子）
 * \p{Zl} 行区切り（U+2028） / \p{Zp} 段落区切り（U+2029）
 *
 * これで漏れても、下の「可視文字が必要」判定が最後に受け止める。
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * 見た目が空白なのに「文字」（Lo）に分類される字。
 *
 * カテゴリ判定では拾えず、かつ \p{L} に該当するため下の可視文字判定も通ってしまう。
 * つまり両方の網をすり抜けるので、ここで明示的に畳む。
 */
const BLANK_LETTERS = new Set([0x3164, 0x115f, 0x1160, 0xffa0]);

/** 空白に畳むべき文字か */
function isBlankLike(ch: string): boolean {
  return INVISIBLE.test(ch) || BLANK_LETTERS.has(ch.codePointAt(0) ?? 0);
}

/**
 * 宛名として意味のある文字。これが 1 つも無ければ受け付けない。
 *
 * \p{L} 文字 / \p{N} 数字 / \p{P} 約物（（株）や - など）
 *
 * 絵文字（\p{So}）はあえて含めない。含めると同じ So カテゴリの
 * U+2800 BRAILLE PATTERN BLANK（見た目が空白）も通ってしまう。
 * 領収書の宛名が絵文字だけ、というケースは実用上想定しなくてよい。
 */
const MEANINGFUL = /[\p{L}\p{N}\p{P}]/u;

/**
 * @returns 正規化した宛名。未入力・空白のみ・可視文字を含まない場合は null
 *          （空文字で保存すると「指定あり」と区別できず、氏名へのフォールバックが効かなくなる）
 */
export function sanitizeReceiptName(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;

  // 走査前に切る（CPU 時間の保護）
  const bounded = input.length > SCAN_LIMIT ? input.slice(0, SCAN_LIMIT) : input;

  let flattened = '';
  for (const ch of bounded) flattened += isBlankLike(ch) ? ' ' : ch;

  const collapsed = flattened.replace(/\s+/g, ' ').trim();

  // ⚠️ 最後の砦。ここまでで畳めなかった不可視文字（点字空白・結合文字など）は、
  //    可視文字が1つも無いという形で弾かれる。
  if (!MEANINGFUL.test(collapsed)) return null;

  // slice は UTF-16 コードユニット単位なので、絵文字や補助漢字の途中で切ると
  // サロゲートが片割れだけ残って壊れ字（U+FFFD）になる。コードポイントで切る。
  const chars = Array.from(collapsed);
  if (chars.length <= RECEIPT_NAME_MAX_LENGTH) return collapsed;

  // 切った位置が単語の途中だと末尾に空白が残る
  return chars.slice(0, RECEIPT_NAME_MAX_LENGTH).join('').trimEnd();
}
