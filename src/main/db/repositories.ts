import { Database } from './database';
import type {
  ApiRequestRecord,
  ApiRequestRow,
  BillingTier,
  CalculationStatus,
  Conversation,
  ConversationDetail,
  ConversationStats,
  ConversationSummary,
  Currency,
  GlobalStats,
  MessageStatus,
  NormalizedUsage,
  PriceTable,
  PricingSnapshot,
  ProviderId,
  RequestStatus,
  Role,
  StoredMessage,
  StoredTurn,
  TurnStatus,
  TurnView,
} from '../../shared/types';
import type { AppSettings } from '../../shared/settings';
import { mergeSettings } from '../../shared/settings';
import { parseStoredUsage } from '../../shared/usage';
import { aggregateTotals, buildConversationStats, buildGlobalStats, type StatRequest } from '../../shared/stats';
import { toDecimalString } from '../../shared/cost/engine';
import type { PriceOverrideRow } from '../../shared/ipc';
import type { HolidayOverride } from '../../shared/pricing/holidays';
import { newId } from '../../shared/id';

type Row = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function number(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

function mapConversation(row: Row): Conversation {
  return {
    id: text(row.id),
    title: text(row.title),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    archivedAt: textOrNull(row.archived_at),
    deletedAt: textOrNull(row.deleted_at),
    defaultProvider: text(row.default_provider) as ProviderId,
    defaultModel: text(row.default_model),
    systemPrompt: textOrNull(row.system_prompt),
  };
}

function mapMessage(row: Row): StoredMessage {
  return {
    id: text(row.id),
    conversationId: text(row.conversation_id),
    turnId: textOrNull(row.turn_id),
    role: text(row.role) as Role,
    content: text(row.content),
    reasoningContent: textOrNull(row.reasoning_content),
    model: textOrNull(row.model),
    provider: (textOrNull(row.provider) as ProviderId | null) ?? null,
    createdAt: text(row.created_at),
    status: text(row.status) as MessageStatus,
    attempt: number(row.attempt),
    supersededAt: textOrNull(row.superseded_at),
    errorDetails: textOrNull(row.error_details),
  };
}

function mapTurn(row: Row): StoredTurn {
  return {
    id: text(row.id),
    conversationId: text(row.conversation_id),
    userMessageId: textOrNull(row.user_message_id),
    createdAt: text(row.created_at),
    status: text(row.status) as TurnStatus,
    attemptCount: number(row.attempt_count),
  };
}

function mapPricingSnapshot(row: Row): PricingSnapshot {
  const longJson = textOrNull(row.long_context_json);
  let longContext: (PriceTable & { thresholdTokens: number }) | null = null;
  if (longJson) {
    try {
      longContext = JSON.parse(longJson) as PriceTable & { thresholdTokens: number };
    } catch {
      longContext = null;
    }
  }
  let notes: string[] = [];
  const notesJson = textOrNull(row.notes_json);
  if (notesJson) {
    try {
      const parsed: unknown = JSON.parse(notesJson);
      if (Array.isArray(parsed)) notes = parsed.filter((item): item is string => typeof item === 'string');
    } catch {
      notes = [];
    }
  }
  return {
    id: text(row.id),
    provider: text(row.provider) as ProviderId,
    model: text(row.model),
    pricingVersion: text(row.pricing_version),
    priceSource: text(row.price_source),
    effectiveAt: text(row.effective_at),
    currency: text(row.currency) as Currency,
    billingTier: text(row.billing_tier) as BillingTier,
    table: {
      inputPerM: text(row.input_per_m),
      cachedInputPerM: textOrNull(row.cached_input_per_m),
      cacheWrite30mPerM: textOrNull(row.cache_write_30m_per_m),
      cacheWrite12hPerM: textOrNull(row.cache_write_12h_per_m),
      outputPerM: text(row.output_per_m),
      currency: text(row.currency) as Currency,
    },
    longContext,
    pricingBasis: text(row.pricing_basis),
    isUserOverride: number(row.is_user_override) === 1,
    notes,
  };
}

function mapRequest(row: Row): ApiRequestRecord {
  return {
    id: text(row.id),
    providerRequestId: textOrNull(row.provider_request_id),
    conversationId: text(row.conversation_id),
    turnId: text(row.turn_id),
    assistantMessageId: textOrNull(row.assistant_message_id),
    provider: text(row.provider) as ProviderId,
    model: text(row.model),
    startedAt: text(row.started_at),
    endedAt: textOrNull(row.ended_at),
    status: text(row.status) as RequestStatus,
    requestParameters: textOrNull(row.request_parameters),
    rawUsage: textOrNull(row.raw_usage),
    normalizedUsage: textOrNull(row.normalized_usage),
    pricingSnapshotId: textOrNull(row.pricing_snapshot_id),
    costAmount: textOrNull(row.cost_amount),
    costCurrency: (textOrNull(row.cost_currency) as Currency | null) ?? null,
    costUsd: textOrNull(row.cost_usd),
    exchangeRateSnapshotId: textOrNull(row.exchange_rate_snapshot_id),
    calculationStatus: text(row.calculation_status) as CalculationStatus,
    pricingBasis: textOrNull(row.pricing_basis),
    errorDetails: textOrNull(row.error_details),
  };
}

function summaryFromRow(row: Row, stats: ConversationStats): ConversationSummary {
  return {
    id: text(row.id),
    title: text(row.title),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    archivedAt: textOrNull(row.archived_at),
    defaultProvider: text(row.default_provider) as ProviderId,
    defaultModel: text(row.default_model),
    totalTokens: stats.totalTokens,
    costUsd: stats.costUsd,
    requestCount: stats.requestCount,
    lastMessagePreview: '',
    tokensKnown: stats.tokensUnknownRequestCount === 0,
    unknownCostRequestCount: stats.unknownCostRequestCount,
    costUsdComplete: stats.costUsdComplete,
  };
}

export interface CreateConversationInput {
  title: string;
  provider: ProviderId;
  model: string;
  systemPrompt?: string | null;
  now?: string;
}

export interface NewTurnInput {
  turnId: string;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  content: string;
  provider: ProviderId;
  model: string;
  now: string;
  attempt?: number;
}

export interface RequestStartInput {
  id: string;
  conversationId: string;
  turnId: string;
  assistantMessageId: string;
  provider: ProviderId;
  model: string;
  startedAt: string;
  requestParameters: string;
  pricingSnapshotId: string | null;
  pricingBasis: string | null;
}

export interface RequestFinishInput {
  id: string;
  endedAt: string;
  status: RequestStatus;
  rawUsage: unknown;
  normalizedUsage: NormalizedUsage | null;
  costAmount: string | null;
  costCurrency: Currency | null;
  costUsd: string | null;
  exchangeRateSnapshotId: string | null;
  calculationStatus: CalculationStatus;
  errorDetails: string | null;
  providerRequestId?: string | null;
}

export interface FxSnapshotInput {
  base: 'CNY';
  quote: 'USD';
  rate: string;
  source: string;
  sourceUrl: string;
  effectiveAt: string;
  isUserConfigured: boolean;
}

export interface FxSnapshotRecord extends FxSnapshotInput {
  id: string;
  fetchedAt: string;
}

export interface RecalculationCandidate {
  id: string;
  provider: ProviderId;
  model: string;
  startedAt: string;
  normalizedUsage: string | null;
  pricingSnapshotId: string | null;
  costAmount: string | null;
  costCurrency: Currency | null;
  costUsd: string | null;
  calculationStatus: CalculationStatus;
  pricingBasis: string | null;
  exchangeRateSnapshotId: string | null;
}

export class Store {
  constructor(private readonly database: Database) {}

  get raw(): Database {
    return this.database;
  }

  transaction<T>(fn: () => T): T {
    return this.database.transaction(fn);
  }

  get schemaVersion(): number {
    return this.database.schemaVersion;
  }

  // ---------------------------------------------------------------- settings

  getSettings(): AppSettings {
    const row = this.database.db
      .prepare(`SELECT value FROM settings WHERE key = 'app'`)
      .get() as Row | undefined;
    if (!row) return mergeSettings(null);
    try {
      return mergeSettings(JSON.parse(text(row.value)));
    } catch {
      return mergeSettings(null);
    }
  }

  saveSettings(settings: AppSettings): AppSettings {
    const merged = mergeSettings(settings);
    this.database.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES ('app', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify(merged), new Date().toISOString());
    return merged;
  }

  // ------------------------------------------------------------- conversations

  createConversation(input: CreateConversationInput): Conversation {
    const now = input.now ?? new Date().toISOString();
    const id = newId();
    this.database.db
      .prepare(
        `INSERT INTO conversations
          (id, title, created_at, updated_at, archived_at, deleted_at, default_provider, default_model, system_prompt)
         VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
      )
      .run(
        id,
        input.title.trim().slice(0, 160) || '新对话',
        now,
        now,
        input.provider,
        input.model,
        input.systemPrompt ?? null,
      );
    return this.getConversationOrThrow(id);
  }

  getConversation(id: string): Conversation | null {
    const row = this.database.db
      .prepare(`SELECT * FROM conversations WHERE id = ?`)
      .get(id) as Row | undefined;
    return row ? mapConversation(row) : null;
  }

  getConversationOrThrow(id: string): Conversation {
    const conversation = this.getConversation(id);
    if (!conversation || conversation.deletedAt) throw new Error('会话不存在或已被删除');
    return conversation;
  }

  listConversationRows(includeArchived: boolean): Conversation[] {
    const sql = includeArchived
      ? `SELECT * FROM conversations WHERE deleted_at IS NULL ORDER BY updated_at DESC`
      : `SELECT * FROM conversations WHERE deleted_at IS NULL AND archived_at IS NULL ORDER BY updated_at DESC`;
    return (this.database.db.prepare(sql).all() as Row[]).map(mapConversation);
  }

  listConversations(includeArchived: boolean): ConversationSummary[] {
    const conversations = this.listConversationRows(includeArchived);
    if (conversations.length === 0) return [];
    const statRows = this.loadStatRequests({});
    const grouped = new Map<string, StatRequest[]>();
    for (const row of statRows) {
      const list = grouped.get(row.conversationId) ?? [];
      list.push(row);
      grouped.set(row.conversationId, list);
    }
    const previews = this.lastMessagePreviews();
    return conversations.map((conversation) => {
      const rows = grouped.get(conversation.id) ?? [];
      const stats = buildConversationStats(conversation.id, rows, this.countTurns(conversation.id));
      const summary = summaryFromRow(
        {
          id: conversation.id,
          title: conversation.title,
          created_at: conversation.createdAt,
          updated_at: conversation.updatedAt,
          archived_at: conversation.archivedAt,
          default_provider: conversation.defaultProvider,
          default_model: conversation.defaultModel,
        },
        stats,
      );
      summary.lastMessagePreview = previews.get(conversation.id) ?? '';
      return summary;
    });
  }

  private lastMessagePreviews(): Map<string, string> {
    const rows = this.database.db
      .prepare(
        `SELECT conversation_id, content FROM (
           SELECT conversation_id, content,
                  ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY created_at DESC, rowid DESC) AS rn
           FROM messages
         ) WHERE rn = 1`,
      )
      .all() as Row[];
    const map = new Map<string, string>();
    for (const row of rows) {
      const content = text(row.content).replace(/\s+/g, ' ').trim();
      map.set(text(row.conversation_id), content.slice(0, 120));
    }
    return map;
  }

  countTurns(conversationId: string): number {
    const row = this.database.db
      .prepare(`SELECT COUNT(*) AS c FROM turns WHERE conversation_id = ?`)
      .get(conversationId) as Row | undefined;
    return number(row?.c);
  }

  renameConversation(id: string, title: string): void {
    const now = new Date().toISOString();
    const result = this.database.db
      .prepare(`UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`)
      .run(title.trim().slice(0, 160) || '未命名对话', now, id);
    if (result.changes === 0) throw new Error('会话不存在');
  }

  archiveConversation(id: string, archived: boolean): void {
    const now = new Date().toISOString();
    this.database.db
      .prepare(`UPDATE conversations SET archived_at = ?, updated_at = ? WHERE id = ?`)
      .run(archived ? now : null, now, id);
  }

  softDeleteConversation(id: string): void {
    const now = new Date().toISOString();
    this.database.db
      .prepare(`UPDATE conversations SET deleted_at = ?, archived_at = ?, updated_at = ? WHERE id = ?`)
      .run(now, now, now, id);
  }

  purgeConversation(id: string): void {
    this.database.transaction(() => {
      this.database.db.prepare(`DELETE FROM api_requests WHERE conversation_id = ?`).run(id);
      this.database.db.prepare(`DELETE FROM messages WHERE conversation_id = ?`).run(id);
      this.database.db.prepare(`DELETE FROM turns WHERE conversation_id = ?`).run(id);
      this.database.db.prepare(`DELETE FROM conversations WHERE id = ?`).run(id);
    });
  }

  updateConversationMeta(
    id: string,
    provider: ProviderId,
    model: string,
    now = new Date().toISOString(),
  ): void {
    this.database.db
      .prepare(`UPDATE conversations SET default_provider = ?, default_model = ?, updated_at = ? WHERE id = ?`)
      .run(provider, model, now, id);
  }

  touchConversation(id: string, now = new Date().toISOString()): void {
    this.database.db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(now, id);
  }

  // ------------------------------------------------------------- messages/turns

  createTurn(input: NewTurnInput): { turn: StoredTurn; userMessage: StoredMessage; assistantMessage: StoredMessage } {
    return this.database.transaction(() => {
      const attempt = input.attempt ?? 1;
      this.database.db
        .prepare(
          `INSERT INTO turns (id, conversation_id, user_message_id, created_at, status, attempt_count)
           VALUES (?, ?, ?, ?, 'running', ?)`,
        )
        .run(input.turnId, input.conversationId, input.userMessageId, input.now, attempt);
      this.database.db
        .prepare(
          `INSERT INTO messages
            (id, conversation_id, turn_id, role, content, reasoning_content, model, provider, created_at, status, attempt, superseded_at, error_details)
           VALUES (?, ?, ?, 'user', ?, NULL, ?, ?, ?, 'complete', 1, NULL, NULL)`,
        )
        .run(
          input.userMessageId,
          input.conversationId,
          input.turnId,
          input.content,
          input.model,
          input.provider,
          input.now,
        );
      this.database.db
        .prepare(
          `INSERT INTO messages
            (id, conversation_id, turn_id, role, content, reasoning_content, model, provider, created_at, status, attempt, superseded_at, error_details)
           VALUES (?, ?, ?, 'assistant', '', NULL, ?, ?, ?, 'streaming', ?, NULL, NULL)`,
        )
        .run(
          input.assistantMessageId,
          input.conversationId,
          input.turnId,
          input.model,
          input.provider,
          input.now,
          attempt,
        );
      this.database.db
        .prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`)
        .run(input.now, input.conversationId);
      const turn = this.getTurn(input.turnId);
      const userMessage = this.getMessage(input.userMessageId);
      const assistantMessage = this.getMessage(input.assistantMessageId);
      if (!turn || !userMessage || !assistantMessage) throw new Error('创建对话轮次失败');
      return { turn, userMessage, assistantMessage };
    });
  }

  getTurn(id: string): StoredTurn | null {
    const row = this.database.db.prepare(`SELECT * FROM turns WHERE id = ?`).get(id) as Row | undefined;
    return row ? mapTurn(row) : null;
  }

  getMessage(id: string): StoredMessage | null {
    const row = this.database.db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as Row | undefined;
    return row ? mapMessage(row) : null;
  }

  listMessages(conversationId: string): StoredMessage[] {
    const rows = this.database.db
      .prepare(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC`)
      .all(conversationId) as Row[];
    return rows.map(mapMessage);
  }

  listTurns(conversationId: string): StoredTurn[] {
    const rows = this.database.db
      .prepare(`SELECT * FROM turns WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC`)
      .all(conversationId) as Row[];
    return rows.map(mapTurn);
  }

  listContextMessages(conversationId: string, excludeMessageIds: string[]): StoredMessage[] {
    const rows = this.database.db
      .prepare(
        `SELECT * FROM messages
         WHERE conversation_id = ?
           AND superseded_at IS NULL
           AND role IN ('user','assistant')
           AND (role = 'user' OR status = 'complete')
           AND content <> ''
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(conversationId) as Row[];
    const excluded = new Set(excludeMessageIds);
    return rows.map(mapMessage).filter((message) => !excluded.has(message.id));
  }

  updateAssistantMessage(
    id: string,
    patch: {
      content?: string;
      reasoningContent?: string | null;
      status?: MessageStatus;
      errorDetails?: string | null;
    },
  ): void {
    const current = this.getMessage(id);
    if (!current) return;
    this.database.db
      .prepare(
        `UPDATE messages
         SET content = ?, reasoning_content = ?, status = ?, error_details = ?
         WHERE id = ?`,
      )
      .run(
        patch.content ?? current.content,
        patch.reasoningContent === undefined ? current.reasoningContent : patch.reasoningContent,
        patch.status ?? current.status,
        patch.errorDetails === undefined ? current.errorDetails : patch.errorDetails,
        id,
      );
  }

  supersedeMessage(id: string, now = new Date().toISOString()): void {
    this.database.db
      .prepare(`UPDATE messages SET status = 'superseded', superseded_at = ? WHERE id = ?`)
      .run(now, id);
  }

  setTurnStatus(id: string, status: TurnStatus, attemptCount?: number): void {
    if (attemptCount === undefined) {
      this.database.db.prepare(`UPDATE turns SET status = ? WHERE id = ?`).run(status, id);
    } else {
      this.database.db
        .prepare(`UPDATE turns SET status = ?, attempt_count = ? WHERE id = ?`)
        .run(status, attemptCount, id);
    }
  }

  createAssistantAttempt(input: {
    id: string;
    conversationId: string;
    turnId: string;
    provider: ProviderId;
    model: string;
    attempt: number;
    now: string;
  }): StoredMessage {
    this.database.db
      .prepare(
        `INSERT INTO messages
          (id, conversation_id, turn_id, role, content, reasoning_content, model, provider, created_at, status, attempt, superseded_at, error_details)
         VALUES (?, ?, ?, 'assistant', '', NULL, ?, ?, ?, 'streaming', ?, NULL, NULL)`,
      )
      .run(
        input.id,
        input.conversationId,
        input.turnId,
        input.model,
        input.provider,
        input.now,
        input.attempt,
      );
    const message = this.getMessage(input.id);
    if (!message) throw new Error('创建助手消息失败');
    return message;
  }

  incrementAttempt(turnId: string): number {
    return this.database.transaction(() => {
      this.database.db
        .prepare(`UPDATE turns SET attempt_count = attempt_count + 1, status = 'running' WHERE id = ?`)
        .run(turnId);
      const turn = this.getTurn(turnId);
      return turn?.attemptCount ?? 1;
    });
  }

  // ------------------------------------------------------------------ requests

  insertRequestStart(input: RequestStartInput): void {
    this.database.db
      .prepare(
        `INSERT INTO api_requests
          (id, provider_request_id, conversation_id, turn_id, assistant_message_id, provider, model,
           started_at, ended_at, status, request_parameters, raw_usage, normalized_usage,
           pricing_snapshot_id, cost_amount, cost_currency, cost_usd, exchange_rate_snapshot_id,
           calculation_status, pricing_basis, error_details, created_at)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, NULL, 'streaming', ?, NULL, NULL, ?, NULL, NULL, NULL, NULL, 'unknown', ?, NULL, ?)`,
      )
      .run(
        input.id,
        input.conversationId,
        input.turnId,
        input.assistantMessageId,
        input.provider,
        input.model,
        input.startedAt,
        input.requestParameters,
        input.pricingSnapshotId,
        input.pricingBasis,
        input.startedAt,
      );
  }

  finishRequest(input: RequestFinishInput): void {
    this.database.db
      .prepare(
        `UPDATE api_requests SET
           ended_at = ?, status = ?, raw_usage = ?, normalized_usage = ?,
           cost_amount = ?, cost_currency = ?, cost_usd = ?, exchange_rate_snapshot_id = ?,
           calculation_status = ?, error_details = ?,
           provider_request_id = COALESCE(?, provider_request_id)
         WHERE id = ?`,
      )
      .run(
        input.endedAt,
        input.status,
        input.rawUsage === null || input.rawUsage === undefined ? null : JSON.stringify(input.rawUsage),
        input.normalizedUsage === null ? null : JSON.stringify(input.normalizedUsage),
        input.costAmount,
        input.costCurrency,
        input.costUsd,
        input.exchangeRateSnapshotId,
        input.calculationStatus,
        input.errorDetails,
        input.providerRequestId ?? null,
        input.id,
      );
  }

  getRequest(id: string): ApiRequestRecord | null {
    const row = this.database.db.prepare(`SELECT * FROM api_requests WHERE id = ?`).get(id) as Row | undefined;
    return row ? mapRequest(row) : null;
  }

  listRequestsForTurn(turnId: string): ApiRequestRow[] {
    const rows = this.database.db
      .prepare(
        `SELECT r.*, ps.pricing_version
         FROM api_requests r
         LEFT JOIN pricing_snapshots ps ON ps.id = r.pricing_snapshot_id
         WHERE r.turn_id = ?
         ORDER BY r.started_at ASC, r.rowid ASC`,
      )
      .all(turnId) as Row[];
    return rows.map((row) => this.mapApiRequestRow(row));
  }

  private mapApiRequestRow(row: Row): ApiRequestRow {
    const usage = parseStoredUsage(textOrNull(row.normalized_usage));
    return {
      id: text(row.id),
      provider: text(row.provider) as ProviderId,
      model: text(row.model),
      startedAt: text(row.started_at),
      status: text(row.status) as RequestStatus,
      inputTokens: usage?.inputTokens ?? null,
      cacheReadTokens: usage?.cacheReadTokens ?? null,
      cacheWriteTokens: usage?.cacheWriteTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      totalTokens:
        usage?.totalTokens ??
        (usage?.inputTokens !== null && usage?.outputTokens !== null
          ? (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)
          : null),
      costAmount: textOrNull(row.cost_amount),
      costCurrency: (textOrNull(row.cost_currency) as Currency | null) ?? null,
      costUsd: textOrNull(row.cost_usd),
      calculationStatus: text(row.calculation_status) as CalculationStatus,
      errorDetails: textOrNull(row.error_details),
      pricingSnapshotId: textOrNull(row.pricing_snapshot_id),
      pricingVersion: textOrNull(row.pricing_version),
      pricingBasis: textOrNull(row.pricing_basis),
    };
  }

  markInterrupted(now = new Date().toISOString()): { requests: number; messages: number; turns: number } {
    return this.database.transaction(() => {
      const requests = this.database.db
        .prepare(
          `UPDATE api_requests
           SET status = 'interrupted',
               ended_at = COALESCE(ended_at, ?),
               calculation_status = CASE WHEN normalized_usage IS NULL THEN 'unknown' ELSE calculation_status END,
               error_details = COALESCE(error_details, '应用意外退出或请求中断，未收到最终 usage')
           WHERE status = 'streaming'`,
        )
        .run(now);
      const messages = this.database.db
        .prepare(
          `UPDATE messages
           SET status = 'error',
               error_details = COALESCE(error_details, '应用意外退出或请求中断，已保留已收到的内容')
           WHERE status = 'streaming'`,
        )
        .run();
      const turns = this.database.db
        .prepare(`UPDATE turns SET status = 'interrupted' WHERE status = 'running'`)
        .run();
      return {
        requests: Number(requests.changes),
        messages: Number(messages.changes),
        turns: Number(turns.changes),
      };
    });
  }

  // ------------------------------------------------------------- pricing / fx

  insertPricingSnapshot(snapshot: PricingSnapshot, createdAt = new Date().toISOString()): void {
    this.database.db
      .prepare(
        `INSERT INTO pricing_snapshots
          (id, provider, model, pricing_version, price_source, effective_at, currency, billing_tier,
           input_per_m, cached_input_per_m, cache_write_30m_per_m, cache_write_12h_per_m, output_per_m,
           long_context_json, pricing_basis, is_user_override, notes_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshot.id,
        snapshot.provider,
        snapshot.model,
        snapshot.pricingVersion,
        snapshot.priceSource,
        snapshot.effectiveAt,
        snapshot.currency,
        snapshot.billingTier,
        snapshot.table.inputPerM,
        snapshot.table.cachedInputPerM,
        snapshot.table.cacheWrite30mPerM,
        snapshot.table.cacheWrite12hPerM,
        snapshot.table.outputPerM,
        snapshot.longContext ? JSON.stringify(snapshot.longContext) : null,
        snapshot.pricingBasis,
        snapshot.isUserOverride ? 1 : 0,
        JSON.stringify(snapshot.notes),
        createdAt,
      );
  }

  getPricingSnapshot(id: string): PricingSnapshot | null {
    const row = this.database.db.prepare(`SELECT * FROM pricing_snapshots WHERE id = ?`).get(id) as Row | undefined;
    return row ? mapPricingSnapshot(row) : null;
  }

  insertFxSnapshot(input: FxSnapshotInput): FxSnapshotRecord {
    const id = newId();
    const fetchedAt = new Date().toISOString();
    this.database.db
      .prepare(
        `INSERT INTO exchange_rate_snapshots
          (id, base, quote, rate, source, source_url, effective_at, fetched_at, is_user_configured)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.base,
        input.quote,
        input.rate,
        input.source,
        input.sourceUrl,
        input.effectiveAt,
        fetchedAt,
        input.isUserConfigured ? 1 : 0,
      );
    return { ...input, id, fetchedAt };
  }

  getLatestFxSnapshot(): FxSnapshotRecord | null {
    const row = this.database.db
      .prepare(`SELECT * FROM exchange_rate_snapshots ORDER BY fetched_at DESC, rowid DESC LIMIT 1`)
      .get() as Row | undefined;
    if (!row) return null;
    return {
      id: text(row.id),
      base: 'CNY',
      quote: 'USD',
      rate: text(row.rate),
      source: text(row.source),
      sourceUrl: text(row.source_url),
      effectiveAt: text(row.effective_at),
      fetchedAt: text(row.fetched_at),
      isUserConfigured: number(row.is_user_configured) === 1,
    };
  }

  getFxSnapshotById(id: string): FxSnapshotRecord | null {
    const row = this.database.db
      .prepare(`SELECT * FROM exchange_rate_snapshots WHERE id = ?`)
      .get(id) as Row | undefined;
    if (!row) return null;
    return {
      id: text(row.id),
      base: 'CNY',
      quote: 'USD',
      rate: text(row.rate),
      source: text(row.source),
      sourceUrl: text(row.source_url),
      effectiveAt: text(row.effective_at),
      fetchedAt: text(row.fetched_at),
      isUserConfigured: number(row.is_user_configured) === 1,
    };
  }

  listRecalculationCandidates(): RecalculationCandidate[] {
    const rows = this.database.db
      .prepare(
        `SELECT id, provider, model, started_at, normalized_usage, pricing_snapshot_id,
                cost_amount, cost_currency, cost_usd, calculation_status, pricing_basis,
                exchange_rate_snapshot_id
         FROM api_requests
         WHERE normalized_usage IS NOT NULL
         ORDER BY started_at ASC`,
      )
      .all() as Row[];
    return rows.map((row) => ({
      id: text(row.id),
      provider: text(row.provider) as ProviderId,
      model: text(row.model),
      startedAt: text(row.started_at),
      normalizedUsage: textOrNull(row.normalized_usage),
      pricingSnapshotId: textOrNull(row.pricing_snapshot_id),
      costAmount: textOrNull(row.cost_amount),
      costCurrency: (textOrNull(row.cost_currency) as Currency | null) ?? null,
      costUsd: textOrNull(row.cost_usd),
      calculationStatus: text(row.calculation_status) as CalculationStatus,
      pricingBasis: textOrNull(row.pricing_basis),
      exchangeRateSnapshotId: textOrNull(row.exchange_rate_snapshot_id),
    }));
  }

  updateRequestCost(
    id: string,
    fields: {
      costAmount: string | null;
      costCurrency: Currency | null;
      costUsd: string | null;
      exchangeRateSnapshotId: string | null;
      calculationStatus: CalculationStatus;
      pricingSnapshotId: string | null;
      pricingBasis: string | null;
    },
  ): void {
    this.database.db
      .prepare(
        `UPDATE api_requests SET
           cost_amount = ?, cost_currency = ?, cost_usd = ?, exchange_rate_snapshot_id = ?,
           calculation_status = ?, pricing_snapshot_id = ?, pricing_basis = ?
         WHERE id = ?`,
      )
      .run(
        fields.costAmount,
        fields.costCurrency,
        fields.costUsd,
        fields.exchangeRateSnapshotId,
        fields.calculationStatus,
        fields.pricingSnapshotId,
        fields.pricingBasis,
        id,
      );
  }

  insertRecalculationLog(entry: {
    requestId: string;
    oldPricingSnapshotId: string | null;
    newPricingSnapshotId: string | null;
    oldCostAmount: string | null;
    oldCostCurrency: Currency | null;
    oldCostUsd: string | null;
    newCostAmount: string | null;
    newCostCurrency: Currency | null;
    newCostUsd: string | null;
    reason: string;
  }): void {
    this.database.db
      .prepare(
        `INSERT INTO cost_recalculation_log
          (id, request_id, old_pricing_snapshot_id, new_pricing_snapshot_id, old_cost_amount,
           old_cost_currency, old_cost_usd, new_cost_amount, new_cost_currency, new_cost_usd,
           reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId(),
        entry.requestId,
        entry.oldPricingSnapshotId,
        entry.newPricingSnapshotId,
        entry.oldCostAmount,
        entry.oldCostCurrency,
        entry.oldCostUsd,
        entry.newCostAmount,
        entry.newCostCurrency,
        entry.newCostUsd,
        entry.reason,
        new Date().toISOString(),
      );
  }

  listRecalculationLog(): {
    requestId: string;
    oldCostAmount: string | null;
    newCostAmount: string | null;
    oldPricingSnapshotId: string | null;
    newPricingSnapshotId: string | null;
    reason: string;
    createdAt: string;
  }[] {
    const rows = this.database.db
      .prepare(`SELECT * FROM cost_recalculation_log ORDER BY created_at DESC`)
      .all() as Row[];
    return rows.map((row) => ({
      requestId: text(row.request_id),
      oldCostAmount: textOrNull(row.old_cost_amount),
      newCostAmount: textOrNull(row.new_cost_amount),
      oldPricingSnapshotId: textOrNull(row.old_pricing_snapshot_id),
      newPricingSnapshotId: textOrNull(row.new_pricing_snapshot_id),
      reason: text(row.reason),
      createdAt: text(row.created_at),
    }));
  }

  listPriceOverrides(): PriceOverrideRow[] {
    const rows = this.database.db
      .prepare(`SELECT * FROM price_overrides ORDER BY provider ASC, model ASC`)
      .all() as Row[];
    return rows.map((row) => ({
      provider: text(row.provider) as ProviderId,
      model: text(row.model),
      inputPerM: textOrNull(row.input_per_m),
      cachedInputPerM: textOrNull(row.cached_input_per_m),
      cacheWrite30mPerM: textOrNull(row.cache_write_30m_per_m),
      cacheWrite12hPerM: textOrNull(row.cache_write_12h_per_m),
      outputPerM: textOrNull(row.output_per_m),
      offPeakInputPerM: textOrNull(row.off_peak_input_per_m),
      offPeakCachedInputPerM: textOrNull(row.off_peak_cached_input_per_m),
      offPeakOutputPerM: textOrNull(row.off_peak_output_per_m),
      currency: (textOrNull(row.currency) as Currency | null) ?? null,
      sourceUrl: textOrNull(row.source_url),
      effectiveFrom: text(row.effective_from),
      notes: textOrNull(row.notes),
      createdAt: text(row.created_at),
    }));
  }

  upsertPriceOverride(override: PriceOverrideRow): void {
    this.database.db
      .prepare(
        `INSERT INTO price_overrides
          (provider, model, input_per_m, cached_input_per_m, cache_write_30m_per_m, cache_write_12h_per_m,
           output_per_m, off_peak_input_per_m, off_peak_cached_input_per_m, off_peak_output_per_m,
           currency, source_url, effective_from, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, model) DO UPDATE SET
           input_per_m = excluded.input_per_m,
           cached_input_per_m = excluded.cached_input_per_m,
           cache_write_30m_per_m = excluded.cache_write_30m_per_m,
           cache_write_12h_per_m = excluded.cache_write_12h_per_m,
           output_per_m = excluded.output_per_m,
           off_peak_input_per_m = excluded.off_peak_input_per_m,
           off_peak_cached_input_per_m = excluded.off_peak_cached_input_per_m,
           off_peak_output_per_m = excluded.off_peak_output_per_m,
           currency = excluded.currency,
           source_url = excluded.source_url,
           effective_from = excluded.effective_from,
           notes = excluded.notes,
           created_at = excluded.created_at`,
      )
      .run(
        override.provider,
        override.model,
        override.inputPerM,
        override.cachedInputPerM,
        override.cacheWrite30mPerM,
        override.cacheWrite12hPerM,
        override.outputPerM,
        override.offPeakInputPerM,
        override.offPeakCachedInputPerM,
        override.offPeakOutputPerM,
        override.currency,
        override.sourceUrl,
        override.effectiveFrom,
        override.notes,
        new Date().toISOString(),
      );
  }

  deletePriceOverride(provider: ProviderId, model: string): void {
    this.database.db
      .prepare(`DELETE FROM price_overrides WHERE provider = ? AND model = ?`)
      .run(provider, model);
  }

  listHolidayOverrides(): HolidayOverride[] {
    const rows = this.database.db
      .prepare(`SELECT * FROM holiday_overrides ORDER BY date ASC`)
      .all() as Row[];
    return rows.map((row) => ({
      date: text(row.date),
      name: text(row.name),
      action: text(row.action) as 'add' | 'remove',
    }));
  }

  replaceHolidayOverrides(overrides: HolidayOverride[]): void {
    this.database.transaction(() => {
      this.database.db.prepare(`DELETE FROM holiday_overrides`).run();
      const insert = this.database.db.prepare(
        `INSERT INTO holiday_overrides (date, name, action, note, created_at) VALUES (?, ?, ?, NULL, ?)`,
      );
      const now = new Date().toISOString();
      for (const entry of overrides) {
        insert.run(entry.date, entry.name, entry.action, now);
      }
    });
  }

  // --------------------------------------------------------------------- stats

  loadStatRequests(options: {
    conversationId?: string;
    from?: string | null;
    to?: string | null;
    provider?: ProviderId | null;
    model?: string | null;
  }): StatRequest[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.conversationId) {
      clauses.push('r.conversation_id = ?');
      params.push(options.conversationId);
    }
    if (options.from) {
      clauses.push('r.started_at >= ?');
      params.push(options.from);
    }
    if (options.to) {
      clauses.push('r.started_at < ?');
      params.push(options.to);
    }
    if (options.provider) {
      clauses.push('r.provider = ?');
      params.push(options.provider);
    }
    if (options.model) {
      clauses.push('r.model = ?');
      params.push(options.model);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.database.db
      .prepare(
        `SELECT r.id, r.conversation_id, c.title AS conversation_title, r.turn_id, r.provider, r.model,
                r.started_at, r.status, r.normalized_usage, r.cost_amount, r.cost_currency, r.cost_usd,
                r.calculation_status, r.pricing_snapshot_id, ps.pricing_version, r.pricing_basis, r.error_details
         FROM api_requests r
         JOIN conversations c ON c.id = r.conversation_id
         LEFT JOIN pricing_snapshots ps ON ps.id = r.pricing_snapshot_id
         ${where}
         ORDER BY r.started_at ASC, r.rowid ASC`,
      )
      .all(...params) as Row[];
    return rows.map((row) => ({
      id: text(row.id),
      conversationId: text(row.conversation_id),
      conversationTitle: text(row.conversation_title),
      turnId: text(row.turn_id),
      provider: text(row.provider) as ProviderId,
      model: text(row.model),
      startedAt: text(row.started_at),
      status: text(row.status) as RequestStatus,
      usage: parseStoredUsage(textOrNull(row.normalized_usage)),
      costAmount: textOrNull(row.cost_amount),
      costCurrency: (textOrNull(row.cost_currency) as Currency | null) ?? null,
      costUsd: textOrNull(row.cost_usd),
      calculationStatus: text(row.calculation_status) as CalculationStatus,
      pricingSnapshotId: textOrNull(row.pricing_snapshot_id),
      pricingVersion: textOrNull(row.pricing_version),
      pricingBasis: textOrNull(row.pricing_basis),
      errorDetails: textOrNull(row.error_details),
    }));
  }

  getGlobalStats(
    from: string | null,
    to: string | null,
    provider: ProviderId | null = null,
    model: string | null = null,
  ): GlobalStats {
    const rows = this.loadStatRequests({ from, to, provider, model });
    const conversationIds = new Set(rows.map((row) => row.conversationId));
    return buildGlobalStats(rows, { from, to, conversationCount: conversationIds.size });
  }

  getConversationStats(conversationId: string): ConversationStats {
    const rows = this.loadStatRequests({ conversationId });
    return buildConversationStats(conversationId, rows, this.countTurns(conversationId));
  }

  getTurnView(turnId: string): TurnView | null {
    const turn = this.getTurn(turnId);
    if (!turn) return null;
    return this.buildTurnView(turn, this.listMessages(turn.conversationId), this.listRequestsForTurn(turnId), this.loadStatRequests({ conversationId: turn.conversationId }).filter((row) => row.turnId === turnId));
  }

  private buildTurnView(
    turn: StoredTurn,
    messages: StoredMessage[],
    requests: ApiRequestRow[],
    statRows: StatRequest[],
  ): TurnView {
    const userMessage = messages.find((message) => message.id === turn.userMessageId) ?? null;
    const assistantMessages = messages
      .filter((message) => message.turnId === turn.id && message.role === 'assistant')
      .sort((a, b) => a.attempt - b.attempt);
    const totals = aggregateTotals(statRows);
    const calculationStatus: CalculationStatus =
      requests.length === 0
        ? 'unknown'
        : requests.some((request) => request.calculationStatus === 'unknown')
          ? 'unknown'
          : requests.some((request) => request.calculationStatus === 'partial')
            ? 'partial'
            : 'calculated';
    return {
      turn,
      userMessage,
      assistantMessages,
      requests,
      stats: {
        requestCount: requests.length,
        inputTokens: totals.inputTokens,
        cacheReadTokens: totals.cacheReadTokens,
        cacheWriteTokens: totals.cacheWriteTokens,
        outputTokens: totals.outputTokens,
        reasoningTokens: totals.reasoningTokens,
        totalTokens: totals.totalTokens,
        tokensUnknown: totals.tokensUnknownRequestCount > 0,
        costUsd: toDecimalString(totals.costUsd),
        nativeCosts: [...totals.nativeCosts.entries()].map(([currency, value]) => ({
          currency,
          amount: toDecimalString(value.amount),
          requestCount: value.requestCount,
        })),
        calculationStatus,
      },
    };
  }

  getConversationDetail(conversationId: string): ConversationDetail {
    const conversation = this.getConversationOrThrow(conversationId);
    const turns = this.listTurns(conversationId);
    const messages = this.listMessages(conversationId);
    const statRows = this.loadStatRequests({ conversationId });
    const stats = buildConversationStats(conversationId, statRows, turns.length);
    const turnViews = turns.map((turn) =>
      this.buildTurnView(
        turn,
        messages,
        this.listRequestsForTurn(turn.id),
        statRows.filter((row) => row.turnId === turn.id),
      ),
    );
    return { conversation, turns: turnViews, stats };
  }

  getRecentRequests(limit: number): ApiRequestRow[] {
    const rows = this.database.db
      .prepare(
        `SELECT r.*, ps.pricing_version
         FROM api_requests r
         LEFT JOIN pricing_snapshots ps ON ps.id = r.pricing_snapshot_id
         ORDER BY r.started_at DESC, r.rowid DESC
         LIMIT ?`,
      )
      .all(Math.max(1, Math.min(500, limit))) as Row[];
    return rows.map((row) => this.mapApiRequestRow(row));
  }

  countRequests(): number {
    const row = this.database.db.prepare(`SELECT COUNT(*) AS c FROM api_requests`).get() as Row | undefined;
    return number(row?.c);
  }

  countConversations(): number {
    const row = this.database.db
      .prepare(`SELECT COUNT(*) AS c FROM conversations WHERE deleted_at IS NULL`)
      .get() as Row | undefined;
    return number(row?.c);
  }

  // ------------------------------------------------------------ export/backup

  dumpAll(): Record<string, Row[]> {
    const tables = [
      'conversations',
      'turns',
      'messages',
      'pricing_snapshots',
      'exchange_rate_snapshots',
      'api_requests',
      'cost_recalculation_log',
      'price_overrides',
      'holiday_overrides',
      'settings',
    ];
    const result: Record<string, Row[]> = {};
    for (const table of tables) {
      result[table] = this.database.db.prepare(`SELECT * FROM ${table}`).all() as Row[];
    }
    return result;
  }

  restoreAll(tables: Record<string, Row[]>): void {
    const allowed = new Set([
      'conversations',
      'turns',
      'messages',
      'pricing_snapshots',
      'exchange_rate_snapshots',
      'api_requests',
      'cost_recalculation_log',
      'price_overrides',
      'holiday_overrides',
      'settings',
    ]);
    for (const table of Object.keys(tables)) {
      if (!allowed.has(table)) throw new Error(`备份中包含未知数据表：${table}`);
    }
    this.database.transaction(() => {
      const deleteOrder = [
        'api_requests',
        'cost_recalculation_log',
        'messages',
        'turns',
        'conversations',
        'pricing_snapshots',
        'exchange_rate_snapshots',
        'price_overrides',
        'holiday_overrides',
        'settings',
      ];
      for (const table of deleteOrder) {
        this.database.db.prepare(`DELETE FROM ${table}`).run();
      }
      const insertOrder = [
        'conversations',
        'pricing_snapshots',
        'exchange_rate_snapshots',
        'turns',
        'messages',
        'api_requests',
        'cost_recalculation_log',
        'price_overrides',
        'holiday_overrides',
        'settings',
      ];
      for (const table of insertOrder) {
        const rows = tables[table] ?? [];
        if (rows.length === 0) continue;
        const allowedColumns = new Set(
          (this.database.db.prepare(`PRAGMA table_info("${table}")`).all() as Row[]).map((row) =>
            text(row.name),
          ),
        );
        const columnSet = new Set<string>();
        for (const row of rows) {
          for (const [column, value] of Object.entries(row)) {
            if (!allowedColumns.has(column)) {
              throw new Error(`备份包含未知字段：${table}.${column}`);
            }
            if (value !== null && typeof value !== 'string' && typeof value !== 'number') {
              throw new Error(`备份字段类型无效：${table}.${column}`);
            }
            columnSet.add(column);
          }
        }
        const columns = [...columnSet];
        if (columns.length === 0) continue;
        const statement = this.database.db.prepare(
          `INSERT INTO ${table} (${columns.map((column) => `"${column}"`).join(', ')})
           VALUES (${columns.map(() => '?').join(', ')})`,
        );
        for (const row of rows) {
          statement.run(
            ...columns.map((column) =>
              row[column] === undefined ? null : (row[column] as string | number | null),
            ),
          );
        }
      }
    });
  }

  deleteAllData(): void {
    this.database.transaction(() => {
      this.database.db.prepare(`DELETE FROM api_requests`).run();
      this.database.db.prepare(`DELETE FROM cost_recalculation_log`).run();
      this.database.db.prepare(`DELETE FROM messages`).run();
      this.database.db.prepare(`DELETE FROM turns`).run();
      this.database.db.prepare(`DELETE FROM conversations`).run();
      this.database.db.prepare(`DELETE FROM pricing_snapshots`).run();
      this.database.db.prepare(`DELETE FROM exchange_rate_snapshots`).run();
    });
  }

  // Used by export/backup helpers.
  listAllConversations(): Conversation[] {
    return (this.database.db.prepare(`SELECT * FROM conversations ORDER BY created_at ASC`).all() as Row[]).map(
      mapConversation,
    );
  }
}
