import { describe, expect, it } from 'vitest';
import {
  describeHttpFailure,
  describeNetworkFailure,
  isAbortError,
} from '../src/shared/providers/errors';
import { redact } from '../src/main/services/logger';

describe('API 错误映射', () => {
  it('401 提示密钥无效', () => {
    const error = describeHttpFailure('openai', 401, '{"error":{"message":"Incorrect API key"}}', 'gpt-6.1-sol');
    expect(error.code).toBe('invalid_api_key');
    expect(error.message).toContain('API Key 无效');
  });

  it('402 提示余额不足', () => {
    const error = describeHttpFailure(
      'deepseek',
      402,
      '{"error":{"message":"Insufficient Balance"}}',
      'deepseek-flash',
    );
    expect(error.code).toBe('insufficient_balance');
    expect(error.message).toContain('余额不足');
  });

  it('404 提示模型不存在并包含模型 ID', () => {
    const error = describeHttpFailure('openai', 404, '{}', 'gpt-unknown');
    expect(error.code).toBe('model_not_found');
    expect(error.message).toContain('gpt-unknown');
  });

  it('400 中不支持参数的错误被识别', () => {
    const error = describeHttpFailure(
      'deepseek',
      400,
      '{"error":{"message":"Unsupported parameter: temperature"}}',
      'deepseek-flash',
    );
    expect(error.code).toBe('unsupported_parameter');
    expect(error.message).toContain('不支持');
  });

  it('429 区分限速与额度用尽，并包含重试时间', () => {
    const rate = describeHttpFailure('openai', 429, '{}', 'gpt-6.1-sol', '12');
    expect(rate.code).toBe('rate_limited');
    expect(rate.message).toContain('12 秒');
    const quota = describeHttpFailure(
      'openai',
      429,
      '{"error":{"code":"insufficient_quota"}}',
      'gpt-6.1-sol',
    );
    expect(quota.code).toBe('quota_exhausted');
  });

  it('5xx 提示服务端暂时不可用', () => {
    const error = describeHttpFailure('deepseek', 503, 'Service Unavailable', 'deepseek-flash');
    expect(error.code).toBe('server_error');
    expect(error.message).toContain('暂时不可用');
  });

  it('HTML 错误页被清理为可读文本', () => {
    const error = describeHttpFailure('openai', 500, '<html><body><h1>Bad Gateway</h1></body></html>', 'm');
    expect(error.detail).toBe('Bad Gateway');
  });
});

describe('网络错误映射', () => {
  it('区分超时与断网', () => {
    const timeout = new Error('request timed out');
    timeout.name = 'TimeoutError';
    expect(describeNetworkFailure(timeout).code).toBe('timeout');
    expect(describeNetworkFailure(new Error('fetch failed')).code).toBe('network_error');
  });

  it('AbortError 被识别', () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    expect(isAbortError(error)).toBe(true);
    expect(isAbortError(new Error('other'))).toBe(false);
  });
});

describe('日志脱敏', () => {
  it('不会输出 API Key 与 Bearer 头', () => {
    // 在运行时拼接，避免在公开源码中留下看似真实的密钥字面量。
    const bearerLike = ['sk', 'abcdef1234567890'].join('-');
    const projectLike = ['sk', 'proj', 'secret-key-123'].join('-');
    const apiKeyLike = ['another', 'secret', '123'].join('-');
    const message = redact(
      `Authorization: Bearer ${bearerLike} and key ${projectLike} and "api_key": "${apiKeyLike}"`,
    );
    expect(message).not.toContain(bearerLike);
    expect(message).not.toContain(projectLike);
    expect(message).not.toContain(apiKeyLike);
    expect(message).toContain('***');
  });
});
