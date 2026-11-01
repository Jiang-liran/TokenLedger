import type { ProviderId } from '../types';

export interface FriendlyError {
  code: string;
  message: string;
  detail?: string;
}

function extractMessage(bodyText: string): string | undefined {
  const text = bodyText.trim();
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: string; code?: string; type?: string };
      message?: string;
      detail?: string;
      code?: string;
    };
    const fromError = parsed.error?.message;
    const code = parsed.error?.code ?? parsed.code;
    const base = fromError ?? parsed.message ?? parsed.detail;
    if (base && code) return `${base}（${code}）`;
    return base;
  } catch {
    // 非 JSON：截断 HTML / 纯文本，避免把整页 HTML 塞进界面。
    const singleLine = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return singleLine.slice(0, 300) || undefined;
  }
}

export function describeHttpFailure(
  provider: ProviderId,
  status: number,
  bodyText: string,
  model: string,
  retryAfter?: string | null,
): FriendlyError {
  const detail = extractMessage(bodyText);
  const providerName = provider === 'openai' ? 'OpenAI' : 'DeepSeek';
  const suffix = detail ? ` 服务商返回：${detail}` : '';

  if (status === 401) {
    return {
      code: 'invalid_api_key',
      message: `${providerName} API Key 无效或已失效，请在设置中重新填写并测试连接。${suffix}`,
      detail,
    };
  }
  if (status === 402) {
    return {
      code: 'insufficient_balance',
      message: `${providerName} 账户余额不足，请前往官方控制台充值后重试。${suffix}`,
      detail,
    };
  }
  if (status === 403) {
    return {
      code: 'forbidden',
      message: `${providerName} 拒绝访问（403）。可能是密钥权限不足、所在地区不支持或账户受限。${suffix}`,
      detail,
    };
  }
  if (status === 404) {
    return {
      code: 'model_not_found',
      message: `模型「${model}」不存在或当前 API Key 无权使用。请在顶部切换可用模型，或手动输入正确的模型 ID。${suffix}`,
      detail,
    };
  }
  if (status === 413) {
    return {
      code: 'payload_too_large',
      message: '请求内容过长，超出服务商限制。请缩短消息或新建会话后重试。',
      detail,
    };
  }
  if (status === 429) {
    const lower = bodyText.toLowerCase();
    const quota = lower.includes('quota') || lower.includes('insufficient');
    return {
      code: quota ? 'quota_exhausted' : 'rate_limited',
      message: quota
        ? `${providerName} 账户额度已用尽。请检查官方账单或充值后重试。${suffix}`
        : `${providerName} 请求过于频繁或触发限速（429）。${retryAfter ? `建议 ${retryAfter} 秒后重试。` : '请稍后再试。'}${suffix}`,
      detail,
    };
  }
  if (status === 400 || status === 422) {
    const lower = bodyText.toLowerCase();
    const unsupported =
      lower.includes('unsupported') ||
      lower.includes('not supported') ||
      lower.includes('unknown parameter') ||
      lower.includes('unrecognized');
    return {
      code: unsupported ? 'unsupported_parameter' : 'invalid_request',
      message: unsupported
        ? `模型「${model}」不支持请求中的某个参数，或该模型不支持此类聊天。请更换模型后重试。${suffix}`
        : `请求参数被服务商拒绝（HTTP ${status}）。${suffix}`,
      detail,
    };
  }
  if (status === 408) {
    return { code: 'request_timeout', message: '服务商处理超时。请稍后重试。', detail };
  }
  if (status >= 500) {
    return {
      code: 'server_error',
      message: `${providerName} 服务暂时不可用（HTTP ${status}）。请稍后重试；本次请求可能已在服务端产生用量，已保留记录。${suffix}`,
      detail,
    };
  }
  return {
    code: 'api_error',
    message: `${providerName} 请求失败（HTTP ${status}）。${suffix}`,
    detail,
  };
}

export function describeNetworkFailure(error: unknown): FriendlyError {
  const err = error as { name?: string; message?: string; cause?: { code?: string } };
  const name = err?.name ?? '';
  const code = err?.cause?.code ?? '';
  const message = err?.message ?? String(error);
  if (name === 'AbortError') {
    return { code: 'aborted', message: '已停止生成。' };
  }
  if (name === 'TimeoutError' || /timeout/i.test(message)) {
    return { code: 'timeout', message: '请求超时，网络或服务商响应过慢。请重试。', detail: message };
  }
  if (
    /ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT|EPIPE|UND_ERR/i.test(code) ||
    /fetch failed|network|socket|TLS|certificate/i.test(message)
  ) {
    return {
      code: 'network_error',
      message: '网络连接失败，请检查网络、代理或防火墙设置。',
      detail: message,
    };
  }
  return { code: 'network_error', message: '网络请求失败。', detail: message };
}

export function isAbortError(error: unknown): boolean {
  const err = error as { name?: string; code?: string };
  return err?.name === 'AbortError' || err?.code === 'ABORT_ERR';
}
