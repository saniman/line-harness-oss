import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getAiAssistantConfig,
  getRecentConversation,
  incrementAiUsage,
  buildAssistantPayload,
  generateAssistantReply,
  stripMarkdown,
  type AiAssistantConfig,
} from './ai-assistant.js';

function makeStmt(firstResult: unknown = null, allResult: { results: unknown[] } = { results: [] }) {
  return {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue({ meta: {} }),
    first: vi.fn().mockResolvedValue(firstResult),
    all: vi.fn().mockResolvedValue(allResult),
  };
}
function makeDb(...stmts: ReturnType<typeof makeStmt>[]): D1Database {
  let i = 0;
  return { prepare: vi.fn().mockImplementation(() => stmts[i++] ?? makeStmt()) } as unknown as D1Database;
}

const CONFIG: AiAssistantConfig = {
  id: 'default', enabled: 1, model: 'claude-haiku-4-5-20251001',
  knowledge: '店名はWALOVERカフェ。営業は10-18時。定休は水曜。', daily_limit: 10,
  updated_at: '2026-06-14T00:00:00+09:00',
};

describe('getAiAssistantConfig', () => {
  it('行があればその設定を返す', async () => {
    const db = makeDb(makeStmt(CONFIG));
    const res = await getAiAssistantConfig(db);
    expect(res.enabled).toBe(1);
    expect(res.knowledge).toContain('WALOVERカフェ');
  });

  it('行が無ければ既定値（enabled=0）を返す', async () => {
    const db = makeDb(makeStmt(null));
    const res = await getAiAssistantConfig(db);
    expect(res.enabled).toBe(0);
    expect(res.model).toBe('claude-haiku-4-5-20251001');
    expect(res.daily_limit).toBeGreaterThan(0);
  });
});

describe('getRecentConversation', () => {
  it('messages_log を時系列(古い→新しい)で role 変換する', async () => {
    // DESC で取得 → 新しい順に返ってくる想定。関数側で逆順にする。
    const db = makeDb(makeStmt(null, {
      results: [
        { direction: 'outgoing', content: 'こんにちは！' },
        { direction: 'incoming', content: 'こんにちは' },
      ],
    }));
    const turns = await getRecentConversation(db, 'f1', 10);
    expect(turns).toEqual([
      { role: 'user', content: 'こんにちは' },
      { role: 'assistant', content: 'こんにちは！' },
    ]);
  });

  it('履歴が無ければ空配列', async () => {
    const db = makeDb(makeStmt(null, { results: [] }));
    expect(await getRecentConversation(db, 'f1', 10)).toEqual([]);
  });
});

describe('incrementAiUsage', () => {
  it('RETURNING された新カウントを返す', async () => {
    const db = makeDb(makeStmt({ count: 3 }));
    expect(await incrementAiUsage(db, 'f1', '2026-06-14')).toBe(3);
  });
});

describe('buildAssistantPayload', () => {
  it('system に knowledge とガードレールが含まれる', () => {
    const { system } = buildAssistantPayload('営業は10-18時', [], '営業時間は？');
    expect(system).toContain('営業は10-18時');
    expect(system).toContain('担当者');   // わからない時の案内
  });

  it('messages は履歴の後に今回のユーザー発話が来る', () => {
    const history = [
      { role: 'user' as const, content: 'こんにちは' },
      { role: 'assistant' as const, content: 'こんにちは！' },
    ];
    const { messages } = buildAssistantPayload('k', history, '営業時間は？');
    expect(messages).toHaveLength(3);
    expect(messages[2]).toEqual({ role: 'user', content: '営業時間は？' });
  });
});

describe('stripMarkdown', () => {
  it('**bold** を除去する（実際に発生した問題のパターン）', () => {
    expect(stripMarkdown('当社では **AIセミナーを不定期で開催** しております。'))
      .toBe('当社では AIセミナーを不定期で開催 しております。');
  });

  it('*italic* を除去する', () => {
    expect(stripMarkdown('こちらは *重要* です。')).toBe('こちらは 重要 です。');
  });

  it('# 見出しを除去する', () => {
    expect(stripMarkdown('# セミナー情報\n詳細です。')).toBe('セミナー情報\n詳細です。');
    expect(stripMarkdown('## 概要\n内容')).toBe('概要\n内容');
  });

  it('マークダウンを含まない文は変えない', () => {
    expect(stripMarkdown('担当者に確認しますので少々お待ちください。'))
      .toBe('担当者に確認しますので少々お待ちください。');
  });

  it('複合パターンを一括除去する', () => {
    expect(stripMarkdown('**ご質問** ありがとうございます。*セミナー* について。'))
      .toBe('ご質問 ありがとうございます。セミナー について。');
  });
});

describe('generateAssistantReply', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('Claude 応答の text を返す', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '10時〜18時です。' }] }),
    }));
    const reply = await generateAssistantReply(CONFIG, [], '営業時間は？', 'test-key');
    expect(reply).toBe('10時〜18時です。');
  });

  it('Claude がマークダウンを返しても除去してから返す', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '当社では **セミナー** を開催しています。' }] }),
    }));
    const reply = await generateAssistantReply(CONFIG, [], 'セミナーは？', 'test-key');
    expect(reply).toBe('当社では セミナー を開催しています。');
    expect(reply).not.toContain('**');
  });

  it('API エラー時は例外を投げる', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, text: vi.fn().mockResolvedValue('err') }));
    await expect(generateAssistantReply(CONFIG, [], 'x', 'test-key')).rejects.toThrow();
  });
});
