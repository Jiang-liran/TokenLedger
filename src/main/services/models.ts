import type { ModelInfo, ModelListResult, ProviderId } from '../../shared/types';
import type { KeyStore } from './secrets';
import type { PricingService } from './pricing';
import {
  getBuiltinModels,
  inferCapabilities,
  isLikelyTextChatModel,
} from '../../shared/pricing/catalog';
import { fetchProviderModels } from './transport';

export class ModelsService {
  private readonly cache = new Map<ProviderId, { ids: string[]; fetchedAt: number }>();

  constructor(
    private readonly secrets: KeyStore,
    private readonly pricing: PricingService,
  ) {}

  private builtin(provider: ProviderId): ModelInfo[] {
    const catalog = this.pricing.getCatalog();
    const entries = getBuiltinModels(provider).map((pricing) => {
      const current = catalog.find(
        (item) => item.provider === pricing.provider && item.model === pricing.model,
      );
      return {
        id: pricing.model,
        displayName: current?.displayName ?? pricing.displayName,
        provider,
        hasPricing: true,
        reasoningEffort: (current ?? pricing).capabilities.reasoningEffort,
        thinkingToggle: (current ?? pricing).capabilities.thinkingToggle,
        source: 'builtin' as const,
      };
    });
    return entries;
  }

  private toModelInfo(provider: ProviderId, id: string): ModelInfo {
    const pricing = this.pricing.getPricingForModel(provider, id);
    const caps = pricing?.capabilities ?? inferCapabilities(provider, id);
    return {
      id,
      displayName: pricing?.displayName ?? id,
      provider,
      hasPricing: !!pricing,
      reasoningEffort: caps.reasoningEffort,
      thinkingToggle: caps.thinkingToggle,
      source: pricing ? 'builtin' : 'api',
    };
  }

  builtinList(provider: ProviderId): ModelListResult {
    return {
      models: this.builtin(provider),
      source: 'builtin',
      warning: '测试模式：显示内置模型列表，不访问官方接口。',
    };
  }

  async list(provider: ProviderId, refresh = false): Promise<ModelListResult> {
    const builtin = this.builtin(provider);
    const key = await this.secrets.getKey(provider);
    if (!key) {
      return {
        models: builtin,
        source: 'builtin',
        warning: '尚未配置 API Key，显示内置模型列表；仍可在模型选择器中手动输入模型 ID。',
      };
    }

    const cached = this.cache.get(provider);
    const cacheValid = cached && Date.now() - cached.fetchedAt < 5 * 60_000;
    if (cacheValid && !refresh) {
      return this.merge(provider, builtin, cached.ids, '取自官方模型接口（缓存 5 分钟）');
    }

    try {
      const { ids } = await fetchProviderModels(provider, key);
      const filtered =
        provider === 'openai' ? ids.filter((id) => isLikelyTextChatModel(id)) : ids;
      this.cache.set(provider, { ids: filtered, fetchedAt: Date.now() });
      return this.merge(provider, builtin, filtered);
    } catch (error) {
      const message = error instanceof Error ? error.message : '读取模型列表失败';
      return {
        models: builtin,
        source: 'builtin',
        warning: `读取官方模型列表失败，已显示内置列表。${message}`,
      };
    }
  }

  private merge(
    provider: ProviderId,
    builtin: ModelInfo[],
    apiIds: string[],
    note?: string,
  ): ModelListResult {
    const map = new Map<string, ModelInfo>();
    for (const model of builtin) map.set(model.id, model);
    for (const id of apiIds) {
      if (!map.has(id)) {
        const info = this.toModelInfo(provider, id);
        map.set(id, { ...info, source: 'api' });
      }
    }
    const models = [...map.values()];
    return {
      models,
      source: 'api',
      warning: note,
    };
  }

  async refreshKnownModels(): Promise<void> {
    this.cache.clear();
  }
}
