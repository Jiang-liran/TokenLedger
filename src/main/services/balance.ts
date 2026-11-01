import type { DeepSeekBalanceResult } from '../../shared/types';
import type { KeyStore } from './secrets';
import { fetchDeepSeekBalance } from './transport';

export class BalanceService {
  constructor(private readonly secrets: KeyStore) {}

  async getDeepSeekBalance(): Promise<DeepSeekBalanceResult> {
    const fetchedAt = new Date().toISOString();
    const key = await this.secrets.getKey('deepseek');
    if (!key) {
      return { ok: false, fetchedAt, error: '尚未配置 DeepSeek API Key，请先在设置中填写。' };
    }
    try {
      const result = await fetchDeepSeekBalance(key);
      return {
        ok: true,
        fetchedAt,
        isAvailable: result.isAvailable,
        infos: result.infos,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : '查询余额失败，请稍后重试。';
      return { ok: false, fetchedAt, error: message };
    }
  }
}
