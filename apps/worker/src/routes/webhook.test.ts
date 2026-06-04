import { describe, it, expect } from 'vitest';
import { buildWelcomeMessages, MAX_WEBHOOK_BODY_SIZE } from './webhook.js';

describe('followイベント', () => {
  it('ウェルカムメッセージが3通送信される', () => {
    const messages = buildWelcomeMessages();
    expect(messages).toHaveLength(3);
  });

  it('2通目にQuick Replyが3つ含まれる', () => {
    const messages = buildWelcomeMessages();
    const second = messages[1] as { quickReply: { items: unknown[] } };
    expect(second.quickReply).toBeDefined();
    expect(second.quickReply.items).toHaveLength(3);
  });

  it('3通目にイベント一覧FlexメッセージがLIFF URLつきで含まれる', () => {
    const messages = buildWelcomeMessages('https://liff.line.me/test');
    const third = messages[2] as { type: string; contents: { footer: { contents: Array<{ action: { uri?: string } }> } } };
    expect(third.type).toBe('flex');
    expect(third.contents.footer.contents[0].action.uri).toBe('https://liff.line.me/test?page=event');
  });

  it('3通目はLIFF URLがなくてもmessageアクションにフォールバックする', () => {
    const messages = buildWelcomeMessages();
    const third = messages[2] as { type: string; contents: { footer: { contents: Array<{ action: { type: string } }> } } };
    expect(third.type).toBe('flex');
    expect(third.contents.footer.contents[0].action.type).toBe('message');
  });
});

describe('ボディサイズ制限', () => {
  it('MAX_WEBHOOK_BODY_SIZE が 1 MiB である', () => {
    expect(MAX_WEBHOOK_BODY_SIZE).toBe(1024 * 1024);
  });
});
