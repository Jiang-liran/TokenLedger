import Decimal from 'decimal.js';
import { toDecimalString } from '../../shared/cost/engine';
import { ECB_SOURCE_URL } from '../../shared/settings';

export interface EcbRateResult {
  rate: string;
  effectiveAt: string;
  source: string;
  sourceUrl: string;
}

/**
 * 仅在用户点击“更新汇率”时调用。ECB 每日参考汇率是公开、可核对的官方数据源；
 * 不发送任何聊天内容或 API Key。
 */
export async function fetchEcbCnyUsd(signal?: AbortSignal): Promise<EcbRateResult> {
  const response = await fetch(ECB_SOURCE_URL, {
    method: 'GET',
    signal: signal ?? AbortSignal.timeout(15_000),
    headers: { Accept: 'application/xml' },
  });
  if (!response.ok) throw new Error(`ECB 汇率请求失败：HTTP ${response.status}`);
  const xml = await response.text();
  const timeMatch = /time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml);
  const cnyMatch = /currency=['"]CNY['"]\s+rate=['"]([0-9.]+)['"]/.exec(xml);
  const usdMatch = /currency=['"]USD['"]\s+rate=['"]([0-9.]+)['"]/.exec(xml);
  if (!cnyMatch || !usdMatch) throw new Error('ECB 汇率数据格式无法识别');
  const cnyPerEur = new Decimal(cnyMatch[1]);
  const usdPerEur = new Decimal(usdMatch[1]);
  if (!cnyPerEur.greaterThan(0) || !usdPerEur.greaterThan(0)) throw new Error('ECB 汇率数据无效');
  const rate = toDecimalString(usdPerEur.div(cnyPerEur));
  return {
    rate,
    effectiveAt: timeMatch?.[1] ?? new Date().toISOString().slice(0, 10),
    source: '欧洲中央银行（ECB）参考汇率折算（CNY→USD）',
    sourceUrl: ECB_SOURCE_URL,
  };
}
