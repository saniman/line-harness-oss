/**
 * freee の領収書「共有リンク」を扱うための純粋関数。
 *
 * ## なぜ検証が要るか
 *
 * 共有リンクは運営者が freee の画面で作り、管理画面に**手で貼り付ける**（Issue #47）。
 * 貼られた文字列をそのまま参加者へ送ると、次の事故が起きる。
 *
 *   - `report_url`（運営者用・ログイン必須）を間違えて貼る
 *     → 参加者に freee のログイン画面が出る。**管理画面に両方並ぶので実際に混同しやすい**
 *   - まったく別の URL を貼る／貼らされる
 *     → 管理画面が乗っ取られたとき、フィッシングの配信基盤になる
 *
 * ⚠️ 検証は**必ずサーバー側**で行う。画面だけの検証は API を直接叩けば迂回できる。
 */

/** freee の共有リンクのホスト。**完全一致**で見る（後方一致だと `...freee.co.jp.evil.com` が通る） */
const SHARE_HOST = 'invoice.secure.freee.co.jp';

/** 共有リンクのパス。`/reports/receipts/...`（report_url）と区別するためここも固定する */
const SHARE_PATH_PREFIX = '/ivex/dl/';

/**
 * 入力の上限。`bodyLimit` ミドルウェアが無いためメガバイト級を投げられる。
 * URL としてありえない長さで打ち切る（CPU 時間の保護）。
 */
const MAX_INPUT_LENGTH = 2048;

/** UUID v4。freee が使う形式。バージョン桁（3ブロック目の先頭）が 4 であることまで見る */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type ParseShareUrlResult =
  | { ok: true; uuid: string; url: string }
  | { ok: false };

/**
 * 貼り付けられた共有リンクを検証し、UUID と**正規化した URL** を返す。
 *
 * 正規化するのは一意制約（取り違え対策の第1層）のため。クエリや大文字小文字が違うだけの
 * 同じリンクを別物として登録できてしまうと、「同じリンクを2人に登録できない」が破れる。
 */
export function parseShareUrl(input: string): ParseShareUrlResult {
  if (typeof input !== 'string') return { ok: false };
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > MAX_INPUT_LENGTH) return { ok: false };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false };
  }

  // https 固定。http だと途中で URL を差し替えられる
  if (parsed.protocol !== 'https:') return { ok: false };
  // ⚠️ endsWith や includes で見ない（`invoice.secure.freee.co.jp.evil.com` が通る）
  if (parsed.hostname !== SHARE_HOST) return { ok: false };
  if (!parsed.pathname.startsWith(SHARE_PATH_PREFIX)) return { ok: false };

  // 末尾スラッシュは許容する（コピー元によって付くため）
  const rest = parsed.pathname.slice(SHARE_PATH_PREFIX.length).replace(/\/$/, '');
  const uuid = rest.toLowerCase();
  if (!UUID_V4.test(uuid)) return { ok: false };

  // クエリ・ハッシュは落とす（同じリンクを別物として登録させない）
  return { ok: true, uuid, url: `https://${SHARE_HOST}${SHARE_PATH_PREFIX}${uuid}` };
}

/** 領収書番号。freee が自動採番する（例: REC-0000000008） */
const RECEIPT_NUMBER = /REC-\d+/;

/**
 * `Content-Disposition` から領収書番号を取り出す。
 *
 * freee の PDF エンドポイントは、ファイル名に**宛名と領収書番号**を入れて返す。
 *
 *   filename*=UTF-8''テスト株式会社御中_テスト_領収書_REC-0000000008.pdf
 *
 * これを使えば PDF を解析せずに「誰の領収書か」を照合できる（#47 第4層）。
 *
 * @returns 領収書番号。取り出せなければ null（**例外は投げない**。
 *          呼び出し側は「検証できなかった」として人の確認に委ねる）
 */
export function extractReceiptNumber(header: string | null | undefined): string | null {
  if (!header) return null;

  // RFC 5987 の filename*（UTF-8 パーセントエンコード）を優先する。
  // ⚠️ decodeURIComponent は不正な並びで URIError を投げるので必ず囲う。
  //    復号に失敗しても、生の文字列に REC-… が残っていることがあるので諦めない。
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1];
  if (encoded) {
    try {
      const decoded = decodeURIComponent(encoded);
      const hit = RECEIPT_NUMBER.exec(decoded);
      if (hit) return hit[0];
    } catch {
      // 復号できなくても下の生文字列走査に進む
    }
  }

  return RECEIPT_NUMBER.exec(header)?.[0] ?? null;
}

/**
 * 参加者に送る URL を組み立てる。
 *
 * freee の URL を直接送らないのは、**誤配に気づいたときに止められるようにする**ため
 * （#47 第2層）。freee の URL を送ってしまうと、こちらから無効化する手段が無い。
 */
export function buildShareUrl(workerBaseUrl: string, token: string): string {
  return `${workerBaseUrl.replace(/\/$/, '')}/receipt/${token}`;
}
