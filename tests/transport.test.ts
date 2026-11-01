import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderHttpError,
  ProviderStreamError,
  fetchDeepSeekBalance,
  fetchProviderModels,
  streamProviderChat,
  testProviderConnection,
  type StreamRequest,
} from '../src/main/services/transport';
import type { ModelCapabilities } from '../src/shared/types';

const openaiCaps: ModelCapabilities = {
  reasoningEffort: true,
  thinkingToggle: false,
  cacheWrite: true,
  temperature: false,
  responsesApi: true,
  textChat: true,
};

const deepseekCaps: ModelCapabilities = {
  reasoningEffort: true,
  thinkingToggle: true,
  cacheWrite: false,
  temperature: true,
  responsesApi: false,
  textChat: true,
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function baseRequest(overrides: Partial<StreamRequest> = {}): StreamRequest {
  return {
    provider: 'openai',
    model: 'gpt-6.1-sol',
    apiKey: 'sk-test-key',
    messages: [{ role: 'user', content: '你好' }],
    systemPrompt: null,
    options: { reasoningEffort: 'high' },
    capabilities: openaiCaps,
    signal: new AbortController().signal,
    onTextDelta: () => {},
    onReasoningDelta: () => {},
    onUsage: () => {},
    onProviderRequestId: () => {},
    ...overrides,
  };
}

describe('OpenAI Responses 流式传输', () => {
  it('构造官方请求并解析流式文本、请求 ID 与 usage', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      capturedUrl = String(input);
      capturedInit = init;
      return sseResponse([
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_abc"}}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"你好"}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"，世界"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_abc","usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":20,"cache_write_tokens":0},"output_tokens":30,"total_tokens":130}}}\n\n',
      ]);
    }) as typeof fetch;

    const deltas: string[] = [];
    const usages: unknown[] = [];
    const ids: string[] = [];
    const result = await streamProviderChat(
      baseRequest({
        onTextDelta: (delta) => deltas.push(delta),
        onUsage: (usage) => usages.push(usage),
        onProviderRequestId: (id) => ids.push(id),
      }),
    );

    expect(capturedUrl).toBe('https://api.openai.com/v1/responses');
    expect((capturedInit?.headers as Record<string, string>).Authorization).toBe('Bearer sk-test-key');
    const body = JSON.parse(String(capturedInit?.body));
    expect(body.model).toBe('gpt-6.1-sol');
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
    expect(body.reasoning).toEqual({ effort: 'high' });
    expect(deltas.join('')).toBe('你好，世界');
    expect(ids).toEqual(['resp_abc']);
    expect(usages).toHaveLength(1);
    expect(result.usageRaw).toBeTruthy();
    expect(result.providerRequestId).toBe('resp_abc');
  });

  it('DeepSeek 请求启用 include_usage 并解析 usage 块与 [DONE]', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      capturedUrl = String(input);
      capturedInit = init;
      return sseResponse([
        'data: {"id":"chat_1","choices":[{"delta":{"content":"回答"},"finish_reason":null}]}\n\n',
        'data: {"id":"chat_1","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: {"id":"chat_1","choices":[],"usage":{"prompt_tokens":100,"prompt_cache_hit_tokens":80,"prompt_cache_miss_tokens":20,"completion_tokens":10,"total_tokens":110}}\n\n',
        'data: [DONE]\n\n',
      ]);
    }) as typeof fetch;

    const deltas: string[] = [];
    const usages: unknown[] = [];
    const result = await streamProviderChat(
      baseRequest({
        provider: 'deepseek',
        model: 'deepseek-flash',
        capabilities: deepseekCaps,
        options: { thinking: 'enabled', reasoningEffort: 'high' },
        onTextDelta: (delta) => deltas.push(delta),
        onUsage: (usage) => usages.push(usage),
      }),
    );

    expect(capturedUrl).toBe('https://api.deepseek.com/chat/completions');
    const body = JSON.parse(String(capturedInit?.body));
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.reasoning_effort).toBe('high');
    expect(deltas).toEqual(['回答']);
    expect(usages).toHaveLength(1);
    expect(result.finishStatus).toBe('completed');
  });

  it('非 2xx 响应转换为中文可读的 ProviderHttpError', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: 'Incorrect API key', code: 'invalid_api_key' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

    await expect(streamProviderChat(baseRequest())).rejects.toMatchObject({
      name: 'ProviderHttpError',
      status: 401,
      code: 'invalid_api_key',
    });
    await expect(streamProviderChat(baseRequest())).rejects.toBeInstanceOf(ProviderHttpError);
  });

  it('流在完成事件前结束时报错，避免虚假完成', async () => {
    globalThis.fetch = (async () =>
      sseResponse(['event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"部分"}\n\n'])) as typeof fetch;

    await expect(streamProviderChat(baseRequest())).rejects.toBeInstanceOf(ProviderStreamError);
  });
});

describe('模型列表、连接测试与余额', () => {
  it('使用官方模型接口并携带 Authorization', async () => {
    let url = '';
    const headers = new Headers();
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      url = String(input);
      const incoming = new Headers(init?.headers);
      incoming.forEach((value, key) => headers.set(key, value));
      return new Response(JSON.stringify({ data: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-6-luna' }] }), {
        status: 200,
      });
    }) as typeof fetch;

    const { ids } = await fetchProviderModels('openai', 'sk-test');
    expect(url).toBe('https://api.openai.com/v1/models');
    expect(headers.get('authorization')).toBe('Bearer sk-test');
    expect(ids).toEqual(['gpt-6-luna', 'gpt-6.1-sol']);
  });

  it('连接测试返回成功与延迟', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: 'deepseek-flash' }] }), { status: 200 })) as typeof fetch;
    const result = await testProviderConnection('deepseek', 'sk-test');
    expect(result.ok).toBe(true);
    expect(result.message).toContain('连接成功');
    expect(result.httpStatus).toBe(200);
  });

  it('连接失败时返回可读原因而不是抛异常', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: 'Unauthorized' } }), { status: 401 })) as typeof fetch;
    const result = await testProviderConnection('openai', 'sk-bad');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('API Key 无效');
  });

  it('DeepSeek 余额接口保留官方币种字段', async () => {
    let url = '';
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      url = String(input);
      return new Response(
        JSON.stringify({
          is_available: true,
          balance_infos: [
            {
              currency: 'CNY',
              total_balance: '110.00',
              granted_balance: '10.00',
              topped_up_balance: '100.00',
            },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const result = await fetchDeepSeekBalance('sk-test');
    expect(url).toBe('https://api.deepseek.com/user/balance');
    expect(result.isAvailable).toBe(true);
    expect(result.infos[0]).toEqual({
      currency: 'CNY',
      totalBalance: '110.00',
      grantedBalance: '10.00',
      toppedUpBalance: '100.00',
    });
  });
});
