import { useState } from 'react';
import { AlertTriangle, ChevronDown } from 'lucide-react';
import type {
  ApiRequestRow,
  ConversationStats,
  Currency,
  RequestPurpose,
  TurnView,
} from '../../shared/types';
import { formatAmount, formatDateTime, formatTokens, formatUsd } from '../../shared/cost/format';

function shortId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 12)}…` : id;
}

const STATUS_LABEL: Record<string, string> = {
  completed: '完成',
  error: '失败',
  aborted: '已停止',
  interrupted: '中断',
  streaming: '进行中',
};

const PURPOSE_LABEL: Record<RequestPurpose, string> = {
  chat: '聊天',
  title_generation: 'AI 命名',
};

function nativeLabel(costs: { currency: Currency; amount: string }[]): string {
  if (costs.length === 0) return '';
  return costs.map((item) => formatAmount(item.amount, item.currency)).join(' + ');
}

function requestsWarning(requests: ApiRequestRow[]): string | null {
  const unknown = requests.filter((request) => request.calculationStatus === 'unknown');
  if (unknown.length === 0) return null;
  const detail = unknown
    .map((request) => request.errorDetails)
    .filter((value): value is string => !!value);
  return detail[0] ?? '缺少必要计费数据，无法准确计算费用。';
}

export function TurnCost({ turn }: { turn: TurnView }) {
  const [open, setOpen] = useState(false);
  const { stats, requests } = turn;
  const unknown = stats.calculationStatus === 'unknown';
  const warning = requestsWarning(requests);
  const pricingVersion =
    [...new Set(requests.map((request) => request.pricingVersion).filter((value): value is string => !!value))].join(
      ' / ',
    ) || '—';
  const pricingBasis =
    [...new Set(requests.map((request) => request.pricingBasis).filter((value): value is string => !!value))].join(
      '；',
    ) || '官方 usage × 价格快照';

  if (requests.length === 0) {
    return <span className="cost-chip">本轮尚未产生 API 请求</span>;
  }

  return (
    <div>
      <button
        type="button"
        className={`cost-chip ${unknown ? 'chip-warn' : ''}`}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        {unknown ? <AlertTriangle size={11} /> : null}
        <span>
          本轮 {stats.tokensUnknown ? '部分用量未知' : `${formatTokens(stats.totalTokens)} Tokens`} ·{' '}
          {unknown ? '费用未知' : formatUsd(stats.costUsd)}
        </span>
        <ChevronDown size={11} style={{ transform: open ? 'rotate(180deg)' : undefined }} />
      </button>

      {open ? (
        <div className="cost-details">
          <div className="cost-total-line">
            <span>本轮合计</span>
            <strong>{formatTokens(stats.totalTokens)} Tokens</strong>
            <strong>{unknown ? '费用未知' : formatUsd(stats.costUsd)}</strong>
          </div>
          <div className="cost-details-grid">
            <div>
              <div className="cost-line">
                <span>输入</span>
                <span>{formatTokens(stats.inputTokens)}</span>
              </div>
              <div className="cost-line">
                <span>缓存读取</span>
                <span>{formatTokens(stats.cacheReadTokens)}</span>
              </div>
              <div className="cost-line">
                <span>缓存写入</span>
                <span>{formatTokens(stats.cacheWriteTokens)}</span>
              </div>
              <div className="cost-line">
                <span>输出</span>
                <span>{formatTokens(stats.outputTokens)}</span>
              </div>
              <div className="cost-line">
                <span>推理（含于输出）</span>
                <span>{formatTokens(stats.reasoningTokens)}</span>
              </div>
              <div className="cost-line">
                <span>API 请求次数</span>
                <span>{stats.requestCount}</span>
              </div>
              <div className="cost-line">
                <span>其中 AI 命名</span>
                <span>
                  {requests.filter((request) => request.requestPurpose === 'title_generation').length} 次
                </span>
              </div>
            </div>
            <div>
              <div className="cost-line">
                <span>估算费用</span>
                <span>{unknown ? '无法准确计算' : formatUsd(stats.costUsd)}</span>
              </div>
              {nativeLabel(stats.nativeCosts) ? (
                <div className="cost-line">
                  <span>原生币种</span>
                  <span>{nativeLabel(stats.nativeCosts)}</span>
                </div>
              ) : null}
              <div className="cost-line">
                <span>计算状态</span>
                <span>{unknown ? '未知' : stats.calculationStatus === 'partial' ? '部分' : '已计算'}</span>
              </div>
              <div className="cost-line">
                <span>价格版本</span>
                <span className="mono">{pricingVersion ?? '—'}</span>
              </div>
              <div className="cost-line">
                <span>计价方式</span>
                <span className="text-right" style={{ maxWidth: 260 }} title={pricingBasis}>
                  {pricingBasis}
                </span>
              </div>
            </div>
          </div>

          {warning ? (
            <div className="warn-banner">
              <AlertTriangle size={13} className="mt-0.5 flex-none" />
              <span>{warning}</span>
            </div>
          ) : null}

          <div style={{ overflowX: 'auto', marginTop: 10 }}>
            <table className="mini-table">
              <thead>
                <tr>
                  <th>请求</th>
                  <th>用途</th>
                  <th>时间</th>
                  <th>状态</th>
                  <th>输入</th>
                  <th>缓存读</th>
                  <th>缓存写</th>
                  <th>输出</th>
                  <th>费用</th>
                  <th>价格版本</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((request) => (
                  <tr key={request.id}>
                    <td className="mono cell-id" title={`${request.id} · ${request.provider}/${request.model}`}>
                      <span>{shortId(request.id)}</span>
                      <span className="request-model">{request.model}</span>
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
                    <td>{formatDateTime(request.startedAt)}</td>
                    <td>{STATUS_LABEL[request.status] ?? request.status}</td>
                    <td>{formatTokens(request.inputTokens)}</td>
                    <td>{formatTokens(request.cacheReadTokens)}</td>
                    <td>{formatTokens(request.cacheWriteTokens)}</td>
                    <td>{formatTokens(request.outputTokens)}</td>
                    <td>
                      {request.costAmount === null
                        ? '未知'
                        : formatAmount(request.costAmount, request.costCurrency ?? 'USD')}
                    </td>
                    <td className="mono cell-version" title={request.pricingVersion ?? undefined}>
                      {request.pricingVersion ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="cost-note">
            费用为根据官方 usage 与请求时价格快照计算的估算值，不代表服务商最终账单。重新生成、重试或 AI 命名产生的实际请求费用均不会被抹除。
          </p>
        </div>
      ) : null}
    </div>
  );
}

export function ConversationCost({
  stats,
  open,
  onToggle,
}: {
  stats: ConversationStats;
  open: boolean;
  onToggle: () => void;
}) {
  const unknown = stats.unknownCostRequestCount > 0;
  return (
    <button
      type="button"
      className={`chip ${unknown ? 'chip-warn' : ''}`}
      onClick={onToggle}
      aria-expanded={open}
      title="查看会话累计用量与费用（估算值，按实际请求价格快照计算，不代表官方账单）"
    >
      {unknown ? <AlertTriangle size={11} /> : null}
      <span>
        本会话 {formatTokens(stats.totalTokens)} Tokens · {unknown ? '部分费用未知' : formatUsd(stats.costUsd)}
      </span>
      <ChevronDown size={11} style={{ transform: open ? 'rotate(180deg)' : undefined }} />
    </button>
  );
}

export function ConversationStatsPanel({ stats }: { stats: ConversationStats }) {
  return (
    <div>
      <div className="cost-details-grid">
        <div>
          <div className="cost-line">
            <span>累计输入</span>
            <span>{formatTokens(stats.inputTokens)}</span>
          </div>
          <div className="cost-line">
            <span>其中缓存读取</span>
            <span>{formatTokens(stats.cacheReadTokens)}</span>
          </div>
          <div className="cost-line">
            <span>累计缓存写入</span>
            <span>{formatTokens(stats.cacheWriteTokens)}</span>
          </div>
          <div className="cost-line">
            <span>累计输出</span>
            <span>{formatTokens(stats.outputTokens)}</span>
          </div>
          <div className="cost-line">
            <span>其中推理</span>
            <span>{formatTokens(stats.reasoningTokens)}</span>
          </div>
          <div className="cost-line">
            <span>轮次 / API 请求</span>
            <span>
              {stats.turnCount} / {stats.requestCount}
            </span>
          </div>
        </div>
        <div>
          <div className="cost-line">
            <span>累计费用（估算）</span>
            <span>{formatUsd(stats.costUsd)}</span>
          </div>
          {nativeLabel(stats.nativeCosts) ? (
            <div className="cost-line">
              <span>原生币种</span>
              <span>{nativeLabel(stats.nativeCosts)}</span>
            </div>
          ) : null}
          <div className="cost-line">
            <span>缓存命中占比</span>
            <span>{stats.cacheHitRatio === null ? '未知' : `${(stats.cacheHitRatio * 100).toFixed(1)}%`}</span>
          </div>
          <div className="cost-line">
            <span>费用未知请求</span>
            <span>{stats.unknownCostRequestCount}</span>
          </div>
          <div className="cost-line">
            <span>用量未知请求</span>
            <span>{stats.tokensUnknownRequestCount}</span>
          </div>
        </div>
      </div>

      {stats.byModel.length > 0 ? (
        <div style={{ marginTop: 10 }}>
          <div className="label" style={{ marginBottom: 4 }}>
            模型费用占比
          </div>
          {stats.byModel.map((model) => {
            const total = Number(stats.costUsd) || 0;
            const share = total > 0 ? Math.min(100, (Number(model.costUsd) / total) * 100) : 0;
            return (
              <div key={`${model.provider}:${model.model}`} style={{ marginBottom: 6 }}>
                <div className="flex items-center justify-between text-[11px]">
                  <span className="truncate" style={{ maxWidth: 220 }} title={model.model}>
                    {model.model}
                  </span>
                  <span className="mono">
                    {formatUsd(model.costUsd)} · {formatTokens(model.totalTokens)} Tokens
                  </span>
                </div>
                <div className="bar-track" style={{ height: 4, borderRadius: 999, background: 'var(--code-bg)' }}>
                  <div
                    className="bar-fill"
                    style={{ width: `${share}%`, height: 4, borderRadius: 999 }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {stats.unknownCostRequestCount > 0 ? (
        <div className="warn-banner">
          <AlertTriangle size={13} className="mt-0.5 flex-none" />
          <span>
            有 {stats.unknownCostRequestCount} 次请求的费用无法准确计算（例如未返回 usage 或缺少价格），未被当作 $0 计入累计。
          </span>
        </div>
      ) : null}
      <p className="hint" style={{ marginTop: 10, marginBottom: 0 }}>
        会话累计按所有真实 API 请求的实际用量累加，包括历史上下文被反复发送所产生的 Token；同一会话内可混合不同服务商与模型。
      </p>
    </div>
  );
}
