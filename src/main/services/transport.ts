import type {
  ChatMessageInput,
  ChatOptions,
  ModelCapabilities,
  ProviderId,
  RequestPurpose,
} from '../../shared/types';
import {
  DEFAULT_DEEPSEEK_BASE_URL,
  DEFAULT_OPENAI_BASE_URL,
} from '../../shared/pricing/catalog';
import { SseParser, type SseEvent } from '../../shared/providers/sse';
import { parseOpenAIEventDetailed, buildOpenAIRequestBody } from '../../shared/providers/openai';
import { parseDeepSeekChunk, buildDeepSeekRequestBody } from '../../shared/providers/deepseek';
import {
  describeHttpFailure,
  describeNetworkFailure,
  isAbortError,
} from '../../shared/providers/errors';

export interface StreamRequest {
  purpose?: RequestPurpose;
  provider: ProviderId;
  model: string;
  apiKey: string;
  messages: ChatMessageInput[];
  systemPrompt: string | null;
  options: ChatOptions;
  capabilities: ModelCapabilities;
  signal: AbortSignal;
  onTextDelta: (delta: string) => void;
  onReasoningDelta: (delta: string) => void;
  onUsage: (raw: unknown) => void;
  onProviderRequestId: (id: string) => void;
}

export interface StreamResult {
  usageRaw: unknown | null;
  providerRequestId: string | null;
  finishStatus: 'completed' | 'incomplete';
  note?: string;
}

export class ProviderHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail?: string;
  readonly retryAfter?: string;

  constructor(message: string, status: number, code: string, detail?: string, retryAfter?: string) {
    super(message);
    this.name = 'ProviderHttpError';
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.retryAfter = retryAfter;
  }
}

export class ProviderStreamError extends Error {
  readonly code: string;
  readonly detail?: string;
  override cause?: unknown;

  constructor(message: string, code: string, detail?: string) {
    super(message);
    this.name = 'ProviderStreamError';
    this.code = code;
    this.detail = detail;
  }
}

export type StreamFunction = (request: StreamRequest) => Promise<StreamResult>;

const OVERALL_TIMEOUT_MS = 10 * 60 * 1000;
const IDLE_TIMEOUT_MS = 2 * 60 * 1000;

function timeoutError(message: string): Error {
  const error = new Error(message);
  error.name = 'TimeoutError';
  return error;
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 20_000);
  } catch {
    return '';
  }
}

async function assertOk(response: Response, provider: ProviderId, model: string): Promise<void> {
  if (response.ok) return;
  const body = await readErrorBody(response);
  const retryAfter = response.headers.get('retry-after') ?? undefined;
  const friendly = describeHttpFailure(provider, response.status, body, model, retryAfter);
  throw new ProviderHttpError(friendly.message, response.status, friendly.code, friendly.detail, retryAfter);
}

export async function streamProviderChat(request: StreamRequest): Promise<StreamResult> {
  const abortController = new AbortController();
  const onUserAbort = () => abortController.abort(new DOMException('Aborted', 'AbortError'));
  request.signal.addEventListener('abort', onUserAbort, { once: true });

  let idleTimer: NodeJS.Timeout | null = null;
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      abortController.abort(timeoutError('流式响应长时间无数据（空闲超时）'));
    }, IDLE_TIMEOUT_MS);
  };

  const combined = AbortSignal.any([abortController.signal, AbortSignal.timeout(OVERALL_TIMEOUT_MS)]);

  try {
    resetIdle();
    const isOpenAI = request.provider === 'openai';
    const url = isOpenAI
      ? `${DEFAULT_OPENAI_BASE_URL}/responses`
      : `${DEFAULT_DEEPSEEK_BASE_URL}/chat/completions`;
    const body = isOpenAI
      ? buildOpenAIRequestBody({
          model: request.model,
          messages: request.messages,
          systemPrompt: request.systemPrompt,
          options: request.options,
          capabilities: request.capabilities,
        })
      : buildDeepSeekRequestBody({
          model: request.model,
          messages: request.messages,
          systemPrompt: request.systemPrompt,
          options: request.options,
          capabilities: request.capabilities,
        });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${request.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: combined,
    });
    await assertOk(response, request.provider, request.model);
    if (!response.body) throw new ProviderStreamError('服务商未返回可读取的流式响应', 'empty_body');

    const parser = new SseParser();
    const state: {
      usageRaw: unknown | null;
      providerRequestId: string | null;
      finishStatus: 'completed' | 'incomplete';
      note?: string;
      terminal: boolean;
    } = {
      usageRaw: null,
      providerRequestId: null,
      finishStatus: 'completed',
      terminal: false,
    };

    const reportProviderId = (id: string | undefined): void => {
      if (!id || id === state.providerRequestId) return;
      state.providerRequestId = id;
      request.onProviderRequestId(id);
    };

    const handleEvent = (event: SseEvent): void => {
      resetIdle();
      if (isOpenAI) {
        const detail = parseOpenAIEventDetailed(event.event, event.data);
        reportProviderId(detail.providerId);
        if (detail.textDelta) request.onTextDelta(detail.textDelta);
        if (detail.reasoningDelta) request.onReasoningDelta(detail.reasoningDelta);
        if (detail.error) {
          throw new ProviderStreamError(detail.error.message, detail.error.code ?? 'stream_error');
        }
        if (detail.usage) {
          state.usageRaw = detail.usage;
          request.onUsage(detail.usage);
        }
        if (detail.completed) {
          state.terminal = true;
          if (detail.completed.status !== 'completed') {
            state.finishStatus = 'incomplete';
            state.note = detail.completed.note;
          }
        }
        return;
      }

      if (event.data.trim() === '[DONE]') {
        state.terminal = true;
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      const detail = parseDeepSeekChunk(payload);
      reportProviderId(detail.providerId);
      if (detail.error) {
        throw new ProviderStreamError(detail.error.message, detail.error.code ?? 'stream_error');
      }
      if (detail.textDelta) request.onTextDelta(detail.textDelta);
      if (detail.reasoningDelta) request.onReasoningDelta(detail.reasoningDelta);
      if (detail.usage) {
        state.usageRaw = detail.usage;
        request.onUsage(detail.usage);
      }
      if (detail.finishReason) {
        state.terminal = true;
        if (detail.finishReason === 'length') {
          state.finishStatus = 'incomplete';
          state.note = '输出达到最大长度限制，回答可能不完整。';
        }
      }
    };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const read = await reader.read();
      if (read.done) break;
      resetIdle();
      for (const event of parser.push(decoder.decode(read.value, { stream: true }))) {
        handleEvent(event);
      }
    }
    for (const event of parser.push(decoder.decode())) handleEvent(event);
    for (const event of parser.flush()) handleEvent(event);

    if (!state.terminal) {
      throw new ProviderStreamError(
        '流式响应意外结束，未收到完成事件。已保留已接收的内容，但使用量可能未知。',
        'stream_interrupted',
      );
    }

    return {
      usageRaw: state.usageRaw,
      providerRequestId: state.providerRequestId,
      finishStatus: state.finishStatus,
      note: state.note,
    };
  } catch (error) {
    if (isAbortError(error) && request.signal.aborted) throw error;
    if (error instanceof ProviderHttpError || error instanceof ProviderStreamError) throw error;
    const friendly = describeNetworkFailure(error);
    const wrapped = new ProviderStreamError(friendly.message, friendly.code, friendly.detail);
    wrapped.cause = error;
    throw wrapped;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    request.signal.removeEventListener('abort', onUserAbort);
  }
}

export async function fetchProviderModels(
  provider: ProviderId,
  apiKey: string,
  signal?: AbortSignal,
): Promise<{ ids: string[] }> {
  const base = provider === 'openai' ? DEFAULT_OPENAI_BASE_URL : DEFAULT_DEEPSEEK_BASE_URL;
  const response = await fetch(`${base}/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal: signal ?? AbortSignal.timeout(20_000),
  });
  await assertOk(response, provider, '');
  const data = (await response.json()) as { data?: { id?: string }[] };
  const ids = (data.data ?? [])
    .map((item) => item.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
    .sort((a, b) => a.localeCompare(b));
  return { ids };
}

export async function testProviderConnection(
  provider: ProviderId,
  apiKey: string,
): Promise<{ ok: boolean; message: string; latencyMs?: number; httpStatus?: number }> {
  const started = Date.now();
  try {
    const { ids } = await fetchProviderModels(provider, apiKey);
    return {
      ok: true,
      message: `连接成功，读取到 ${ids.length} 个模型。`,
      latencyMs: Date.now() - started,
      httpStatus: 200,
    };
  } catch (error) {
    if (error instanceof ProviderHttpError) {
      return {
        ok: false,
        message: error.message,
        latencyMs: Date.now() - started,
        httpStatus: error.status,
      };
    }
    const friendly = describeNetworkFailure(error);
    return { ok: false, message: friendly.message, latencyMs: Date.now() - started };
  }
}

export interface BalanceInfo {
  currency: string;
  totalBalance: string;
  grantedBalance: string;
  toppedUpBalance: string;
}

export async function fetchDeepSeekBalance(
  apiKey: string,
): Promise<{ isAvailable: boolean; infos: BalanceInfo[]; raw: unknown }> {
  const response = await fetch(`${DEFAULT_DEEPSEEK_BASE_URL}/user/balance`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  await assertOk(response, 'deepseek', '');
  const data = (await response.json()) as {
    is_available?: boolean;
    balance_infos?: {
      currency?: string;
      total_balance?: string;
      granted_balance?: string;
      topped_up_balance?: string;
    }[];
  };
  const infos = (data.balance_infos ?? [])
    .filter((item) => typeof item.currency === 'string')
    .map((item) => ({
      currency: String(item.currency),
      totalBalance: String(item.total_balance ?? ''),
      grantedBalance: String(item.granted_balance ?? ''),
      toppedUpBalance: String(item.topped_up_balance ?? ''),
    }));
  return { isAvailable: data.is_available === true, infos, raw: data };
}
