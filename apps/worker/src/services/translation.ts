// モバイルオーダーの英語対応: メニュー本体（料理名・説明・カテゴリ・オプション）の翻訳。
//
// 設計:
//  - 翻訳は (target_lang, source_text) でキャッシュ（translation_cache）。同じ原文は1回だけ翻訳。
//  - 未キャッシュ分だけ Claude(Haiku) に「まとめて1回」投げる（JSON 配列で受け取る）。
//  - 失敗・APIキー無し時は原文（日本語）にフォールバックして注文フローを止めない。
//  - 注文は menu_id ベースなので、翻訳は「表示専用」。order_items は日本語スナップショットのまま
//    → お客さんは英語表示で注文、厨房は日本語で見る（オーダーミス防止）。

import type { OrderableMenu, MenuGroup } from './orders.js'

// 既存の Claude 呼び出し（services/ai-news.ts）と同じパターン・モデルを踏襲。
const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages'
const MODEL = 'claude-haiku-4-5-20251001'

// ----------------------------------------------------------------
// 純粋関数（テスト対象）

// メニュー群から翻訳対象の文字列を重複なく集める（name / description / category_label / オプション）。
export function collectMenuStrings(menus: OrderableMenu[]): string[] {
  const set = new Set<string>()
  for (const m of menus) {
    if (m.name) set.add(m.name)
    if (m.description) set.add(m.description)
    if (m.category_label) set.add(m.category_label)
    for (const o of m.options) {
      if (o.group_label) set.add(o.group_label)
      if (o.choice_name) set.add(o.choice_name)
    }
  }
  return [...set]
}

// 訳マップ（原文→訳）でメニューの文字列を差し替える。未訳は原文のまま（id・価格・menu_group は不変）。
export function applyMenuTranslations(
  menus: OrderableMenu[],
  map: Map<string, string>,
): OrderableMenu[] {
  const tr = (s: string | null): string | null => (s == null ? s : map.get(s) ?? s)
  return menus.map((m) => ({
    ...m,
    name: tr(m.name) ?? m.name,
    description: tr(m.description),
    category_label: tr(m.category_label),
    options: m.options.map((o) => ({
      ...o,
      group_label: tr(o.group_label) ?? o.group_label,
      choice_name: tr(o.choice_name) ?? o.choice_name,
    })),
  }))
}

// Claude 応答からJSON配列を頑健に取り出す（コードフェンスや前後の文章を許容）。
export function parseTranslationArray(raw: string, expected: number): string[] | null {
  const fenced = raw.replace(/```(?:json)?/gi, '').trim()
  const start = fenced.indexOf('[')
  const end = fenced.lastIndexOf(']')
  if (start === -1 || end === -1 || end < start) return null
  try {
    const arr = JSON.parse(fenced.slice(start, end + 1))
    if (!Array.isArray(arr) || arr.length !== expected) return null
    return arr.map((x) => String(x))
  } catch {
    return null
  }
}

// ----------------------------------------------------------------
// DB + Claude

// 翻訳キャッシュから (lang, text) のヒットを引く。
async function getCached(
  db: D1Database,
  targetLang: string,
  texts: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (texts.length === 0) return map
  const placeholders = texts.map(() => '?').join(',')
  const rows = await db
    .prepare(
      `SELECT source_text, translated_text FROM translation_cache
        WHERE target_lang = ? AND source_text IN (${placeholders})`,
    )
    .bind(targetLang, ...texts)
    .all<{ source_text: string; translated_text: string }>()
  for (const r of rows.results) map.set(r.source_text, r.translated_text)
  return map
}

async function saveCached(
  db: D1Database,
  targetLang: string,
  pairs: Array<{ source: string; translated: string }>,
): Promise<void> {
  for (const p of pairs) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO translation_cache (id, target_lang, source_text, translated_text)
         VALUES (?,?,?,?)`,
      )
      .bind(crypto.randomUUID(), targetLang, p.source, p.translated)
      .run()
  }
}

const LANG_NAME: Record<string, string> = { en: 'English' }

// 未キャッシュの日本語文字列を Claude(Haiku) で一括翻訳する。JSON 配列で受け取る。
async function translateWithClaude(
  apiKey: string,
  targetLang: string,
  texts: string[],
): Promise<Map<string, string>> {
  const langName = LANG_NAME[targetLang] ?? targetLang
  const system =
    `You translate Japanese restaurant menu strings into ${langName}. ` +
    `Keep each translation short and natural for a menu (no explanations). ` +
    `Return ONLY a JSON array of strings, same length and order as the input array, no other text.`
  const res = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      system,
      messages: [{ role: 'user', content: JSON.stringify(texts) }],
    }),
  })
  if (!res.ok) throw new Error(`Anthropic API error ${res.status}`)
  const data = (await res.json()) as { content: Array<{ type: string; text: string }> }
  const raw = data.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
  const arr = parseTranslationArray(raw, texts.length)
  if (!arr) throw new Error('translation parse failed')
  const map = new Map<string, string>()
  texts.forEach((t, i) => map.set(t, arr[i]))
  return map
}

// 文字列群を翻訳して原文→訳のマップを返す。キャッシュ優先・未ヒットのみ Claude・結果を保存。
// apiKey 無し / 翻訳失敗時は、その分は原文のまま（マップに入れない＝呼び出し側で原文フォールバック）。
export async function translateBatch(
  db: D1Database,
  apiKey: string | undefined,
  targetLang: string,
  texts: string[],
): Promise<Map<string, string>> {
  const uniq = [...new Set(texts.filter((t) => t && t.trim()))]
  const cached = await getCached(db, targetLang, uniq)
  const missing = uniq.filter((t) => !cached.has(t))
  if (missing.length === 0 || !apiKey) return cached

  try {
    const fresh = await translateWithClaude(apiKey, targetLang, missing)
    await saveCached(
      db,
      targetLang,
      [...fresh.entries()].map(([source, translated]) => ({ source, translated })),
    )
    for (const [k, v] of fresh) cached.set(k, v)
  } catch (err) {
    // 翻訳失敗はベストエフォート。原文フォールバック（cached のヒット分だけ返す）。
    console.error('translateBatch error:', err)
  }
  return cached
}

// メニュー群を targetLang にローカライズして返す（en 以外/失敗時は実質そのまま）。
export async function localizeMenus(
  db: D1Database,
  apiKey: string | undefined,
  targetLang: string,
  menus: OrderableMenu[],
): Promise<OrderableMenu[]> {
  const strings = collectMenuStrings(menus)
  const map = await translateBatch(db, apiKey, targetLang, strings)
  return applyMenuTranslations(menus, map)
}

export type { MenuGroup }
