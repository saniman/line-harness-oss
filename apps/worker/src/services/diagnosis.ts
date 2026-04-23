import type { Env } from '../index.js';

export interface DiagnosisSession {
  id: string;
  friend_id: string;
  step: number;
  answers: Record<string, string>;
  status: 'in_progress' | 'completed';
  created_at: string;
  updated_at: string;
}

export const DIAGNOSIS_QUESTIONS = [
  {
    step: 1,
    text: 'Q1/5｜業種を教えてください',
    options: ['飲食・カフェ', '美容・サロン', '医療・介護', '士業・コンサル', '小売・EC', '製造・建設', 'その他'],
  },
  {
    step: 2,
    text: 'Q2/5｜従業員数は？',
    options: ['1人（個人事業主）', '2〜5人', '6〜20人', '21人以上'],
  },
  {
    step: 3,
    text: 'Q3/5｜今一番時間がかかっている業務は？',
    options: ['問い合わせ・返信対応', '予約・スケジュール管理', '書類・見積作成', 'SNS・コンテンツ運用', 'データ入力・集計', 'その他'],
  },
  {
    step: 4,
    text: 'Q4/5｜PCやスマホの操作は得意ですか？',
    options: ['得意（ツールも積極的に使う）', '普通（調べれば使える）', '苦手（できれば避けたい）'],
  },
  {
    step: 5,
    text: 'Q5/5｜AIツールを使ったことはありますか？',
    options: ['毎日使っている', 'たまに使う', 'ほぼ使ったことない', '全く使ったことない'],
  },
] as const;

export function getNextQuestion(currentStep: number) {
  return DIAGNOSIS_QUESTIONS.find(q => q.step === currentStep + 1) ?? null;
}

export function isCompleted(step: number): boolean {
  return step >= DIAGNOSIS_QUESTIONS.length;
}

export function buildQuickReply(options: readonly string[]) {
  return {
    type: 'quickReply' as const,
    items: options.map(opt => ({
      type: 'action' as const,
      action: {
        type: 'message' as const,
        label: opt,
        text: opt,
      },
    })),
  };
}

export function buildDiagnosisPrompt(answers: Record<string, string>): string {
  return `あなたは中小事業者向けのAI活用コンサルタントです。
以下の回答をもとに、業務のAI自動化可能性を診断してください。

業種：${answers.q1}
従業員数：${answers.q2}
最も時間がかかる業務：${answers.q3}
ITリテラシー：${answers.q4}
AI利用経験：${answers.q5}

以下の形式で診断結果を出力してください（LINEメッセージとして送るので簡潔に）：

【診断結果】
自動化可能性：★★★★☆（高い）

【今すぐ自動化できる業務 TOP3】
1. （具体的な業務名）
   → （どのAIツールで・どう自動化するか1行で）
2.
3.

【Akiからのひとこと】
（その業種・状況に合わせた100文字以内のメッセージ）

必ず日本語で、LINEで読みやすい長さで出力してください。`;
}

function jstNow(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().replace('Z', '+09:00');
}

export async function startDiagnosis(db: D1Database, friendId: string): Promise<DiagnosisSession> {
  // Close any existing in_progress session first
  await db
    .prepare(`UPDATE diagnosis_sessions SET status = 'completed', updated_at = ? WHERE friend_id = ? AND status = 'in_progress'`)
    .bind(jstNow(), friendId)
    .run();

  const id = crypto.randomUUID();
  const now = jstNow();
  await db
    .prepare(`INSERT INTO diagnosis_sessions (id, friend_id, step, answers, status, created_at, updated_at) VALUES (?, ?, 0, '{}', 'in_progress', ?, ?)`)
    .bind(id, friendId, now, now)
    .run();

  return { id, friend_id: friendId, step: 0, answers: {}, status: 'in_progress', created_at: now, updated_at: now };
}

export async function answerDiagnosis(db: D1Database, sessionId: string, answer: string): Promise<DiagnosisSession> {
  const row = await db
    .prepare(`SELECT * FROM diagnosis_sessions WHERE id = ?`)
    .bind(sessionId)
    .first<{ id: string; friend_id: string; step: number; answers: string; status: string; created_at: string; updated_at: string }>();

  if (!row) throw new Error(`Session not found: ${sessionId}`);

  const answers = JSON.parse(row.answers) as Record<string, string>;
  const newStep = row.step + 1;
  answers[`q${newStep}`] = answer;
  const newStatus = isCompleted(newStep) ? 'completed' : 'in_progress';
  const now = jstNow();

  await db
    .prepare(`UPDATE diagnosis_sessions SET step = ?, answers = ?, status = ?, updated_at = ? WHERE id = ?`)
    .bind(newStep, JSON.stringify(answers), newStatus, now, sessionId)
    .run();

  return {
    id: row.id,
    friend_id: row.friend_id,
    step: newStep,
    answers,
    status: newStatus,
    created_at: row.created_at,
    updated_at: now,
  };
}

export async function getActiveSession(db: D1Database, friendId: string): Promise<DiagnosisSession | null> {
  const row = await db
    .prepare(`SELECT * FROM diagnosis_sessions WHERE friend_id = ? AND status = 'in_progress' ORDER BY created_at DESC LIMIT 1`)
    .bind(friendId)
    .first<{ id: string; friend_id: string; step: number; answers: string; status: string; created_at: string; updated_at: string }>();

  if (!row) return null;
  return { ...row, answers: JSON.parse(row.answers) as Record<string, string>, status: row.status as 'in_progress' | 'completed' };
}

export async function generateDiagnosisResult(env: Env['Bindings'], answers: Record<string, string>): Promise<string> {
  const prompt = buildDiagnosisPrompt(answers);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${err}`);
  }

  const data = await response.json() as { content: Array<{ type: string; text: string }> };
  return data.content.find(b => b.type === 'text')?.text ?? '診断結果の生成に失敗しました。';
}
