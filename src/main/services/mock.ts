import type { StreamFunction, StreamRequest, StreamResult } from './transport';
import type { ProviderId } from '../../shared/types';

function abortError(): Error {
  const error = new Error('已停止生成');
  error.name = 'AbortError';
  return error;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function mockUsage(provider: ProviderId): unknown {
  if (provider === 'openai') {
    return {
      input_tokens: 5200,
      input_tokens_details: {
        cached_tokens: 4500,
        cache_write_tokens: 0,
        cache_write_tokens_details: { ttl_30m_tokens: 0, ttl_12h_tokens: 0 },
      },
      output_tokens: 300,
      output_tokens_details: { reasoning_tokens: 120 },
      total_tokens: 5500,
    };
  }
  return {
    prompt_tokens: 3000,
    prompt_cache_hit_tokens: 2000,
    prompt_cache_miss_tokens: 1000,
    completion_tokens: 500,
    completion_tokens_details: { reasoning_tokens: 180 },
    total_tokens: 3500,
  };
}

function mockText(provider: ProviderId, lastUserMessage: string): string {
  const label = provider === 'openai' ? 'OpenAI' : 'DeepSeek';
  return [
    `这是 **TokenLedger 测试模式** 的模拟回复（不会向 ${label} 发起真实请求）。`,
    '',
    `你刚才说的是：「${lastUserMessage.slice(0, 120)}」`,
    '',
    '这条回复用于验证以下能力：',
    '',
    '1. **流式输出**：文字实时出现，可随时点击“停止生成”。',
    '2. **Markdown 与代码高亮**：',
    '',
    '```ts',
    'const cost = (tokens * pricePerMillion) / 1_000_000;',
    '```',
    '',
    '3. **KaTeX 数学公式**：行内 $E = mc^2$，以及块级公式：',
    '',
    '$$ \\text{total} = \\text{input} + \\text{cached} + \\text{output} $$',
    '',
    '> 这里的 usage 是固定的测试数据，用于核对费用计算结果。',
    '',
    '4. **费用统计**：每条回复下方会展示本轮 Token 与估算费用，顶部展示会话累计。',
  ].join('\n');
}

export function createMockStream(): StreamFunction {
  return async (request: StreamRequest): Promise<StreamResult> => {
    const lastUser = [...request.messages].reverse().find((message) => message.role === 'user');
    const text = mockText(request.provider, lastUser?.content ?? '（空消息）');
    const providerRequestId = `mock-${request.provider}-${Date.now()}`;

    if (request.capabilities.reasoningEffort) {
      const reasoning = '先理解用户问题，再给出结构化回答，并附带可验证的示例。';
      for (let index = 0; index < reasoning.length; index += 12) {
        await delay(20, request.signal);
        request.onReasoningDelta(reasoning.slice(index, index + 12));
      }
    }

    for (let index = 0; index < text.length; index += 24) {
      await delay(22, request.signal);
      request.onTextDelta(text.slice(index, index + 24));
    }

    const usageRaw = mockUsage(request.provider);
    await delay(60, request.signal);
    request.onProviderRequestId(providerRequestId);
    request.onUsage(usageRaw);
    await delay(40, request.signal);
    return {
      usageRaw,
      providerRequestId,
      finishStatus: 'completed',
    };
  };
}
