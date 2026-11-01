import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  HardDrive,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Shield,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { Currency, ModelPricing, ProviderId } from '../../shared/types';
import type { PriceOverrideRow as OverrideRow } from '../../shared/ipc';
import type { AppSettings as Settings } from '../../shared/settings';
import { currencySymbol, formatDateTime } from '../../shared/cost/format';
import { useAppStore } from '../store';
import { Field, Modal, Switch } from './ui';

const PROVIDERS: ProviderId[] = ['openai', 'deepseek'];
const PROVIDER_LABEL: Record<ProviderId, string> = { openai: 'OpenAI', deepseek: 'DeepSeek' };

function priceCell(value: string | null, currency: Currency): string {
  if (value === null) return '—';
  return `${currencySymbol(currency)}${value}`;
}

function emptyOverride(provider: ProviderId, model: string): OverrideRow {
  return {
    provider,
    model,
    inputPerM: null,
    cachedInputPerM: null,
    cacheWrite30mPerM: null,
    cacheWrite12hPerM: null,
    outputPerM: null,
    offPeakInputPerM: null,
    offPeakCachedInputPerM: null,
    offPeakOutputPerM: null,
    currency: provider === 'openai' ? 'USD' : 'CNY',
    sourceUrl: null,
    effectiveFrom: new Date().toISOString().slice(0, 10),
    notes: null,
    createdAt: new Date().toISOString(),
  };
}

export function SettingsPage() {
  const settings = useAppStore((state) => state.settings);
  const meta = useAppStore((state) => state.meta);
  const keyStatus = useAppStore((state) => state.keyStatus);
  const pricing = useAppStore((state) => state.pricing);
  const holidays = useAppStore((state) => state.holidays);
  const modelsByProvider = useAppStore((state) => state.modelsByProvider);
  const keyTestResult = useAppStore((state) => state.keyTestResult);
  const saveKey = useAppStore((state) => state.saveKey);
  const saveSessionKey = useAppStore((state) => state.saveSessionKey);
  const deleteKeyAction = useAppStore((state) => state.deleteKeyAction);
  const testKeyAction = useAppStore((state) => state.testKeyAction);
  const saveSettings = useAppStore((state) => state.saveSettings);
  const setPriceOverride = useAppStore((state) => state.setPriceOverride);
  const resetPriceOverride = useAppStore((state) => state.resetPriceOverride);
  const recalculateCosts = useAppStore((state) => state.recalculateCosts);
  const refreshFx = useAppStore((state) => state.refreshFx);
  const saveFx = useAppStore((state) => state.saveFx);
  const saveHolidays = useAppStore((state) => state.saveHolidays);
  const createBackup = useAppStore((state) => state.createBackup);
  const restoreBackup = useAppStore((state) => state.restoreBackup);
  const deleteAllData = useAppStore((state) => state.deleteAllData);
  const askConfirm = useAppStore((state) => state.askConfirm);
  const openExternal = useAppStore((state) => state.openExternal);

  const [draft, setDraft] = useState<Settings | null>(settings);
  const [keyInputs, setKeyInputs] = useState<Record<ProviderId, string>>({ openai: '', deepseek: '' });
  const [keyVisible, setKeyVisible] = useState<Record<ProviderId, boolean>>({ openai: false, deepseek: false });
  const [fxRate, setFxRate] = useState('');
  const [fxSource, setFxSource] = useState('');
  const [holidayCoverageEnd, setHolidayCoverageEnd] = useState('');
  const [holidayOverrides, setHolidayOverrides] = useState<
    { date: string; name: string; action: 'add' | 'remove' }[]
  >([]);
  const [newHolidayDate, setNewHolidayDate] = useState('');
  const [newHolidayName, setNewHolidayName] = useState('');
  const [newHolidayAction, setNewHolidayAction] = useState<'add' | 'remove'>('add');
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [editingPrice, setEditingPrice] = useState<ModelPricing | null>(null);
  const [priceForm, setPriceForm] = useState<OverrideRow | null>(null);

  useEffect(() => setDraft(settings), [settings]);

  useEffect(() => {
    if (pricing) {
      setFxRate(pricing.fx.rate);
      setFxSource(pricing.fx.source);
    }
  }, [pricing]);

  useEffect(() => {
    if (holidays) {
      setHolidayCoverageEnd(holidays.coverageEnd);
      setHolidayOverrides(holidays.overrides);
    }
  }, [holidays]);

  const overrideByModel = useMemo(() => {
    const map = new Map<string, OverrideRow>();
    for (const override of pricing?.overrides ?? []) {
      map.set(`${override.provider}:${override.model}`, override);
    }
    return map;
  }, [pricing]);

  if (!draft) {
    return (
      <div className="page">
        <div className="page-header">
          <h1 className="page-title">设置</h1>
        </div>
        <div className="page-scroll">
          <div className="page-body hint">正在读取设置…</div>
        </div>
      </div>
    );
  }

  const update = (patch: Partial<Settings>) => setDraft({ ...draft, ...patch });
  const persist = (next: Settings) => {
    setDraft(next);
    void saveSettings(next);
  };

  const secure = keyStatus?.secureStorageAvailable ?? false;

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-title">设置</h1>
        <span className="hint">所有数据保存在本机</span>
        <div className="ml-auto flex items-center gap-2 text-[11px] text-[var(--text-tertiary)]">
          <Shield size={12} /> {meta?.storageBackend ?? ''}
        </div>
      </header>

      <div className="page-scroll">
        <div className="settings-wrap">
          {/* ---------------------------------------------------------- keys */}
          <section className="settings-section">
            <div className="settings-header">
              <div>
                <h2 className="settings-title">API Key</h2>
                <p className="settings-sub">
                  两家服务商独立保存。密钥使用 macOS 钥匙串加密，仅保存在本机，绝不写入数据库、日志或备份。
                </p>
              </div>
            </div>

            {!secure ? (
              <div className="warn-banner" style={{ marginBottom: 12 }}>
                <AlertTriangle size={13} className="mt-0.5 flex-none" />
                <span>
                  系统安全存储当前不可用（钥匙串被锁定或拒绝访问），应用不会把 Key 明文写入磁盘。
                  你可以解锁钥匙串后重启应用，或使用下方的“仅本次运行”模式：Key 只保存在主进程内存中，退出即失效。
                </span>
              </div>
            ) : null}

            {PROVIDERS.map((provider) => {
              const status = keyStatus?.[provider];
              const test = keyTestResult[provider];
              return (
                <div key={provider} style={{ padding: '12px 0', borderTop: '1px solid var(--border)' }}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`status-dot ${status?.configured ? 'ok' : 'off'}`} />
                    <span className="text-[12.5px] font-semibold">{PROVIDER_LABEL[provider]}</span>
                    <span className="hint">
                      {status?.configured
                        ? status.storage === 'session'
                          ? '已配置 · 仅本次运行（内存）'
                          : `已配置 · 更新于 ${formatDateTime(status.updatedAt)}`
                        : '未配置'}
                    </span>
                    {status?.configured ? (
                      <button
                        className="btn btn-sm ml-auto"
                        onClick={async () => {
                          const confirmed = await askConfirm({
                            title: `删除 ${PROVIDER_LABEL[provider]} API Key？`,
                            message: '删除后将无法使用该服务商发送消息，直到重新配置。',
                            confirmLabel: '删除',
                            danger: true,
                          });
                          if (confirmed) await deleteKeyAction(provider);
                        }}
                      >
                        <Trash2 size={11} /> 删除
                      </button>
                    ) : null}
                    <button
                      className="btn btn-sm"
                      disabled={!status?.configured}
                      onClick={() => void testKeyAction(provider)}
                    >
                      <RefreshCw size={11} /> 测试连接
                    </button>
                  </div>

                  <div className="key-row mt-2">
                    <div className="relative flex-1" style={{ minWidth: 240 }}>
                      <input
                        className="input"
                        type={keyVisible[provider] ? 'text' : 'password'}
                        value={keyInputs[provider]}
                        onChange={(event) =>
                          setKeyInputs((current) => ({ ...current, [provider]: event.target.value }))
                        }
                        placeholder={status?.configured ? '输入新 Key 以更换（不会显示已保存的 Key）' : `粘贴 ${PROVIDER_LABEL[provider]} API Key`}
                        autoComplete="off"
                        spellCheck={false}
                        data-testid={`key-input-${provider}`}
                      />
                      <button
                        className="icon-btn absolute right-1 top-1/2 -translate-y-1/2"
                        onClick={() =>
                          setKeyVisible((current) => ({ ...current, [provider]: !current[provider] }))
                        }
                        aria-label={keyVisible[provider] ? '隐藏密钥' : '显示密钥'}
                        type="button"
                      >
                        {keyVisible[provider] ? <EyeOff size={13} /> : <Eye size={13} />}
                      </button>
                    </div>
                    <button
                      className="btn btn-primary"
                      disabled={!keyInputs[provider].trim() || !secure}
                      onClick={async () => {
                        const ok = await saveKey(provider, keyInputs[provider].trim());
                        if (ok) setKeyInputs((current) => ({ ...current, [provider]: '' }));
                      }}
                    >
                      <KeyRound size={12} /> 保存
                    </button>
                    {!secure ? (
                      <button
                        className="btn"
                        disabled={!keyInputs[provider].trim()}
                        onClick={async () => {
                          const ok = await saveSessionKey(provider, keyInputs[provider].trim());
                          if (ok) setKeyInputs((current) => ({ ...current, [provider]: '' }));
                        }}
                        title="只保存在内存中，退出应用后失效"
                      >
                        仅本次运行
                      </button>
                    ) : null}
                    <button className="btn" onClick={() => void testKeyAction(provider)} disabled={!status?.configured}>
                      测试
                    </button>
                  </div>

                  {test ? (
                    <p className={`hint ${test.ok ? '' : 'hint-warn'}`} style={{ marginTop: 6 }}>
                      {test.ok ? <Check size={11} className="mr-1 inline" /> : null}
                      {test.message}（{formatDateTime(test.at)}）
                    </p>
                  ) : null}
                </div>
              );
            })}

            <p className="hint" style={{ marginTop: 10 }}>
              OpenAI 普通 API Key 不提供实时余额查询；DeepSeek 余额可在侧边栏“DeepSeek 余额”中查询。
            </p>
          </section>

          {/* ------------------------------------------------------ defaults */}
          <section className="settings-section">
            <div className="settings-header">
              <div>
                <h2 className="settings-title">默认模型与生成参数</h2>
                <p className="settings-sub">用于新建会话的默认值；会话内可随时切换服务商与模型。</p>
              </div>
              <button className="btn btn-sm" onClick={() => persist(draft)}>
                <Save size={11} /> 保存
              </button>
            </div>

            <div className="form-grid">
              <Field label="默认服务商">
                <select
                  className="select"
                  value={draft.defaultProvider}
                  onChange={(event) =>
                    update({ defaultProvider: event.target.value as ProviderId })
                  }
                >
                  <option value="openai">OpenAI</option>
                  <option value="deepseek">DeepSeek</option>
                </select>
              </Field>
              <Field label="显示思考过程" hint="仅影响展示，不改变请求或计费。">
                <div className="flex h-[30px] items-center">
                  <Switch
                    checked={draft.showReasoning}
                    onChange={(checked) => update({ showReasoning: checked })}
                    label="显示思考过程"
                  />
                </div>
              </Field>
            </div>

            <div className="mt-3 grid grid-cols-1 gap-3">
              {PROVIDERS.map((provider) => (
                <div key={provider} className="rounded-lg border border-[var(--border)] p-3">
                  <div className="mb-2 text-[12px] font-semibold">{PROVIDER_LABEL[provider]} 默认</div>
                  <div className="form-grid-4">
                    <Field label="模型 ID">
                      <input
                        className="input"
                        list={`models-${provider}`}
                        value={draft.models[provider].model}
                        onChange={(event) =>
                          update({
                            models: {
                              ...draft.models,
                              [provider]: { ...draft.models[provider], model: event.target.value },
                            },
                          })
                        }
                      />
                      <datalist id={`models-${provider}`}>
                        {(modelsByProvider[provider]?.models ?? []).map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.displayName}
                          </option>
                        ))}
                      </datalist>
                    </Field>
                    <Field label="推理强度">
                      <select
                        className="select"
                        value={draft.models[provider].reasoningEffort ?? ''}
                        onChange={(event) =>
                          update({
                            models: {
                              ...draft.models,
                              [provider]: {
                                ...draft.models[provider],
                                reasoningEffort:
                                  event.target.value === ''
                                    ? null
                                    : (event.target.value as 'low' | 'medium' | 'high' | 'max'),
                              },
                            },
                          })
                        }
                      >
                        <option value="">默认</option>
                        <option value="low">低</option>
                        <option value="medium">中</option>
                        <option value="high">高</option>
                        {provider === 'deepseek' ? <option value="max">最高</option> : null}
                      </select>
                    </Field>
                    {provider === 'deepseek' ? (
                      <Field label="思考模式">
                        <select
                          className="select"
                          value={draft.models.deepseek.thinking}
                          onChange={(event) =>
                            update({
                              models: {
                                ...draft.models,
                                deepseek: {
                                  ...draft.models.deepseek,
                                  thinking: event.target.value as 'default' | 'enabled' | 'disabled',
                                },
                              },
                            })
                          }
                        >
                          <option value="default">默认</option>
                          <option value="enabled">开启</option>
                          <option value="disabled">关闭</option>
                        </select>
                      </Field>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>

            <div className="form-grid mt-3">
              <Field label="发送给模型的最大历史消息数" hint="越大上下文越完整，但每次请求的输入 Token 也越多。">
                <input
                  className="input"
                  type="number"
                  min={2}
                  max={1000}
                  value={draft.maxContextMessages}
                  onChange={(event) =>
                    update({ maxContextMessages: Number(event.target.value) || draft.maxContextMessages })
                  }
                />
              </Field>
              <Field label="历史文本字符上限" hint="超过后从最旧的消息开始截断，最新消息始终保留。">
                <input
                  className="input"
                  type="number"
                  min={4000}
                  max={2_000_000}
                  step={1000}
                  value={draft.maxContextChars}
                  onChange={(event) =>
                    update({ maxContextChars: Number(event.target.value) || draft.maxContextChars })
                  }
                />
              </Field>
            </div>
          </section>

          {/* ------------------------------------------------------ pricing */}
          <section className="settings-section">
            <div className="settings-header">
              <div>
                <h2 className="settings-title">费用与汇率</h2>
                <p className="settings-sub">
                  价格以官方页面为准，每次请求会保存当时的价格快照；未来调价不会改变历史费用。
                </p>
              </div>
              <button
                className="btn btn-sm"
                onClick={() => void openExternal('https://developers.openai.com/api/docs/pricing')}
              >
                <ExternalLink size={11} /> 官方价格
              </button>
            </div>

            <div className="form-grid">
              <Field label="USD 折算汇率（1 CNY = ? USD）" hint={`来源：${pricing?.fx.source ?? '—'} · 生效 ${pricing?.fx.effectiveAt ?? '—'}`}>
                <div className="flex gap-2">
                  <input
                    className="input"
                    value={fxRate}
                    onChange={(event) => setFxRate(event.target.value)}
                    inputMode="decimal"
                  />
                  <button
                    className="btn"
                    onClick={() => void saveFx(fxRate.trim(), fxSource.trim() || '用户配置的汇率')}
                    disabled={!fxRate.trim()}
                  >
                    保存
                  </button>
                </div>
              </Field>
              <Field label="汇率来源说明" hint="美元金额仅用于展示，不代表服务商美元扣款。">
                <div className="flex gap-2">
                  <input
                    className="input"
                    value={fxSource}
                    onChange={(event) => setFxSource(event.target.value)}
                  />
                  <button className="btn" onClick={() => void refreshFx()}>
                    <RefreshCw size={11} /> ECB
                  </button>
                </div>
              </Field>
            </div>

            {pricing?.fx.stale ? (
              <div className="warn-banner" style={{ marginTop: 10 }}>
                <AlertTriangle size={13} className="mt-0.5 flex-none" />
                <span>
                  当前汇率基于 {pricing.fx.effectiveAt} 的参考值，已超过 30 天。请更新汇率或确认继续使用。
                </span>
              </div>
            ) : null}

            <hr className="divider" />

            <div className="flex items-center justify-between">
              <div>
                <div className="section-title">模型价格表</div>
                <div className="section-sub">单位：每百万 Token；显示价格为请求时会采用的标准档位。</div>
              </div>
              <span className="hint">
                版本 {pricing?.versions.openai ?? '—'} / {pricing?.versions.deepseek ?? '—'} · 核对于{' '}
                {pricing?.versions.verifiedAt ?? '—'}
              </span>
            </div>

            {pricing?.models
              .slice()
              .sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model))
              .map((model) => {
                const override = overrideByModel.get(`${model.provider}:${model.model}`);
                return (
                  <div
                    key={`${model.provider}:${model.model}`}
                    className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] py-2 text-[11.5px]"
                  >
                    <span className="w-[150px] shrink-0 truncate font-medium" title={model.displayName}>
                      {model.displayName}
                    </span>
                    <span className="hint w-[84px] shrink-0 truncate">{PROVIDER_LABEL[model.provider]}</span>
                    <span className="min-w-[190px] flex-1 tabular-nums text-[var(--text-secondary)]" title="输入 / 缓存读取 / 输出（每百万 Token）">
                      {priceCell(model.standard.inputPerM, model.currency)} /{' '}
                      {priceCell(model.standard.cachedInputPerM, model.currency)} /{' '}
                      {priceCell(model.standard.outputPerM, model.currency)}
                      {model.offPeak ? ' · 有低谷价' : ''}
                    </span>
                    {override ? <span className="badge">已覆盖</span> : null}
                    <span className="mono text-[var(--text-tertiary)]">{model.pricingVersion}</span>
                    <button
                      className="btn btn-sm ml-auto"
                      onClick={() => {
                        setEditingPrice(model);
                        setPriceForm(
                          override ?? {
                            ...emptyOverride(model.provider, model.model),
                            inputPerM: model.standard.inputPerM,
                            cachedInputPerM: model.standard.cachedInputPerM,
                            cacheWrite30mPerM: model.standard.cacheWrite30mPerM,
                            cacheWrite12hPerM: model.standard.cacheWrite12hPerM,
                            outputPerM: model.standard.outputPerM,
                            currency: model.currency,
                          },
                        );
                      }}
                    >
                      <Pencil size={11} /> 覆盖
                    </button>
                    {override ? (
                      <button
                        className="btn btn-sm"
                        onClick={() => void resetPriceOverride(model.provider, model.model)}
                        title="恢复内置价格"
                      >
                        <RotateCcw size={11} />
                      </button>
                    ) : null}
                  </div>
                );
              })}

            <p className="hint" style={{ marginTop: 8 }}>
              未列出价格的模型仍可聊天，但费用会标记为“未知”，不会被当作免费。添加覆盖价格仅影响之后的新请求。
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                className="btn btn-sm"
                onClick={async () => {
                  const confirmed = await askConfirm({
                    title: '重新核算历史费用？',
                    message:
                      '将使用当前价格配置，按每个请求的原始时间重新解析峰谷档位并计算费用。原始快照与旧费用会保留在核算日志中，可在需要时追溯。',
                    detail:
                      '这是一项高精度但有代价的操作：所有历史请求都会生成新的价格快照。已产生且无法计价的请求会被标记为“费用未知”。',
                    confirmLabel: '开始重算',
                    danger: false,
                  });
                  if (confirmed) await recalculateCosts();
                }}
              >
                <RotateCcw size={11} /> 按当前价格重新核算历史费用
              </button>
              <span className="hint">仅在官方调价或修正价格后使用；不会改变官方 usage 记录。</span>
            </div>

            <hr className="divider" />

            <div className="section-title">DeepSeek 峰谷与节假日</div>
            <div className="section-sub">
              高峰：北京时间工作日 09:00–12:00、14:00–18:00（不含法定节假日）；其余为空闲时段，价格为高峰 5 折。
            </div>
            <div className="form-grid">
              <Field
                label="节假日日历覆盖截止日期"
                hint={`内置数据覆盖至 ${holidays?.coverageStart ?? '—'} ~ ${holidays?.coverageEnd ?? '—'}；超出后 DeepSeek 费用默认标记为未知。`}
              >
                <div className="flex gap-2">
                  <input
                    className="input"
                    type="date"
                    value={holidayCoverageEnd}
                    onChange={(event) => setHolidayCoverageEnd(event.target.value)}
                  />
                  <button
                    className="btn"
                    disabled={!holidayCoverageEnd}
                    onClick={() => void saveHolidays(holidayCoverageEnd, holidayOverrides)}
                  >
                    保存日历
                  </button>
                </div>
              </Field>
              <Field label="日历未覆盖时" hint="关闭时（推荐）会把费用标记为未知，避免按错误费率估算。">
                <div className="flex h-[30px] items-center gap-3">
                  <Switch
                    checked={draft.allowUncoveredHolidayEstimate}
                    onChange={(checked) => persist({ ...draft, allowUncoveredHolidayEstimate: checked })}
                    label="允许按工作日规则估算"
                  />
                  <span className="hint">允许估算</span>
                </div>
              </Field>
            </div>

            <div className="mt-2 text-[11.5px]">
              <div className="label mb-1">节假日自定义（新增或移除）</div>
              {holidayOverrides.length === 0 ? (
                <p className="hint">暂无自定义。内置节假日数据来自国务院办公厅通知。</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {holidayOverrides.map((override) => (
                    <span key={override.date} className="chip">
                      {override.date} {override.name || (override.action === 'add' ? '自定义' : '移除')} ·{' '}
                      {override.action === 'add' ? '放假' : '按工作日'}
                      <button
                        className="icon-btn h-4 w-4"
                        onClick={() =>
                          setHolidayOverrides((current) =>
                            current.filter((item) => item.date !== override.date),
                          )
                        }
                        aria-label="删除该规则"
                      >
                        <X size={10} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <input
                  type="date"
                  className="input"
                  style={{ width: 150 }}
                  value={newHolidayDate}
                  onChange={(event) => setNewHolidayDate(event.target.value)}
                />
                <input
                  className="input"
                  style={{ width: 160 }}
                  placeholder="名称，例如 国庆节"
                  value={newHolidayName}
                  onChange={(event) => setNewHolidayName(event.target.value)}
                />
                <select
                  className="select"
                  style={{ width: 130 }}
                  value={newHolidayAction}
                  onChange={(event) => setNewHolidayAction(event.target.value as 'add' | 'remove')}
                >
                  <option value="add">设为节假日</option>
                  <option value="remove">设为工作日</option>
                </select>
                <button
                  className="btn"
                  disabled={!newHolidayDate}
                  onClick={() => {
                    if (!newHolidayDate) return;
                    setHolidayOverrides((current) => [
                      ...current.filter((item) => item.date !== newHolidayDate),
                      { date: newHolidayDate, name: newHolidayName, action: newHolidayAction },
                    ]);
                    setNewHolidayDate('');
                    setNewHolidayName('');
                  }}
                >
                  <Plus size={11} /> 添加
                </button>
                <button
                  className="btn btn-primary"
                  onClick={() => void saveHolidays(holidayCoverageEnd, holidayOverrides)}
                >
                  保存规则
                </button>
              </div>
              <p className="hint" style={{ marginTop: 6 }}>
                遇到未来年度未公布的假期安排时，请先更新日历覆盖范围或维持“费用未知”，应用不会静默套用错误费率。
              </p>
            </div>
          </section>

          {/* ------------------------------------------------------ budget */}
          <section className="settings-section">
            <div className="settings-header">
              <div>
                <h2 className="settings-title">预算提醒</h2>
                <p className="settings-sub">
                  仅基于本地估算费用；不含未返回 usage 的请求，也不等同于服务商的强制扣费上限。
                </p>
              </div>
              <Switch
                checked={draft.budget.enabled}
                onChange={(checked) => persist({ ...draft, budget: { ...draft.budget, enabled: checked } })}
                label="启用预算提醒"
              />
            </div>
            <div className="form-grid-4">
              {(
                [
                  ['turnUsd', '单轮预算（USD）'],
                  ['conversationUsd', '单会话预算（USD）'],
                  ['dailyUsd', '每日预算（USD）'],
                  ['totalUsd', '总费用预算（USD）'],
                ] as const
              ).map(([key, label]) => (
                <Field key={key} label={label}>
                  <input
                    className="input"
                    inputMode="decimal"
                    placeholder="不限制"
                    value={draft.budget[key] ?? ''}
                    onChange={(event) => {
                      const value = event.target.value.trim();
                      update({
                        budget: {
                          ...draft.budget,
                          [key]: value === '' ? null : value,
                        },
                      });
                    }}
                  />
                </Field>
              ))}
            </div>
            <div className="mt-2 flex justify-end">
              <button className="btn btn-primary" onClick={() => persist(draft)}>
                <Save size={12} /> 保存预算设置
              </button>
            </div>
          </section>

          {/* -------------------------------------------------------- data */}
          <section className="settings-section">
            <div className="settings-header">
              <div>
                <h2 className="settings-title">数据与备份</h2>
                <p className="settings-sub">
                  备份文件包含聊天、用量与费用数据，不包含 API Key。恢复会覆盖当前数据，并自动保留恢复前快照。
                </p>
              </div>
              <HardDrive size={18} style={{ color: 'var(--text-tertiary)' }} />
            </div>

            <div className="kv" style={{ marginBottom: 10 }}>
              <dt>数据目录</dt>
              <dd className="mono" style={{ userSelect: 'text', maxWidth: 460, whiteSpace: 'normal' }}>
                {meta?.dataDir ?? '—'}
              </dd>
              <dt>数据库版本</dt>
              <dd>{meta?.schemaVersion ?? '—'}</dd>
              <dt>密钥存储</dt>
              <dd>{keyStatus?.storageBackend ?? '—'}</dd>
            </div>

            <div className="flex flex-wrap gap-2">
              <button className="btn" onClick={() => void createBackup()}>
                <Download size={12} /> 创建全量备份
              </button>
              <button className="btn" onClick={() => void restoreBackup()}>
                <Upload size={12} /> 从备份恢复
              </button>
            </div>

            <hr className="divider" />

            <div className="section-title" style={{ color: 'var(--danger)' }}>
              危险操作
            </div>
            <p className="hint" style={{ marginBottom: 8 }}>
              彻底删除所有聊天记录、API 请求与费用统计，无法恢复。API Key 与价格配置不会被删除。建议先创建备份。
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <Field label='输入“删除全部数据”以确认'>
                <input
                  className="input"
                  style={{ width: 240 }}
                  value={deleteConfirm}
                  onChange={(event) => setDeleteConfirm(event.target.value)}
                  placeholder="删除全部数据"
                />
              </Field>
              <button
                className="btn btn-danger"
                disabled={deleteConfirm !== '删除全部数据'}
                onClick={async () => {
                  const confirmed = await askConfirm({
                    title: '彻底删除全部本地数据？',
                    message: '将永久删除所有会话、消息、API 请求与费用记录，且无法恢复。',
                    detail: 'API Key 仍保留在安全存储中；如需完整重置，请另行删除 Key。',
                    confirmLabel: '永久删除',
                    danger: true,
                  });
                  if (confirmed) {
                    await deleteAllData();
                    setDeleteConfirm('');
                  }
                }}
              >
                <Trash2 size={12} /> 永久删除全部数据
              </button>
            </div>
          </section>

          {/* -------------------------------------------------------- about */}
          <section className="settings-section">
            <div className="settings-header">
              <div>
                <h2 className="settings-title">关于 TokenLedger</h2>
                <p className="settings-sub">本地优先的 macOS AI 聊天与费用账本 · 版本 {meta?.version ?? '1.0.0'}</p>
              </div>
              {meta?.testMode ? <span className="badge">测试模式</span> : null}
            </div>
            <div className="kv">
              <dt>Electron / Chromium / Node</dt>
              <dd className="mono">
                {meta?.electronVersion} / {meta?.chromeVersion} / {meta?.nodeVersion}
              </dd>
              <dt>价格版本</dt>
              <dd className="mono">
                {pricing?.versions.openai} · {pricing?.versions.deepseek}
              </dd>
              <dt>价格核对日期</dt>
              <dd>{pricing?.versions.verifiedAt}</dd>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                className="btn btn-sm"
                onClick={() => void openExternal('https://developers.openai.com/api/docs/pricing')}
              >
                OpenAI 价格 <ExternalLink size={10} />
              </button>
              <button
                className="btn btn-sm"
                onClick={() =>
                  void openExternal('https://api-docs.deepseek.com/zh-cn/quick_start/pricing/')
                }
              >
                DeepSeek 价格 <ExternalLink size={10} />
              </button>
              <button
                className="btn btn-sm"
                onClick={() => void openExternal('https://developers.openai.com/api/docs/guides/prompt-caching')}
              >
                OpenAI 缓存计费 <ExternalLink size={10} />
              </button>
              <button
                className="btn btn-sm"
                onClick={() => void openExternal('https://api-docs.deepseek.com/zh-cn/guides/kv_cache/')}
              >
                DeepSeek 缓存 <ExternalLink size={10} />
              </button>
            </div>
            <p className="hint" style={{ marginTop: 10 }}>
              本应用不开源上传任何数据，不含遥测或广告；仅在你主动聊天或查询余额时与所选官方服务商通信。普通 API
              不返回逐笔官方账单，界面中的费用均为估算值。
            </p>
          </section>
        </div>
      </div>

      <Modal
        open={!!editingPrice}
        title={`覆盖价格 · ${editingPrice?.displayName ?? ''}`}
        subtitle={
          editingPrice
            ? `${PROVIDER_LABEL[editingPrice.provider]} / ${editingPrice.model} · 留空的字段将沿用内置价格。保存后仅影响之后的新请求。`
            : undefined
        }
        onClose={() => setEditingPrice(null)}
        width={620}
        actions={
          <>
            <button className="btn" onClick={() => setEditingPrice(null)}>
              取消
            </button>
            {editingPrice && overrideByModel.has(`${editingPrice.provider}:${editingPrice.model}`) ? (
              <button
                className="btn"
                onClick={async () => {
                  if (!editingPrice) return;
                  await resetPriceOverride(editingPrice.provider, editingPrice.model);
                  setEditingPrice(null);
                }}
              >
                <RotateCcw size={11} /> 恢复内置
              </button>
            ) : null}
            <button
              className="btn btn-primary"
              disabled={!priceForm}
              onClick={async () => {
                if (!priceForm) return;
                await setPriceOverride(priceForm);
                setEditingPrice(null);
              }}
            >
              保存覆盖
            </button>
          </>
        }
      >
        {priceForm ? (
          <div className="form-grid">
            {(
              [
                ['inputPerM', '输入单价', false],
                ['cachedInputPerM', '缓存读取单价', false],
                ['outputPerM', '输出单价', true],
                ['cacheWrite30mPerM', '缓存写入 30 分钟', false],
                ['cacheWrite12hPerM', '缓存写入 12 小时', false],
                ['offPeakInputPerM', '低谷输入单价', false],
                ['offPeakCachedInputPerM', '低谷缓存读取单价', false],
                ['offPeakOutputPerM', '低谷输出单价', false],
              ] as [keyof OverrideRow, string, boolean][]
            ).map(([key, label]) => (
              <Field key={key} label={label}>
                <input
                  className="input"
                  inputMode="decimal"
                  placeholder="沿用内置"
                  value={(priceForm[key] as string | null) ?? ''}
                  onChange={(event) =>
                    setPriceForm({
                      ...priceForm,
                      [key]: event.target.value.trim() === '' ? null : event.target.value.trim(),
                    })
                  }
                />
              </Field>
            ))}
            <Field label="币种">
              <select
                className="select"
                value={priceForm.currency ?? 'USD'}
                onChange={(event) =>
                  setPriceForm({ ...priceForm, currency: event.target.value as Currency })
                }
              >
                <option value="USD">USD</option>
                <option value="CNY">CNY</option>
              </select>
            </Field>
            <Field label="生效日期">
              <input
                className="input"
                type="date"
                value={priceForm.effectiveFrom}
                onChange={(event) => setPriceForm({ ...priceForm, effectiveFrom: event.target.value })}
              />
            </Field>
            <Field label="来源 URL（可选）">
              <input
                className="input"
                placeholder="https://…"
                value={priceForm.sourceUrl ?? ''}
                onChange={(event) =>
                  setPriceForm({ ...priceForm, sourceUrl: event.target.value.trim() || null })
                }
              />
            </Field>
            <Field label="备注（可选）">
              <input
                className="input"
                value={priceForm.notes ?? ''}
                onChange={(event) =>
                  setPriceForm({ ...priceForm, notes: event.target.value.trim() || null })
                }
              />
            </Field>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
