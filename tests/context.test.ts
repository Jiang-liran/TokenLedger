import { describe, expect, it } from 'vitest';
import {
  DEEPSEEK_USAGE_RAW,
  OPENAI_USAGE_RAW,
  createChatHarness,
  createStore,
  tempDir,
  waitForEvent,
} from './helpers';

const facts = {
  first: '请记住：项目代号是 ORBIT-7，负责人是林舟。',
  second: '项目代号和负责人分别是什么？',
  third: '请再重复一次项目代号。',
};

describe('多轮对话上下文（请求级验证）', () => {
  it('OpenAI 三轮请求完整携带此前的 user 与 assistant 消息', async () => {
    const h = createChatHarness({ usageRaw: OPENAI_USAGE_RAW, text: '固定回答' });
    const first = await h.chat.send({
      provider: 'openai',
      model: 'gpt-6.1-sol',
      content: facts.first,
    });
    await waitForEvent(h.events, 'completed');
    await h.chat.send({
      conversationId: first.conversationId,
      provider: 'openai',
      model: 'gpt-6.1-sol',
      content: facts.second,
    });
    await waitForEvent(h.events, 'completed');
    await h.chat.send({
      conversationId: first.conversationId,
      provider: 'openai',
      model: 'gpt-6.1-sol',
      content: facts.third,
    });
    await waitForEvent(h.events, 'completed');

    expect(h.requests[1].messages.map((message) => `${message.role}:${message.content}`)).toEqual([
      `user:${facts.first}`,
      'assistant:固定回答',
      `user:${facts.second}`,
    ]);
    expect(h.requests[2].messages.map((message) => `${message.role}:${message.content}`)).toEqual([
      `user:${facts.first}`,
      'assistant:固定回答',
      `user:${facts.second}`,
      'assistant:固定回答',
      `user:${facts.third}`,
    ]);
    // 适配器不依赖 OpenAI 服务端 response id；这里明确验证为无状态全量历史。
    expect(h.requests[2]).not.toHaveProperty('previousResponseId');
    expect(h.requests[2].messages).toHaveLength(5);
    h.db.close();
  });

  it('DeepSeek 三轮请求完整携带 user/assistant，不重传 reasoning_content', async () => {
    const h = createChatHarness({
      usageRaw: DEEPSEEK_USAGE_RAW,
      text: '固定回答',
      reasoning: '内部推理不应进入下一轮请求',
    });
    const first = await h.chat.send({
      provider: 'deepseek',
      model: 'deepseek-flash',
      content: facts.first,
    });
    await waitForEvent(h.events, 'completed');
    await h.chat.send({
      conversationId: first.conversationId,
      provider: 'deepseek',
      model: 'deepseek-flash',
      content: facts.second,
    });
    await waitForEvent(h.events, 'completed');
    await h.chat.send({
      conversationId: first.conversationId,
      provider: 'deepseek',
      model: 'deepseek-flash',
      content: facts.third,
    });
    await waitForEvent(h.events, 'completed');

    const third = h.requests[2].messages;
    expect(third.map((message) => `${message.role}:${message.content}`)).toEqual([
      `user:${facts.first}`,
      'assistant:固定回答',
      `user:${facts.second}`,
      'assistant:固定回答',
      `user:${facts.third}`,
    ]);
    expect(JSON.stringify(third)).not.toContain('内部推理');
    expect(JSON.stringify(third)).not.toContain('reasoning_content');
    h.db.close();
  });

  it('同一会话切换服务商后，使用本地可见消息延续上下文', async () => {
    const h = createChatHarness({
      usageByProvider: { openai: OPENAI_USAGE_RAW, deepseek: DEEPSEEK_USAGE_RAW },
      text: '固定回答',
    });
    const first = await h.chat.send({
      provider: 'openai',
      model: 'gpt-6.1-sol',
      content: facts.first,
    });
    await waitForEvent(h.events, 'completed');
    await h.chat.send({
      conversationId: first.conversationId,
      provider: 'deepseek',
      model: 'deepseek-flash',
      content: facts.second,
    });
    await waitForEvent(h.events, 'completed');

    expect(h.requests[1].provider).toBe('deepseek');
    expect(h.requests[1].messages.map((message) => `${message.role}:${message.content}`)).toEqual([
      `user:${facts.first}`,
      'assistant:固定回答',
      `user:${facts.second}`,
    ]);
    expect(JSON.stringify(h.requests[1].messages)).not.toContain('resp_');
    h.db.close();
  });

  it('重新生成时不会把被替换的助手消息送入上下文', async () => {
    const h = createChatHarness({ usageRaw: OPENAI_USAGE_RAW, text: '旧回答' });
    const first = await h.chat.send({
      provider: 'openai',
      model: 'gpt-6.1-sol',
      content: facts.first,
    });
    await waitForEvent(h.events, 'completed');
    await h.chat.regenerate(first.turnId, first.assistantMessageId, 'openai', 'gpt-6.1-sol');
    await waitForEvent(h.events, 'completed');
    const regenerateRequest = h.requests.at(-1)!;
    expect(regenerateRequest.messages.map((message) => `${message.role}:${message.content}`)).toEqual([
      `user:${facts.first}`,
    ]);
    h.db.close();
  });

  it('失败/中止的轮次不会把孤立用户消息带入后续上下文', () => {
    const { db, store } = createStore(tempDir());
    const conversation = store.createConversation({
      title: '失败上下文',
      provider: 'openai',
      model: 'gpt-6.1-sol',
    });
    const now = '2026-11-02T02:00:00.000Z';
    store.createTurn({
      turnId: 'turn_failed',
      conversationId: conversation.id,
      userMessageId: 'msg_user_failed',
      assistantMessageId: 'msg_assistant_failed',
      content: '失败的问题',
      provider: 'openai',
      model: 'gpt-6.1-sol',
      now,
    });
    store.updateAssistantMessage('msg_assistant_failed', {
      content: '中断的回答',
      status: 'error',
      errorDetails: '流中断',
    });
    expect(store.listContextMessages(conversation.id, [])).toHaveLength(0);

    store.createTurn({
      turnId: 'turn_ok',
      conversationId: conversation.id,
      userMessageId: 'msg_user_ok',
      assistantMessageId: 'msg_assistant_ok',
      content: '成功的问题',
      provider: 'openai',
      model: 'gpt-6.1-sol',
      now: '2026-11-02T02:00:01.000Z',
    });
    store.updateAssistantMessage('msg_assistant_ok', { content: '成功的回答', status: 'complete' });
    expect(store.listContextMessages(conversation.id, []).map((message) => message.content)).toEqual([
      '成功的问题',
      '成功的回答',
    ]);
    db.close();
  });
});
