import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from '../src/main/db/database';
import { Store } from '../src/main/db/repositories';
import { PricingService } from '../src/main/services/pricing';
import { ChatService } from '../src/main/services/chat';
import { MemorySecretStore } from '../src/main/services/secrets';
import type { StreamFunction, StreamRequest } from '../src/main/services/transport';
import type { ChatStreamEvent, NormalizedUsage, ProviderId } from '../src/shared/types';
import type { StatRequest } from '../src/shared/stats';
import { normalizeOpenAIUsage, normalizeDeepSeekUsage } from '../src/shared/usage';

export function tempDir(prefix = 'tokenledger-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function createStore(dir = tempDir()): { dir: string; db: Database; store: Store } {
  const db = new Database(path.join(dir, 'tokenledger.db'));
  return { dir, db, store: new Store(db) };
}

export const OPENAI_USAGE_RAW = {
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

export const DEEPSEEK_USAGE_RAW = {
  prompt_tokens: 3000,
  prompt_cache_hit_tokens: 2000,
  prompt_cache_miss_tokens: 1000,
  completion_tokens: 500,
  completion_tokens_details: { reasoning_tokens: 180 },
  total_tokens: 3500,
};

export function usageFromOpenAI(raw: unknown = OPENAI_USAGE_RAW): NormalizedUsage {
  return normalizeOpenAIUsage(raw, { supportsCacheWrite: true }).usage;
}

export function usageFromDeepSeek(raw: unknown = DEEPSEEK_USAGE_RAW): NormalizedUsage {
  return normalizeDeepSeekUsage(raw).usage;
}

export function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
  intervalMs = 20,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      let result = false;
      try {
        result = predicate();
      } catch {
        result = false;
      }
      if (result) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('等待条件超时'));
      }
    }, intervalMs);
  });
}

export function waitForEvent<T extends ChatStreamEvent['type']>(
  events: ChatStreamEvent[],
  type: T,
  timestamp = 0,
): Promise<Extract<ChatStreamEvent, { type: T }>> {
  return waitFor(() => events.some((event) => event.type === type)).then(() => {
    const found = events.filter(
      (event): event is Extract<ChatStreamEvent, { type: T }> => event.type === type,
    );
    const event = found[Math.max(0, found.length - 1 - timestamp)];
    if (!event) throw new Error(`未找到事件 ${type}`);
    return event;
  });
}

export interface FakeStreamOptions {
  usageRaw?: unknown | null;
  usageByProvider?: Partial<Record<ProviderId, unknown | null>>;
  text?: string;
  reasoning?: string;
  delayMs?: number;
  throwError?: Error;
  waitForAbort?: boolean;
  onRequest?: (request: StreamRequest) => void;
}

export function createFakeStream(
  options: FakeStreamOptions = {},
): { stream: StreamFunction; requests: StreamRequest[] } {
  const requests: StreamRequest[] = [];
  const stream: StreamFunction = async (request) => {
    requests.push(request);
    options.onRequest?.(request);
    if (options.reasoning) request.onReasoningDelta(options.reasoning);
    if (options.text) {
      for (const char of options.text.split('')) {
        if (request.signal.aborted) {
          const error = new Error('已停止生成');
          error.name = 'AbortError';
          throw error;
        }
        request.onTextDelta(char);
      }
    }
    if (options.waitForAbort) {
      await new Promise<void>((_, reject) => {
        if (request.signal.aborted) {
          const error = new Error('已停止生成');
          error.name = 'AbortError';
          reject(error);
          return;
        }
        request.signal.addEventListener(
          'abort',
          () => {
            const error = new Error('已停止生成');
            error.name = 'AbortError';
            reject(error);
          },
          { once: true },
        );
      });
    }
    if (options.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
    if (options.throwError) throw options.throwError;
    const hasProviderUsage =
      options.usageByProvider && request.provider in options.usageByProvider;
    const usageRaw = hasProviderUsage
      ? (options.usageByProvider?.[request.provider] ?? null)
      : (options.usageRaw ?? null);
    if (usageRaw !== null) request.onUsage(usageRaw);
    return {
      usageRaw,
      providerRequestId: 'fake-provider-request',
      finishStatus: 'completed' as const,
    };
  };
  return { stream, requests };
}

export function createChatHarness(options: FakeStreamOptions & { now?: () => Date } = {}): {
  store: Store;
  db: Database;
  dir: string;
  chat: ChatService;
  events: ChatStreamEvent[];
  requests: StreamRequest[];
  secrets: MemorySecretStore;
  pricing: PricingService;
} {
  const { dir, db, store } = createStore();
  const secrets = new MemorySecretStore();
  secrets.preload('openai', 'test-openai-key-not-real');
  secrets.preload('deepseek', 'test-deepseek-key-not-real');
  const pricing = new PricingService(store);
  const fake = createFakeStream(options);
  const events: ChatStreamEvent[] = [];
  let clock = Date.parse('2026-11-02T02:00:00.000Z');
  const now = options.now ?? (() => new Date((clock += 1000)));
  const chat = new ChatService({
    store,
    secrets,
    pricing,
    stream: fake.stream,
    emit: (event) => events.push(event),
    now,
  });
  return { store, db, dir, chat, events, requests: fake.requests, secrets, pricing };
}

export function makeStatRequest(overrides: Partial<StatRequest> = {}): StatRequest {
  return {
    id: 'req_1',
    conversationId: 'conv_1',
    conversationTitle: '测试会话',
    turnId: 'turn_1',
    provider: 'openai',
    model: 'gpt-6.1-sol',
    startedAt: '2026-11-02T02:00:00.000Z',
    status: 'completed',
    usage: usageFromOpenAI(),
    costAmount: '0.00485',
    costCurrency: 'USD',
    costUsd: '0.00485',
    calculationStatus: 'calculated',
    pricingSnapshotId: 'prc_1',
    pricingVersion: 'openai-2026.11.01',
    pricingBasis: '标准价格',
    errorDetails: null,
    ...overrides,
  };
}
