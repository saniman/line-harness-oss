/**
 * 領収書の宛名を保存できる形に正規化する。
 *
 * ⚠️ 宛名は**参加者が自由に決められる文字列**で、領収書に印字され、
 *    管理画面の参加者一覧にも表示される。放置すると細工できる:
 *
 *      - 改行を大量に入れて一覧のレイアウトを崩す
 *      - RLO（U+202E）で後続の描画順を反転させ、別の名前に見せかける
 *      - ゼロ幅文字で「見た目が同じ別の文字列」を作る
 *      - WORD JOINER や INVISIBLE TIMES のような「\s にも該当しない不可視文字」だけを送り、
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
 * 不可視・制御文字にあたるコードポイント。
 *
 * ⚠️ **1文字ずつ列挙しない。** 実際に U+2060 WORD JOINER を足したとき、
 *    隣の U+2061 INVISIBLE TIMES が素通りしていた。この手の文字は
 *    Unicode に散在しており、追いかけると必ずどこかが漏れる。
 *
 *   \\p{Cc} 制御文字（C0 / C1。改行・タブを含む）
 *   \\p{Cf} 書式文字（ゼロ幅・BIDI 制御・BOM・TAG 文字・不可視演算子など）
 *   \\p{Zl} 行区切り（U+2028）  \\p{Zp} 段落区切り（U+2029）
 *
 * ハングルフィラーだけは Lo（文字）カテゴリなので上に含まれない。
 * 見た目が空白なのでここで併せて弾く。
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** 見た目が空白だが Lo カテゴリのため上の判定から漏れる文字 */
const BLANK_LETTERS = new Set([0x3164, 0x115f, 0x1160, 0xffa0]);

function isControlChar(ch: string): boolean {
  return INVISIBLE.test(ch) || BLANK_LETTERS.has(ch.codePointAt(0) ?? 0);
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
