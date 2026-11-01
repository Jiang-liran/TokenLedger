import { describe, expect, it } from 'vitest';
import { SseParser } from '../src/shared/providers/sse';
import {
  buildOpenAIRequestBody,
  normalizeOpenAIResponseUsage,
  parseOpenAIEventDetailed,
} from '../src/shared/providers/openai';
import {
  buildDeepSeekRequestBody,
  normalizeDeepSeekResponseUsage,
  parseDeepSeekChunk,
} from '../src/shared/providers/deepseek';
import { findModelPricing, inferCapabilities, isLikelyTextChatModel } from '../src/shared/pricing/catalog';
import type { ModelCapabilities } from '../src/shared/types';

function capsOf(model: string): ModelCapabilities {
  return findModelPricing('openai', model)!.pricing.capabilities;
}

describe('OpenAI Responses 请求构造', () => {
  it('使用 Responses API 无状态历史，system 转为 instructions', () => {
    const body = buildOpenAIRequestBody({
      model: 'gpt-6.1-sol',
      messages: [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好！' },
        { role: 'user', content: '继续' },
      ],
      systemPrompt: '请使用简体中文',
      options: { reasoningEffort: 'high', thinking: 'default' },
      capabilities: capsOf('gpt-6.1-sol'),
    });

    expect(body.model).toBe('gpt-6.1-sol');
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
    expect(body.instructions).toBe('请使用简体中文');
    expect(body.input).toEqual([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好！' },
      { role: 'user', content: '继续' },
    ]);
    expect(body.reasoning).toEqual({ effort: 'high' });
  });

  it('对不支持推理强度的经典模型不发送 reasoning 参数', () => {
    const body = buildOpenAIRequestBody({
      model: 'gpt-4.1',
      messages: [{ role: 'user', content: 'hi' }],
      options: { reasoningEffort: 'high' },
      capabilities: capsOf('gpt-4.1'),
    });
    expect(body.reasoning).toBeUndefined();
  });

  it('OpenAI 的 max 推理强度会被钳制为 high', () => {
    const body = buildOpenAIRequestBody({
      model: 'gpt-6.1-sol',
      messages: [{ role: 'user', content: 'hi' }],
      options: { reasoningEffort: 'max' },
      capabilities: capsOf('gpt-6.1-sol'),
    });
    expect(body.reasoning).toEqual({ effort: 'high' });
  });

  it('跳过空消息', () => {
    const body = buildOpenAIRequestBody({
      model: 'gpt-6.1-sol',
      messages: [
        { role: 'user', content: '   ' },
        { role: 'user', content: '有效' },
      ],
      capabilities: capsOf('gpt-6.1-sol'),
    });
    expect(body.input).toHaveLength(1);
  });
});

describe('OpenAI 流事件解析', () => {
  it('解析 response.created 的请求 ID', () => {
    const detail = parseOpenAIEventDetailed(
      'response.created',
      JSON.stringify({ type: 'response.created', response: { id: 'resp_123' } }),
    );
    expect(detail.providerId).toBe('resp_123');
  });

  it('解析文本增量与完成事件 usage', () => {
    const text = parseOpenAIEventDetailed(
      'response.output_text.delta',
      JSON.stringify({ type: 'response.output_text.delta', delta: '你好' }),
    );
    expect(text.textDelta).toBe('你好');

    const completed = parseOpenAIEventDetailed(
      'response.completed',
      JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_1',
          usage: {
            input_tokens: 100,
            input_tokens_details: { cached_tokens: 20, cache_write_tokens: 0 },
            output_tokens: 30,
            total_tokens: 130,
          },
        },
      }),
    );
    expect(completed.usage).toBeTruthy();
    expect(completed.completed?.status).toBe('completed');
    const normalized = normalizeOpenAIResponseUsage(completed.usage, capsOf('gpt-6.1-sol'));
    expect(normalized.usage.uncachedInputTokens).toBe(80);
    expect(normalized.usage.cacheReadTokens).toBe(20);
  });

  it('解析推理摘要增量', () => {
    const detail = parseOpenAIEventDetailed(
      'response.reasoning_summary_text.delta',
      JSON.stringify({ type: 'response.reasoning_summary_text.delta', delta: '思考…' }),
    );
    expect(detail.reasoningDelta).toBe('思考…');
  });

  it('解析 response.failed 错误', () => {
    const detail = parseOpenAIEventDetailed(
      'response.failed',
      JSON.stringify({
        type: 'response.failed',
        response: { error: { message: 'model overloaded', code: 'server_error' } },
      }),
    );
    expect(detail.error?.message).toBe('model overloaded');
  });
});

describe('DeepSeek Chat Completions 请求构造', () => {
  const caps = findModelPricing('deepseek', 'deepseek-flash')!.pricing.capabilities;

  it('启用流式 usage，并携带系统提示与历史', () => {
    const body = buildDeepSeekRequestBody({
      model: 'deepseek-flash',
      messages: [
        { role: 'user', content: '第一问' },
        { role: 'assistant', content: '第一答' },
        { role: 'user', content: '第二问' },
      ],
      systemPrompt: '系统提示',
      options: { thinking: 'default' },
      capabilities: caps,
    });
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.messages[0]).toEqual({ role: 'system', content: '系统提示' });
    expect(body.messages).toHaveLength(4);
  });

  it('思考模式与推理强度按设置发送', () => {
    const body = buildDeepSeekRequestBody({
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'hi' }],
      options: { thinking: 'enabled', reasoningEffort: 'high' },
      capabilities: caps,
    });
    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.reasoning_effort).toBe('high');
  });

  it('关闭思考模式时不发送推理强度', () => {
    const body = buildDeepSeekRequestBody({
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'hi' }],
      options: { thinking: 'disabled', reasoningEffort: 'high' },
      capabilities: caps,
    });
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('不把 reasoning_content 回传进历史消息（未使用 tools）', () => {
    const body = buildDeepSeekRequestBody({
      model: 'deepseek-flash',
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a' },
      ],
      capabilities: caps,
    });
    expect(JSON.stringify(body)).not.toContain('reasoning_content');
  });
});

describe('DeepSeek 流式响应块', () => {
  it('解析内容、推理内容与 usage', () => {
    const delta = parseDeepSeekChunk({
      id: 'chat_1',
      choices: [{ delta: { content: '你好', reasoning_content: '思考' }, finish_reason: null }],
    });
    expect(delta.providerId).toBe('chat_1');
    expect(delta.textDelta).toBe('你好');
    expect(delta.reasoningDelta).toBe('思考');

    const usageChunk = parseDeepSeekChunk({
      id: 'chat_1',
      choices: [],
      usage: {
        prompt_tokens: 100,
        prompt_cache_hit_tokens: 80,
        prompt_cache_miss_tokens: 20,
        completion_tokens: 10,
        total_tokens: 110,
      },
    });
    expect(usageChunk.usage).toBeTruthy();
    const normalized = normalizeDeepSeekResponseUsage(usageChunk.usage);
    expect(normalized.usage.cacheReadTokens).toBe(80);
    expect(normalized.usage.uncachedInputTokens).toBe(20);
  });

  it('解析 finish_reason 与错误对象', () => {
    expect(
      parseDeepSeekChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }).finishReason,
    ).toBe('stop');
    expect(parseDeepSeekChunk({ error: { message: 'bad request', code: '400' } }).error?.message).toBe(
      'bad request',
    );
  });
});

describe('SSE 解析器', () => {
  it('处理跨 chunk 的事件与 CRLF', () => {
    const parser = new SseParser();
    const first = parser.push('event: response.created\r\ndata: {"a":');
    expect(first).toHaveLength(0);
    const second = parser.push('1}\r\n\r\ndata: [DONE]\n\n');
    expect(second).toHaveLength(2);
    expect(second[0].event).toBe('response.created');
    expect(second[0].data).toBe('{"a":1}');
    expect(second[1].data).toBe('[DONE]');
  });

  it('忽略注释行并支持多行 data', () => {
    const parser = new SseParser();
    const events = parser.push(': keepalive\ndata: line1\ndata: line2\n\n');
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('line1\nline2');
  });

  it('flush 处理没有结尾空行的最后事件', () => {
    const parser = new SseParser();
    parser.push('data: tail');
    const events = parser.flush();
    expect(events[0].data).toBe('tail');
  });
});

describe('模型能力推断与列表过滤', () => {
  it('GPT-6 支持推理强度，GPT-4.1 不支持', () => {
    expect(inferCapabilities('openai', 'gpt-6.1-sol').reasoningEffort).toBe(true);
    expect(inferCapabilities('openai', 'gpt-4.1').reasoningEffort).toBe(false);
    expect(inferCapabilities('deepseek', 'deepseek-flash').thinkingToggle).toBe(true);
  });

  it('过滤非聊天模型', () => {
    expect(isLikelyTextChatModel('text-embedding-3-large')).toBe(false);
    expect(isLikelyTextChatModel('whisper-1')).toBe(false);
    expect(isLikelyTextChatModel('dall-e-3')).toBe(false);
    expect(isLikelyTextChatModel('gpt-6.1-sol')).toBe(true);
  });

  it('模型别名与前缀可以解析价格', () => {
    expect(findModelPricing('deepseek', 'deepseek-v4-flash')?.matchedBy).toBe('alias');
    expect(findModelPricing('openai', 'gpt-6.1-sol-2026-05-01')?.matchedBy).toBe('prefix');
    expect(findModelPricing('openai', 'gpt-6.1-sol-2026-05-01')?.pricing.model).toBe('gpt-6.1-sol');
    expect(findModelPricing('openai', 'unknown-model-xyz')).toBeNull();
  });
});
