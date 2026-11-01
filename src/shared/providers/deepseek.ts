import type { ChatMessageInput, ChatOptions, ModelCapabilities } from '../types';
import { normalizeDeepSeekUsage } from '../usage';
import type { UsageNormalization } from '../types';

export interface DeepSeekChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface DeepSeekRequestBody {
  model: string;
  messages: DeepSeekChatMessage[];
  stream: true;
  stream_options: { include_usage: true };
  thinking?: { type: 'enabled' | 'disabled' };
  reasoning_effort?: string;
  max_tokens?: number;
}

export interface BuildDeepSeekRequestParams {
  model: string;
  messages: ChatMessageInput[];
  systemPrompt?: string | null;
  options?: ChatOptions;
  capabilities: ModelCapabilities;
}

/**
 * 构造 DeepSeek Chat Completions 请求体。
 * - 默认开启流式 usage（stream_options.include_usage = true）。
 * - 思考模式通过 thinking.type 控制，强度通过 reasoning_effort 控制。
 * - 思考模式不支持 temperature 等采样参数，因此本应用不发送这些参数。
 * - 历史消息不重复回传 reasoning_content（未使用 tools，官方会忽略）。
 */
export function buildDeepSeekRequestBody(params: BuildDeepSeekRequestParams): DeepSeekRequestBody {
  const { model, messages, systemPrompt, options, capabilities } = params;
  const chatMessages: DeepSeekChatMessage[] = [];
  const system = systemPrompt?.trim();
  if (system) chatMessages.push({ role: 'system', content: system });

  for (const message of messages) {
    if (message.role === 'system') continue;
    const content = message.content.trim();
    if (!content) continue;
    chatMessages.push({ role: message.role, content });
  }

  const body: DeepSeekRequestBody = {
    model,
    messages: chatMessages,
    stream: true,
    stream_options: { include_usage: true },
  };

  const thinking = options?.thinking ?? 'default';
  if (capabilities.thinkingToggle && thinking === 'enabled') {
    body.thinking = { type: 'enabled' };
  } else if (capabilities.thinkingToggle && thinking === 'disabled') {
    body.thinking = { type: 'disabled' };
  }

  const thinkingEnabled = thinking !== 'disabled';
  if (capabilities.reasoningEffort && thinkingEnabled && options?.reasoningEffort) {
    body.reasoning_effort = options.reasoningEffort;
  }

  if (options?.maxOutputTokens && options.maxOutputTokens > 0) {
    body.max_tokens = Math.floor(options.maxOutputTokens);
  }
  return body;
}

export interface DeepSeekChunkDetail {
  textDelta?: string;
  reasoningDelta?: string;
  usage?: unknown;
  providerId?: string;
  finishReason?: string;
  error?: { message: string; code?: string };
}

/** 解析 DeepSeek Chat Completions 流式响应块。 */
export function parseDeepSeekChunk(payload: unknown): DeepSeekChunkDetail {
  if (!payload || typeof payload !== 'object') return {};
  const root = payload as Record<string, unknown>;
  const detail: DeepSeekChunkDetail = {};
  if (typeof root.id === 'string') detail.providerId = root.id;
  if (root.usage && typeof root.usage === 'object') detail.usage = root.usage;

  if (root.error && typeof root.error === 'object') {
    const error = root.error as Record<string, unknown>;
    detail.error = {
      message: typeof error.message === 'string' ? error.message : 'DeepSeek 返回错误',
      code: typeof error.code === 'string' ? error.code : undefined,
    };
    return detail;
  }

  const choices = Array.isArray(root.choices) ? root.choices : [];
  const choice = choices[0];
  if (choice && typeof choice === 'object') {
    const choiceRecord = choice as Record<string, unknown>;
    if (typeof choiceRecord.finish_reason === 'string') {
      detail.finishReason = choiceRecord.finish_reason;
    }
    const delta = choiceRecord.delta;
    if (delta && typeof delta === 'object') {
      const deltaRecord = delta as Record<string, unknown>;
      if (typeof deltaRecord.content === 'string' && deltaRecord.content.length > 0) {
        detail.textDelta = deltaRecord.content;
      }
      if (
        typeof deltaRecord.reasoning_content === 'string' &&
        deltaRecord.reasoning_content.length > 0
      ) {
        detail.reasoningDelta = deltaRecord.reasoning_content;
      }
    }
  }
  return detail;
}

export function normalizeDeepSeekResponseUsage(raw: unknown): UsageNormalization {
  return normalizeDeepSeekUsage(raw);
}
