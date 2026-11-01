import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  Download,
  RefreshCw,
} from 'lucide-react';
import type { Currency, GlobalStats } from '../../shared/types';
import {
  formatAmount,
  formatDateTime,
  formatRatio,
  formatTokens,
  formatUsd,
} from '../../shared/cost/format';
import { toDateInputValue, type RangePreset } from '../../shared/time';
import { useAppStore } from '../store';

const PRESETS: { key: RangePreset; label: string }[] = [
  { key: 'today', label: '今日' },
  { key: 'week', label: '本周' },
  { key: 'month', label: '本月' },
  { key: 'all', label: '全部' },
  { key: 'custom', label: '自定义' },
];

const STATUS_LABEL: Record<string, string> = {
  completed: '完成',
  error: '失败',
  aborted: '已停止',
  interrupted: '中断',
  streaming: '进行中',
};

const PURPOSE_LABEL: Record<string, string> = {
  chat: '普通聊天',
  title_generation: 'AI 标题生成',
};

function providerLabel(provider: string): string {
  return provider === 'openai' ? 'OpenAI' : 'DeepSeek';
}

function nativeCostText(costs: { currency: Currency; amount: string }[]): string {
  return costs.map((item) => formatAmount(item.amount, item.currency)).join(' + ');
}

function dayLabel(date: string): string {
  const [, month, day] = date.split('-');
  return `${Number(month)}/${Number(day)}`;
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub ? <div className="stat-sub">{sub}</div> : null}
    </div>
  );
}

function DailyChart({ stats }: { stats: GlobalStats }) {
  const days = stats.byDay;
  const max = useMemo(() => {
    return days.reduce((current, day) => Math.max(current, day.totalTokens, Number(day.costUsd) * 1_000_000), 0) || 1;
  }, [days]);

  if (days.length === 0) {
    return <p className="hint">所选范围内还没有 API 请求。</p>;
  }

  return (
    <div>
      <div className="bar-chart">
        {days.map((day) => {
          const height = Math.max(2, (day.totalTokens / max) * 100);
          return (
            <div className="bar-col" key={day.date} title={`${day.date}\n${formatTokens(day.totalTokens)} Tokens\n估算 ${formatUsd(day.costUsd)}\n${day.requestCount} 次请求`}>
              <div className="bar-fill" style={{ height: `${height}%` }} />
              <span className="bar-label">{dayLabel(day.date)}</span>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex items-center justify-between text-[10.5px] text-[var(--text-tertiary)]">
        <span>按日 Token 用量</span>
        <span>
          {days.length} 天 · 峰值 {formatTokens(Math.max(...days.map((day) => day.totalTokens)))} Tokens
        </span>
      </div>
    </div>
  );
}

function TokenSplit({ stats }: { stats: GlobalStats }) {
  const total = stats.totalTokens || 1;
  const segments = [
    { label: '未缓存输入', value: stats.uncachedInputTokens, color: '#0a84ff' },
    { label: '缓存读取', value: stats.cacheReadTokens, color: '#30d158' },
    { label: '缓存写入', value: stats.cacheWriteTokens, color: '#ff9f0a' },
    { label: '输出', value: stats.outputTokens, color: '#bf5af2' },
  ];
  return (
    <div>
      <div className="token-split">
        {segments.map((segment) => (
          <div
            key={segment.label}
            className="token-seg"
            style={{ width: `${Math.max(0, (segment.value / total) * 100)}%`, background: segment.color }}
            title={`${segment.label}: ${formatTokens(segment.value)}`}
          />
        ))}
      </div>
      <div className="legend">
        {segments.map((segment) => (
          <span key={segment.label}>
            <i className="legend-dot" style={{ background: segment.color }} />
            {segment.label} {formatTokens(segment.value)}
          </span>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] text-[var(--text-secondary)]">
        <div className="cost-line">
          <span>缓存命中占比</span>
          <span>{formatRatio(stats.cacheHitRatio)}</span>
        </div>
        <div className="cost-line">
          <span>推理 Token（含于输出）</span>
          <span>{formatTokens(stats.reasoningTokens)}</span>
        </div>
      </div>
      <p className="hint" style={{ marginTop: 6 }}>
        输入总量包含缓存读取与缓存写入；推理 Token 已包含在输出中，不重复相加。
      </p>
    </div>
  );
}

export function UsagePage() {
  const usage = useAppStore((state) => state.usage);
  const range = useAppStore((state) => state.usageRange);
  const loading = useAppStore((state) => state.usageLoading);
  const loadUsage = useAppStore((state) => state.loadUsage);
  const refreshUsage = useAppStore((state) => state.refreshUsage);
  const exportStatsCsv = useAppStore((state) => state.exportStatsCsv);
  const selectConversation = useAppStore((state) => state.selectConversation);
  const selectPage = useAppStore((state) => state.selectPage);
  const usageFilter = useAppStore((state) => state.usageFilter);
  const setUsageFilter = useAppStore((state) => state.setUsageFilter);
  const pricing = useAppStore((state) => state.pricing);
  const stats = usage;

  const modelOptions = useMemo(() => {
    const list = (pricing?.models ?? [])
      .filter((model) => !usageFilter.provider || model.provider === usageFilter.provider)
      .map((model) => model.model);
    const extra = (stats?.byModel ?? [])
      .filter((model) => !usageFilter.provider || model.provider === usageFilter.provider)
      .map((model) => model.model);
    return [...new Set([...list, ...extra])].sort();
  }, [pricing, usageFilter.provider, stats]);

  const [customFrom, setCustomFrom] = useState(toDateInputValue(range.from) || toDateInputValue(new Date().toISOString()));
  const [customTo, setCustomTo] = useState(toDateInputValue(range.to) || toDateInputValue(new Date().toISOString()));

  useEffect(() => {
    if (range.preset !== 'custom') {
      setCustomFrom(toDateInputValue(range.from) || toDateInputValue(new Date().toISOString()));
      setCustomTo(toDateInputValue(range.to) || toDateInputValue(new Date().toISOString()));
    }
  }, [range]);

  const hasUnknown = (stats?.unknownCostRequestCount ?? 0) > 0;
  const filterLabel = [
    usageFilter.provider ? providerLabel(usageFilter.provider) : '全部服务商',
    usageFilter.model ?? '全部模型',
    usageFilter.purpose ? PURPOSE_LABEL[usageFilter.purpose] : '全部用途',
  ].join(' · ');

  return (
    <div className="page">
      <header className="page-header">
        <BarChart3 size={15} style={{ color: 'var(--text-secondary)' }} />
        <h1 className="page-title">用量统计</h1>
        <span className="hint">
          {range.label} · {filterLabel}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <div className="range-tabs">
            {PRESETS.map((preset) => (
              <button
                key={preset.key}
                className={`range-tab ${range.preset === preset.key ? 'active' : ''}`}
                onClick={() => {
                  if (preset.key === 'custom') {
                    void loadUsage('custom', customFrom, customTo);
                  } else {
                    void loadUsage(preset.key);
                  }
                }}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <button className="btn btn-sm" onClick={() => void refreshUsage()} disabled={loading}>
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> 刷新
          </button>
          <button className="btn btn-sm" onClick={() => void exportStatsCsv()} disabled={!stats}>
            <Download size={12} /> 导出 CSV
          </button>
        </div>
      </header>

      <div className="page-scroll">
        <div className="page-body">
          <div className="card card-pad mb-4 flex flex-wrap items-end gap-3">
            <label className="field">
              <span className="label">服务商筛选</span>
              <select
                className="select"
                style={{ width: 180 }}
                value={usageFilter.provider ?? ''}
                onChange={(event) =>
                  setUsageFilter({
                    provider: (event.target.value || null) as 'openai' | 'deepseek' | null,
                  })
                }
              >
                <option value="">全部服务商</option>
                <option value="openai">OpenAI</option>
                <option value="deepseek">DeepSeek</option>
              </select>
            </label>
            <label className="field">
              <span className="label">请求用途</span>
              <select
                className="select"
                style={{ width: 170 }}
                value={usageFilter.purpose ?? ''}
                onChange={(event) =>
                  setUsageFilter({
                    purpose:
                      (event.target.value as 'chat' | 'title_generation' | '') || null,
                  })
                }
              >
                <option value="">全部用途</option>
                <option value="chat">普通聊天</option>
                <option value="title_generation">AI 标题生成</option>
              </select>
            </label>
            <label className="field">
              <span className="label">模型筛选</span>
              <select
                className="select"
                style={{ width: 220 }}
                value={usageFilter.model ?? ''}
                onChange={(event) => setUsageFilter({ model: event.target.value || null })}
              >
                <option value="">全部模型</option>
                {modelOptions.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            </label>
            <span className="hint" style={{ paddingBottom: 6 }}>
              筛选同时作用于汇总、模型表、会话排名与最近请求；日期范围仍按上方选择。
            </span>
          </div>

          {range.preset === 'custom' ? (
            <div className="card card-pad mb-4 flex flex-wrap items-end gap-3">
              <label className="field">
                <span className="label">开始日期</span>
                <input
                  type="date"
                  className="input"
                  value={customFrom}
                  onChange={(event) => setCustomFrom(event.target.value)}
                />
              </label>
              <label className="field">
                <span className="label">结束日期</span>
                <input
                  type="date"
                  className="input"
                  value={customTo}
                  onChange={(event) => setCustomTo(event.target.value)}
                />
              </label>
              <button
                className="btn btn-primary"
                onClick={() => void loadUsage('custom', customFrom, customTo)}
                disabled={!customFrom || !customTo}
              >
                应用日期范围
              </button>
              <span className="hint">按本机时区计算，结束日期当天全天包含在内。</span>
            </div>
          ) : null}

          {!stats ? (
            <p className="hint">正在读取统计…</p>
          ) : (
            <>
              <section className="stat-grid">
                <StatCard
                  label="估算费用（美元）"
                  value={formatUsd(stats.costUsd)}
                  sub={
                    nativeCostText(stats.nativeCosts)
                      ? `原生币种合计 ${nativeCostText(stats.nativeCosts)}`
                      : '全部为美元计价'
                  }
                />
                <StatCard
                  label="总 Token"
                  value={formatTokens(stats.totalTokens)}
                  sub={`输入 ${formatTokens(stats.inputTokens)} · 输出 ${formatTokens(stats.outputTokens)}`}
                />
                <StatCard
                  label="API 请求"
                  value={formatTokens(stats.requestCount)}
                  sub={`${stats.conversationCount} 个会话 · ${stats.byDay.length} 个活跃日`}
                />
                <StatCard
                  label="缓存命中占比"
                  value={formatRatio(stats.cacheHitRatio)}
                  sub={`缓存读取 ${formatTokens(stats.cacheReadTokens)} Tokens`}
                />
              </section>

              {hasUnknown || !stats.costUsdComplete ? (
                <div className="warn-banner" style={{ marginTop: 12 }}>
                  <AlertTriangle size={13} className="mt-0.5 flex-none" />
                  <span>
                    {hasUnknown
                      ? `有 ${stats.unknownCostRequestCount} 次请求费用未知，未计入金额合计；`
                      : ''}
                    {stats.partialCostRequestCount > 0
                      ? `有 ${stats.partialCostRequestCount} 次请求缺少美元折算，金额合计可能不完整。`
                      : ''}
                    所有金额均为按官方 usage 与价格快照计算的估算值，不代表服务商最终账单。
                  </span>
                </div>
              ) : null}

              <section className="mt-4 grid grid-cols-2 gap-3">
                {(['openai', 'deepseek'] as const).map((provider) => {
                  const item = stats.byProvider.find((entry) => entry.provider === provider);
                  return (
                    <div className="card card-pad" key={provider}>
                      <div className="flex items-center justify-between">
                        <div className="text-[12.5px] font-semibold">{providerLabel(provider)}</div>
                        <span className="hint">{item?.requestCount ?? 0} 次请求</span>
                      </div>
                      <div className="mt-2 text-[18px] font-semibold tabular-nums">
                        {formatUsd(item?.costUsd ?? '0')}
                      </div>
                      <div className="hint">
                        {formatTokens(item?.totalTokens ?? 0)} Tokens · 输入{' '}
                        {formatTokens(item?.inputTokens ?? 0)} · 输出 {formatTokens(item?.outputTokens ?? 0)}
                        {item && !item.costUsdComplete ? ' · 部分费用未知' : ''}
                      </div>
                    </div>
                  );
                })}
              </section>

              <section className="card card-pad mt-4">
                <div className="section-title">按请求用途</div>
                <div className="section-sub">
                  自动/手动 AI 标题请求与普通聊天请求分别归集；总额始终来自同一批底层请求记录。
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>用途</th>
                        <th className="num">请求</th>
                        <th className="num">Token</th>
                        <th className="num">估算费用</th>
                        <th>状态</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(['chat', 'title_generation'] as const).map((purpose) => {
                        const item = stats.byPurpose.find((entry) => entry.purpose === purpose);
                        return (
                          <tr key={purpose}>
                            <td>{PURPOSE_LABEL[purpose]}</td>
                            <td className="num">{formatTokens(item?.requestCount ?? 0)}</td>
                            <td className="num">{formatTokens(item?.totalTokens ?? 0)}</td>
                            <td className="num">{formatUsd(item?.costUsd ?? '0')}</td>
                            <td>
                              {item && !item.costUsdComplete ? (
                                <span className="text-[var(--warning)]">部分未知</span>
                              ) : (
                                <span className="text-[var(--success)]">完整</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
                <div className="card card-pad">
                  <div className="section-title">每日用量</div>
                  <div className="section-sub">所选范围内的每日 Token 与估算费用</div>
                  <DailyChart stats={stats} />
                </div>
                <div className="card card-pad">
                  <div className="section-title">Token 分布</div>
                  <div className="section-sub">输入、缓存与输出的构成</div>
                  <TokenSplit stats={stats} />
                </div>
              </section>

              <section className="card card-pad mt-4">
                <div className="section-title">模型费用</div>
                <div className="section-sub">按服务商与模型归集，包含所有真实请求</div>
                <div style={{ overflowX: 'auto' }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>服务商</th>
                        <th>模型</th>
                        <th className="num">请求</th>
                        <th className="num">Token</th>
                        <th className="num">估算费用</th>
                        <th>状态</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.byModel.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="hint">
                            暂无数据
                          </td>
                        </tr>
                      ) : (
                        stats.byModel
                          .slice()
                          .sort((a, b) => Number(b.costUsd) - Number(a.costUsd))
                          .map((model) => (
                            <tr key={`${model.provider}:${model.model}`}>
                              <td>{providerLabel(model.provider)}</td>
                              <td className="mono">{model.model}</td>
                              <td className="num">{formatTokens(model.requestCount)}</td>
                              <td className="num">{formatTokens(model.totalTokens)}</td>
                              <td className="num">{formatUsd(model.costUsd)}</td>
                              <td>
                                {model.costUsdComplete ? (
                                  <span className="text-[var(--success)]">完整</span>
                                ) : (
                                  <span className="text-[var(--warning)]">部分未知</span>
                                )}
                              </td>
                            </tr>
                          ))
                      )}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="card card-pad mt-4">
                <div className="section-title">会话费用排名</div>
                <div className="section-sub">点击会话可跳转查看详情；归档会话仍计入全局累计</div>
                <div style={{ overflowX: 'auto' }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>会话</th>
                        <th className="num">请求</th>
                        <th className="num">Token</th>
                        <th className="num">估算费用</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.byConversation.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="hint">
                            暂无数据
                          </td>
                        </tr>
                      ) : (
                        stats.byConversation.slice(0, 20).map((conversation, index) => (
                          <tr
                            key={conversation.conversationId}
                            className="clickable"
                            onClick={() => {
                              selectPage('chat');
                              void selectConversation(conversation.conversationId);
                            }}
                          >
                            <td>
                              <span className="mr-2 text-[var(--text-tertiary)]">{index + 1}</span>
                              {conversation.title}
                            </td>
                            <td className="num">{formatTokens(conversation.requestCount)}</td>
                            <td className="num">{formatTokens(conversation.totalTokens)}</td>
                            <td className="num">{formatUsd(conversation.costUsd)}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="card card-pad mt-4">
                <div className="section-title">最近请求</div>
                <div className="section-sub">仅显示最近 50 次请求；完整数据可导出 CSV</div>
                <div style={{ overflowX: 'auto' }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>时间</th>
                        <th>服务商 / 模型</th>
                        <th>用途</th>
                        <th>状态</th>
                        <th className="num">输入</th>
                        <th className="num">缓存读</th>
                        <th className="num">输出</th>
                        <th className="num">费用</th>
                        <th>计算</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.recentRequests.length === 0 ? (
                        <tr>
                          <td colSpan={9} className="hint">
                            暂无数据
                          </td>
                        </tr>
                      ) : (
                        stats.recentRequests.map((request) => (
                          <tr key={request.id}>
                            <td>{formatDateTime(request.startedAt)}</td>
                            <td>
                              {providerLabel(request.provider)} /{' '}
                              <span className="mono">{request.model}</span>
                            </td>
                            <td>
                              <span
                                className={`purpose-badge ${
                                  request.requestPurpose === 'title_generation'
                                    ? 'purpose-title'
                                    : 'purpose-chat'
                                }`}
                              >
                                {PURPOSE_LABEL[request.requestPurpose]}
                              </span>
                            </td>
                            <td>{STATUS_LABEL[request.status] ?? request.status}</td>
                            <td className="num">{formatTokens(request.inputTokens)}</td>
                            <td className="num">{formatTokens(request.cacheReadTokens)}</td>
                            <td className="num">{formatTokens(request.outputTokens)}</td>
                            <td className="num">
                              {request.costAmount === null
                                ? '未知'
                                : formatAmount(request.costAmount, request.costCurrency ?? 'USD')}
                            </td>
                            <td>
                              {request.calculationStatus === 'unknown' ? (
                                <span className="text-[var(--warning)]">未知</span>
                              ) : request.calculationStatus === 'partial' ? (
                                <span className="text-[var(--warning)]">部分</span>
                              ) : (
                                <span className="text-[var(--success)]">已计算</span>
                              )}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </section>

              <p className="hint mt-4">
                统计基于本地记录的每次真实 API 请求。由于普通 API 不返回逐笔账单，这里的费用为估算值；DeepSeek 人民币费用按请求时汇率快照折算为美元。
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
