import { useEffect, useMemo, useState } from 'react';
import { Check, Search, Sparkles } from 'lucide-react';
import type { ProviderId } from '../../shared/types';
import { useAppStore } from '../store';
import { Popover } from './ui';

const PROVIDER_LABEL: Record<ProviderId, string> = {
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
};

export function ModelPicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const provider = useAppStore((state) => state.provider);
  const model = useAppStore((state) => state.model);
  const options = useAppStore((state) => state.options);
  const modelsByProvider = useAppStore((state) => state.modelsByProvider);
  const pricing = useAppStore((state) => state.pricing);
  const setProvider = useAppStore((state) => state.setProvider);
  const setModel = useAppStore((state) => state.setModel);
  const setOptions = useAppStore((state) => state.setOptions);
  const loadModels = useAppStore((state) => state.loadModels);
  const modelsLoading = useAppStore((state) => state.modelsLoading);
  const [query, setQuery] = useState('');
  const [manual, setManual] = useState('');

  useEffect(() => {
    if (open && !modelsByProvider[provider]) void loadModels(provider);
  }, [open, provider, modelsByProvider, loadModels]);

  const result = modelsByProvider[provider];
  const models = useMemo(() => {
    const list = result?.models ?? [];
    const q = query.trim().toLowerCase();
    return q
      ? list.filter(
          (item) =>
            item.id.toLowerCase().includes(q) || item.displayName.toLowerCase().includes(q),
        )
      : list;
  }, [result, query]);

  const selectedInfo = result?.models.find((item) => item.id === model);
  const pricingEntry = pricing?.models.find(
    (item) => item.provider === provider && item.model === model,
  );
  const caps = pricingEntry?.capabilities ?? {
    reasoningEffort: selectedInfo?.reasoningEffort ?? false,
    thinkingToggle: selectedInfo?.thinkingToggle ?? false,
  };

  return (
    <Popover open={open} onClose={onClose} align="left" width={360}>
      <div className="popover-header">
        <span>选择模型</span>
        <span className="hint">{modelsLoading ? '读取中…' : `${models.length} 个可用`}</span>
      </div>

      <div className="range-tabs" style={{ margin: '0 6px 8px', display: 'flex' }}>
        {(['openai', 'deepseek'] as ProviderId[]).map((item) => (
          <button
            key={item}
            className={`range-tab flex-1 ${provider === item ? 'active' : ''}`}
            onClick={() => void setProvider(item)}
          >
            {PROVIDER_LABEL[item]}
          </button>
        ))}
      </div>

      <div className="search-box" style={{ margin: '0 6px 6px' }}>
        <Search size={13} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索模型"
          aria-label="搜索模型"
          autoFocus
        />
      </div>

      <div style={{ maxHeight: 250, overflowY: 'auto', padding: '0 2px' }}>
        {models.length === 0 ? (
          <p className="hint" style={{ padding: '10px 8px' }}>
            没有匹配的模型。可在下方手动输入模型 ID。
          </p>
        ) : (
          models.map((item) => (
            <button
              key={item.id}
              className="menu-item"
              style={{
                alignItems: 'flex-start',
                gap: 8,
                background: item.id === model ? 'var(--accent-soft)' : undefined,
              }}
              onClick={() => {
                setModel(item.id);
                onClose();
              }}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-medium">{item.displayName}</span>
                <span className="mono block truncate" style={{ color: 'var(--text-tertiary)' }}>
                  {item.id}
                  {!item.hasPricing ? ' · 费用未知' : ''}
                </span>
              </span>
              {item.reasoningEffort ? (
                <Sparkles size={12} style={{ marginTop: 3, color: 'var(--text-tertiary)' }} />
              ) : null}
              {item.id === model ? <Check size={13} style={{ marginTop: 3 }} /> : null}
            </button>
          ))
        )}
      </div>

      {result?.warning ? (
        <p className="hint" style={{ padding: '6px 8px 2px' }}>
          {result.warning}
        </p>
      ) : null}

      <div className="menu-sep" />

      <div style={{ padding: '0 6px 4px' }}>
        <div className="label" style={{ marginBottom: 4 }}>
          手动输入模型 ID
        </div>
        <div className="flex gap-1.5">
          <input
            className="input"
            value={manual}
            onChange={(event) => setManual(event.target.value)}
            placeholder="例如 gpt-6.1-sol"
            onKeyDown={(event) => {
              if (event.key === 'Enter' && manual.trim()) {
                setModel(manual.trim());
                setManual('');
                onClose();
              }
            }}
          />
          <button
            className="btn btn-sm"
            disabled={!manual.trim()}
            onClick={() => {
              setModel(manual.trim());
              setManual('');
              onClose();
            }}
          >
            使用
          </button>
        </div>
        <p className="hint" style={{ marginTop: 4 }}>
          未配置价格的模型仍可聊天，但费用会标记为未知，不会按免费处理。
        </p>
      </div>

      {caps.reasoningEffort || caps.thinkingToggle ? (
        <>
          <div className="menu-sep" />
          <div style={{ padding: '4px 8px 8px' }}>
            <div className="label" style={{ marginBottom: 6 }}>
              生成设置
            </div>
            {caps.reasoningEffort ? (
              <label className="flex items-center justify-between gap-2 py-1 text-[12px]">
                <span style={{ color: 'var(--text-secondary)' }}>推理强度</span>
                <select
                  className="select"
                  style={{ width: 120 }}
                  value={options.reasoningEffort ?? ''}
                  onChange={(event) =>
                    setOptions({
                      reasoningEffort:
                        event.target.value === ''
                          ? null
                          : (event.target.value as 'low' | 'medium' | 'high' | 'max'),
                    })
                  }
                >
                  <option value="">默认</option>
                  <option value="low">低</option>
                  <option value="medium">中</option>
                  <option value="high">高</option>
                  {provider === 'deepseek' ? <option value="max">最高</option> : null}
                </select>
              </label>
            ) : null}
            {caps.thinkingToggle ? (
              <label className="flex items-center justify-between gap-2 py-1 text-[12px]">
                <span style={{ color: 'var(--text-secondary)' }}>思考模式</span>
                <select
                  className="select"
                  style={{ width: 120 }}
                  value={options.thinking ?? 'default'}
                  onChange={(event) =>
                    setOptions({
                      thinking: event.target.value as 'default' | 'enabled' | 'disabled',
                    })
                  }
                >
                  <option value="default">默认</option>
                  <option value="enabled">开启</option>
                  <option value="disabled">关闭</option>
                </select>
              </label>
            ) : null}
            <p className="hint" style={{ marginTop: 4 }}>
              思考内容与最终回答分开显示，推理 Token 已包含在输出 Token 中，不重复计费。
            </p>
          </div>
        </>
      ) : null}
    </Popover>
  );
}
