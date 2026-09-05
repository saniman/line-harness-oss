/**
 * 領収書の宛名を保存できる形に正規化する。
 *
 * ⚠️ 宛名は**参加者が自由に決められる文字列**で、領収書に印字され、
 *    管理画面の参加者一覧にも表示される。放置すると細工できる:
 *
 *      - 改行を大量に入れて一覧のレイアウトを崩す
 *      - RLO（U+202E）で後続の描画順を反転させ、別の名前に見せかける
 *      - ゼロ幅文字で「見た目が同じ別の文字列」を作る
 *      - WORD JOINER や HANGUL FILLER のような「\s にも該当しない不可視文字」だけを送り、
 *        見た目は空なのに非 null で保存させる（氏名へのフォールバックを殺す）
 *
 * ⚠️ **クライアント側の検証だけに頼らない。** LIFF を経由せず API を直接叩けるため、
 *    サーバー側でこの関数を必ず通すこと。
 *
 * 同種の対策は管理画面側にもある（apps/web/src/lib/freee-label.ts）。
 * パッケージが分かれているので実装は共有していない。
 */

/** 保存する宛名の最大長（コードポイント単位） */
export const RECEIPT_NAME_MAX_LENGTH = 60;

/**
 * 制御文字かどうか。C0（改行・タブ含む）／ DEL ／ C1 ／
 * ゼロ幅・BIDI 制御／行区切りを対象にする。
 *
 * 正規表現の文字クラスに直接書くとソースにリテラルの制御文字が入り、
 * 差分レビューで見えなくなる。コードポイントで判定する。
 */
function isControlChar(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return (
    code < 0x20 ||                       // C0（改行・タブ等）
    code === 0x7f ||                     // DEL
    (code >= 0x80 && code <= 0x9f) ||    // C1
    (code >= 0x200b && code <= 0x200f) || // ゼロ幅 / LRM / RLM
    (code >= 0x202a && code <= 0x202e) || // BIDI 埋め込み・オーバーライド（RLO 含む）
    (code >= 0x2066 && code <= 0x2069) || // BIDI アイソレート
    code === 0x061c ||                   // ARABIC LETTER MARK（BIDI 制御。上の範囲から漏れる）
    code === 0xfeff ||                   // BOM / ZWNBSP
    code === 0x2028 ||                   // LINE SEPARATOR
    code === 0x2029 ||                   // PARAGRAPH SEPARATOR
    // ここから下は「\s にも該当しない不可視文字」。畳まないと
    // 見た目が空なのに非 null で保存され、氏名へのフォールバックが効かず
    // 宛名が空欄の領収書になる。
    code === 0x2060 ||                   // WORD JOINER
    code === 0x00ad ||                   // SOFT HYPHEN
    code === 0x3164 ||                   // HANGUL FILLER
    code === 0x115f ||                   // HANGUL CHOSEONG FILLER
    code === 0x1160 ||                   // HANGUL JUNGSEONG FILLER
    code === 0xffa0                      // HALFWIDTH HANGUL FILLER
  );
}

/**
 * @returns 正規化した宛名。未入力・空白のみ・文字列でない場合は null
 *          （空文字で保存すると「指定あり」と区別できず、氏名へのフォールバックが効かなくなる）
 */
export function sanitizeReceiptName(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;

  let flattened = '';
  for (const ch of input) flattened += isControlChar(ch) ? ' ' : ch;

  const collapsed = flattened.replace(/\s+/g, ' ').trim();
  if (!collapsed) return null;

  // slice は UTF-16 コードユニット単位なので、絵文字や補助漢字の途中で切ると
  // サロゲートが片割れだけ残って壊れ字（U+FFFD）になる。コードポイントで切る。
  const chars = Array.from(collapsed);
  return chars.length > RECEIPT_NAME_MAX_LENGTH
    ? chars.slice(0, RECEIPT_NAME_MAX_LENGTH).join('')
    : collapsed;
}
