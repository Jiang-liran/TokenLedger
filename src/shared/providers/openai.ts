import type { ChatMessageInput, ChatOptions, ModelCapabilities } from '../types';
import { normalizeOpenAIUsage } from '../usage';
import type { UsageNormalization } from '../types';

export interface OpenAIRequestBody {
  model: string;
  input: { role: 'user' | 'assistant'; content: string }[];
  instructions?: string;
  stream: true;
  store: false;
  reasoning?: { effort: string };
  max_output_tokens?: number;
}

export interface BuildOpenAIRequestParams {
  model: string;
  messages: ChatMessageInput[];
  systemPrompt?: string | null;
  options?: ChatOptions;
  capabilities: ModelCapabilities;
}

/**
 * 构造 OpenAI Responses API 请求体。
 * 采用无状态本地历史（store:false + 全量 input），这样切换服务商时上下文仍由本地消息决定。
 * 仅对支持推理强度的模型发送 reasoning 参数，避免“模型不支持参数”错误。
 */
export function buildOpenAIRequestBody(params: BuildOpenAIRequestParams): OpenAIRequestBody {
  const { model, messages, systemPrompt, options, capabilities } = params;
  const input: OpenAIRequestBody['input'] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    const content = message.content.trim();
    if (!content) continue;
    input.push({ role: message.role, content });
  }

  const body: OpenAIRequestBody = {
    model,
    input,
    stream: true,
    store: false,
  };

  const instruction = systemPrompt?.trim();
  if (instruction) body.instructions = instruction;

  if (capabilities.reasoningEffort && options?.reasoningEffort) {
    // OpenAI 的 reasoning.effort 不使用 DeepSeek 的 "max"；统一钳制为 high。
    const effort = options.reasoningEffort === 'max' ? 'high' : options.reasoningEffort;
    body.reasoning = { effort };
  }
  if (options?.maxOutputTokens && options.maxOutputTokens > 0) {
    body.max_output_tokens = Math.floor(options.maxOutputTokens);
  }
  return body;
}

export interface OpenAIEventDetail {
  textDelta?: string;
  reasoningDelta?: string;
  usage?: unknown;
  providerId?: string;
  completed?: { status: string; note?: string };
  error?: { message: string; code?: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 解析 OpenAI Responses API 的单个 SSE 事件。 */
export function parseOpenAIEventDetailed(
  eventName: string | undefined,
  data: string,
): OpenAIEventDetail {
  if (data.trim() === '[DONE]') return { completed: { status: 'completed' } };
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(data);
    if (!isRecord(parsed)) return {};
    payload = parsed;
  } catch {
    return {};
  }
  const type = (typeof payload.type === 'string' ? payload.type : eventName) ?? '';
  const response = isRecord(payload.response) ? payload.response : null;
  const detail: OpenAIEventDetail = {};

  switch (type) {
    case 'response.created':
    case 'response.in_progress': {
      if (response && typeof response.id === 'string') detail.providerId = response.id;
      return detail;
    }
    case 'response.output_text.delta': {
      if (typeof payload.delta === 'string') detail.textDelta = payload.delta;
      return detail;
    }
    case 'response.reasoning_summary_text.delta':
    case 'response.reasoning_text.delta':
    case 'response.reasoning_summary.delta': {
      if (typeof payload.delta === 'string') detail.reasoningDelta = payload.delta;
      return detail;
    }
    case 'response.completed': {
      if (response && typeof response.id === 'string') detail.providerId = response.id;
      if (response?.usage) detail.usage = response.usage;
      detail.completed = { status: 'completed' };
      return detail;
    }
    case 'response.incomplete': {
      if (response?.usage) detail.usage = response.usage;
      const reason =
        isRecord(response?.incomplete_details) &&
        typeof response.incomplete_details.reason === 'string'
          ? String(response.incomplete_details.reason)
          : undefined;
      detail.completed = {
        status: 'incomplete',
        note: reason ? `回答未完整生成：${reason}` : '回答未完整生成',
      };
      return detail;
    }
    case 'response.failed': {
      const error = isRecord(response?.error) ? response.error : payload.error;
      detail.error = {
        message:
          isRecord(error) && typeof error.message === 'string'
            ? error.message
            : 'OpenAI 返回响应失败（response.failed）',
        code: isRecord(error) && typeof error.code === 'string' ? error.code : undefined,
      };
      return detail;
    }
    case 'error': {
      const error = isRecord(payload.error) ? payload.error : payload;
      detail.error = {
        message: typeof error.message === 'string' ? error.message : 'OpenAI 流式响应错误',
        code: typeof error.code === 'string' ? error.code : undefined,
      };
      return detail;
    }
    default:
      return detail;
  }
}

export function normalizeOpenAIResponseUsage(
  raw: unknown,
  capabilities: ModelCapabilities,
): UsageNormalization {
  return normalizeOpenAIUsage(raw, { supportsCacheWrite: capabilities.cacheWrite });
}
