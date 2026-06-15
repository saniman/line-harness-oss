/**
 * パーソナルAIアシスタント返信（案A）
 *
 * auto_replies / 既存キーワードに当たらない自由文に対し、Claude(Haiku) が
 * 店舗情報（knowledge）＋直近の会話履歴を踏まえて 1:1 で返信する。
 * 営業時間外の一次対応・FAQ自動化が目的。
 *
 * webhook からは「未マッチ かつ replyToken 未消費」のときだけ呼ばれる（auto_replies は不変）。
 */

export interface AiAssistantConfig {
  id: string;
  enabled: number;
  model: string;
  knowledge: string;
  daily_limit: number;
  updated_at: string;
}

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

const DEFAULT_CONFIG: AiAssistantConfig = {
  id: 'default',
  enabled: 0,
  model: 'claude-haiku-4-5-20251001',
  knowledge: '',
  daily_limit: 10,
  updated_at: '',
};

/** 設定（単一行）を取得。無ければ既定値（enabled=0）。 */
export async function getAiAssistantConfig(db: D1Database): Promise<AiAssistantConfig> {
  const row = await db
    .prepare(`SELECT * FROM ai_assistant_config WHERE id = 'default'`)
    .first<AiAssistantConfig>();
  return row ?? { ...DEFAULT_CONFIG };
}

export interface UpdateAiAssistantConfigInput {
  enabled?: number;
  model?: string;
  knowledge?: string;
  daily_limit?: number;
}

/** 設定を部分更新する。updated_at は自動セット。 */
export async function updateAiAssistantConfig(
  db: D1Database,
  updates: UpdateAiAssistantConfigInput,
): Promise<void> {
  const now = new Date(Date.now() + 9 * 60 * 60_000).toISOString().replace('Z', '+09:00');
  const sets: string[] = ['updated_at = ?'];
  const bindings: unknown[] = [now];

  if (updates.enabled !== undefined) { sets.push('enabled = ?'); bindings.push(updates.enabled); }
  if (updates.model !== undefined) { sets.push('model = ?'); bindings.push(updates.model); }
  if (updates.knowledge !== undefined) { sets.push('knowledge = ?'); bindings.push(updates.knowledge); }
  if (updates.daily_limit !== undefined) { sets.push('daily_limit = ?'); bindings.push(updates.daily_limit); }

  bindings.push('default');
  await db
    .prepare(`UPDATE ai_assistant_config SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...bindings)
    .run();
}

/**
 * friend の当日返信回数を +1 し、加算後のカウントを返す（レート制限用）。
 * UNIQUE(friend_id, ymd) に対する UPSERT。
 */
export async function incrementAiUsage(
  db: D1Database,
  friendId: string,
  ymd: string,
): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO ai_assistant_usage (friend_id, ymd, count) VALUES (?, ?, 1)
       ON CONFLICT(friend_id, ymd) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(friendId, ymd)
    .first<{ count: number }>();
  return row?.count ?? 1;
}

/**
 * messages_log から直近のテキスト会話を時系列（古い→新しい）で取得し、
 * Claude messages 形式（incoming→user / outgoing→assistant）に変換する。
 */
export async function getRecentConversation(
  db: D1Database,
  friendId: string,
  limit = 10,
): Promise<ConversationTurn[]> {
  const res = await db
    .prepare(
      `SELECT direction, content FROM messages_log
       WHERE friend_id = ? AND message_type = 'text'
       ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(friendId, limit)
    .all<{ direction: 'incoming' | 'outgoing'; content: string }>();

  // DESC（新しい順）で取得したので逆順にして時系列へ
  return res.results
    .slice()
    .reverse()
    .map((r) => ({
      role: r.direction === 'incoming' ? ('user' as const) : ('assistant' as const),
      content: r.content,
    }));
}

/**
 * Claude へ渡す system / messages を組み立てる（純関数・TDD主対象）。
 * ガードレール: 推測せず正直に案内 / 店舗無関係は丁寧に断る / 簡潔。
 */
export function buildAssistantPayload(
  knowledge: string,
  history: ConversationTurn[],
  userText: string,
): { system: string; messages: ConversationTurn[] } {
  const system = [
    '【出力形式】プレーンテキストのみ。アスタリスク（*）・シャープ（#）・アンダースコア（_）による装飾は一切禁止。',
    '',
    'あなたはLINE公式アカウントの一次対応アシスタントです。以下の【店舗情報】だけを根拠に、丁寧で簡潔な日本語で答えてください。',
    '',
    '【ルール】',
    '- 店舗情報に答えが無い・不確実なことは推測せず、「担当者に確認しますので少々お待ちください」と案内する。',
    '- 店舗と関係のない話題（雑談・時事・専門相談など）は丁寧にお断りする。',
    '- 価格・予約・在庫など確定情報を勝手に断定しない。',
    '- 2〜3文程度で簡潔に。LINEメッセージとして自然な口調で。',
    '- マークダウン記法禁止：アスタリスクで囲んだ強調・シャープ記号による見出しは使わない。',
    '',
    '【店舗情報】',
    knowledge.trim() || '(未設定)',
  ].join('\n');

  const messages: ConversationTurn[] = [...history, { role: 'user', content: userText }];
  return { system, messages };
}

/**
 * Claude(Haiku) を呼び出して返信文を生成する。
 * diagnosis.ts / prompt-template.ts と同じ fetch パターン。
 */
export async function generateAssistantReply(
  config: AiAssistantConfig,
  history: ConversationTurn[],
  userText: string,
  apiKey: string,
): Promise<string> {
  const { system, messages } = buildAssistantPayload(config.knowledge, history, userText);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 500,
      system,
      messages,
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Anthropic API error ${response.status}: ${errText}`);
  }

  const data = (await response.json()) as { content: Array<{ type: string; text: string }> };
  const text = data.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  return text || '担当者に確認しますので少々お待ちください。';
}
