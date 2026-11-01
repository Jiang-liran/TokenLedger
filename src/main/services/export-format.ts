import type {
  ApiRequestRow,
  ConversationDetail,
  Currency,
  GlobalStats,
  PricingSnapshot,
  TurnView,
} from '../../shared/types';
import { formatAmount, formatDateTime, formatTokens, formatUsd, formatNativeAndUsd } from '../../shared/cost/format';
import type { StatRequest } from '../../shared/stats';

export interface ConversationExportBundle {
  detail: ConversationDetail;
  pricingSnapshots: Record<string, PricingSnapshot | null>;
}

function pricingFor(
  bundle: ConversationExportBundle,
  request: ApiRequestRow,
): PricingSnapshot | null {
  if (!request.pricingSnapshotId) return null;
  return bundle.pricingSnapshots[request.pricingSnapshotId] ?? null;
}

function latestAssistantMessage(turn: TurnView) {
  const attempts = [...turn.assistantMessages].sort((a, b) => a.attempt - b.attempt);
  return attempts[attempts.length - 1] ?? null;
}

function turnCostLine(turn: TurnView): string {
  const cost = formatUsd(turn.stats.costUsd);
  const native = turn.stats.nativeCosts
    .map((item) => formatAmount(item.amount, item.currency))
    .join(' + ');
  const unknown = turn.stats.calculationStatus === 'unknown' ? '（费用未知）' : '';
  return `输入 ${formatTokens(turn.stats.inputTokens)} · 缓存读取 ${formatTokens(
    turn.stats.cacheReadTokens,
  )} · 输出 ${formatTokens(turn.stats.outputTokens)} · 推理 ${formatTokens(
    turn.stats.reasoningTokens,
  )} · 总计 ${formatTokens(turn.stats.totalTokens)} Tokens · 估算 ${cost}${native ? `（原生 ${native}）` : ''}${unknown}`;
}

export function conversationToMarkdown(bundle: ConversationExportBundle): string {
  const { detail } = bundle;
  const { conversation, stats, turns } = detail;
  const lines: string[] = [];
  lines.push(`# ${conversation.title}`);
  lines.push('');
  lines.push(`- 创建时间：${formatDateTime(conversation.createdAt)}`);
  lines.push(`- 最后更新：${formatDateTime(conversation.updatedAt)}`);
  lines.push(`- 默认模型：${conversation.defaultProvider} / ${conversation.defaultModel}`);
  lines.push(
    `- 会话累计：${formatTokens(stats.totalTokens)} Tokens · 估算 ${formatUsd(
      stats.costUsd,
    )}（${stats.requestCount} 次 API 请求，${stats.turnCount} 轮）`,
  );
  if (stats.unknownCostRequestCount > 0) {
    lines.push(`- 注意：有 ${stats.unknownCostRequestCount} 次请求费用未知，未计入累计费用。`);
  }
  lines.push('');
  lines.push('> 费用为根据官方 usage 与价格快照计算的估算值，不代表服务商最终账单。');
  lines.push('');

  for (const [index, turn] of turns.entries()) {
    lines.push('---');
    lines.push('');
    lines.push(`## 第 ${index + 1} 轮 · ${formatDateTime(turn.turn.createdAt)}`);
    lines.push('');
    lines.push('### 用户');
    lines.push('');
    lines.push(turn.userMessage?.content ?? '（用户消息缺失）');
    lines.push('');
    const assistant = latestAssistantMessage(turn);
    if (!assistant) {
      lines.push('### 助手');
      lines.push('');
      lines.push('（该轮没有助手回复）');
    } else {
      lines.push(`### 助手 · ${assistant.provider ?? ''} ${assistant.model ?? ''}`.trim());
      lines.push('');
      if (assistant.reasoningContent) {
        lines.push('<details>');
        lines.push('<summary>思考过程</summary>');
        lines.push('');
        lines.push(assistant.reasoningContent);
        lines.push('');
        lines.push('</details>');
        lines.push('');
      }
      lines.push(assistant.content || '（无内容）');
      lines.push('');
      if (assistant.status !== 'complete') {
        lines.push(`> 状态：${assistant.status}${assistant.errorDetails ? ` — ${assistant.errorDetails}` : ''}`);
        lines.push('');
      }
    }
    lines.push(`**本轮统计**：${turnCostLine(turn)}`);
    lines.push('');
    if (turn.requests.length > 0) {
      lines.push('| 请求 ID | 时间 | 模型 | 状态 | 输入 | 缓存读取 | 输出 | 费用 | 价格版本 |');
      lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
      for (const request of turn.requests) {
        const pricing = pricingFor(bundle, request);
        const cost =
          request.costAmount === null
            ? '未知'
            : formatNativeAndUsd(
                request.costAmount,
                request.costCurrency as Currency,
                request.costUsd,
              );
        lines.push(
          `| ${request.id} | ${formatDateTime(request.startedAt)} | ${request.provider}/${request.model} | ${request.status} | ${formatTokens(
            request.inputTokens,
          )} | ${formatTokens(request.cacheReadTokens)} | ${formatTokens(request.outputTokens)} | ${cost} | ${
            pricing?.pricingVersion ?? request.pricingVersion ?? '—'
          } |`,
        );
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

export interface ConversationJson {
  format: 'tokenledger-conversation';
  formatVersion: 1;
  exportedAt: string;
  conversation: ConversationDetail['conversation'];
  stats: ConversationDetail['stats'];
  turns: {
    turn: TurnView['turn'];
    userMessage: TurnView['userMessage'];
    assistantMessages: TurnView['assistantMessages'];
    requests: (ApiRequestRow & { pricingSnapshot: PricingSnapshot | null })[];
    stats: TurnView['stats'];
  }[];
}

export function conversationToJson(bundle: ConversationExportBundle): ConversationJson {
  return {
    format: 'tokenledger-conversation',
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    conversation: bundle.detail.conversation,
    stats: bundle.detail.stats,
    turns: bundle.detail.turns.map((turn) => ({
      turn: turn.turn,
      userMessage: turn.userMessage,
      assistantMessages: turn.assistantMessages,
      stats: turn.stats,
      requests: turn.requests.map((request) => ({
        ...request,
        pricingSnapshot: pricingFor(bundle, request),
      })),
    })),
  };
}

function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function requestsToCsv(rows: StatRequest[]): string {
  const headers = [
    'request_id',
    'conversation_id',
    'conversation_title',
    'provider',
    'model',
    'started_at',
    'status',
    'input_tokens',
    'uncached_input_tokens',
    'cache_read_tokens',
    'cache_write_tokens',
    'output_tokens',
    'reasoning_tokens',
    'total_tokens',
    'cost_amount',
    'cost_currency',
    'cost_usd',
    'calculation_status',
    'pricing_version',
    'pricing_basis',
    'error_details',
  ];
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(
      [
        row.id,
        row.conversationId,
        row.conversationTitle,
        row.provider,
        row.model,
        row.startedAt,
        row.status,
        row.usage?.inputTokens ?? '',
        row.usage?.uncachedInputTokens ?? '',
        row.usage?.cacheReadTokens ?? '',
        row.usage?.cacheWriteTokens ?? '',
        row.usage?.outputTokens ?? '',
        row.usage?.reasoningTokens ?? '',
        row.usage?.totalTokens ?? '',
        row.costAmount ?? '',
        row.costCurrency ?? '',
        row.costUsd ?? '',
        row.calculationStatus,
        row.pricingVersion ?? '',
        row.pricingBasis ?? '',
        row.errorDetails ?? '',
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

export function globalStatsSummary(stats: GlobalStats): string {
  return [
    `请求数: ${stats.requestCount}`,
    `会话数: ${stats.conversationCount}`,
    `总 Token: ${stats.totalTokens}`,
    `估算费用(USD): ${stats.costUsd}`,
    `费用未知请求: ${stats.unknownCostRequestCount}`,
  ].join('\n');
}
