import { describe, it, expect } from 'vitest';
import { buildWelcomeMessages, MAX_WEBHOOK_BODY_SIZE } from './webhook.js';

describe('followイベント', () => {
  it('ウェルカムメッセージが2通送信される', () => {
    const messages = buildWelcomeMessages();
    expect(messages).toHaveLength(2);
  });

  it('2通目にQuick Replyが含まれる', () => {
    const messages = buildWelcomeMessages();
    const second = messages[1] as { quickReply: { items: unknown[] } };
    expect(second.quickReply).toBeDefined();
    expect(second.quickReply.items).toHaveLength(2);
  });
});

describe('ボディサイズ制限', () => {
  it('MAX_WEBHOOK_BODY_SIZE が 1 MiB である', () => {
    expect(MAX_WEBHOOK_BODY_SIZE).toBe(1024 * 1024);
  });
});
