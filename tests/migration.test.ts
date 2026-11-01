import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { Database, MIGRATIONS } from '../src/main/db/database';
import { Store } from '../src/main/db/repositories';
import { backupBeforeMigration } from '../src/main/db/pre-migration';

describe('SQLite v1 → v2 升级', () => {
  it('保留旧会话、旧请求与旧费用，并标记为 chat/legacy', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenledger-migration-'));
    const dbPath = path.join(dir, 'legacy.db');
    const raw = new DatabaseSync(dbPath);
    raw.exec('PRAGMA foreign_keys = ON;');
    raw.exec(MIGRATIONS[0].sql);
    raw.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations (version, name, applied_at)
      VALUES (1, 'initial_schema', '2026-01-01T00:00:00.000Z');
    `);

    const conversationId = 'conv_legacy';
    const turnId = 'turn_legacy';
    const userId = 'msg_user_legacy';
    const assistantId = 'msg_assistant_legacy';
    const requestId = 'req_legacy';
    raw.prepare(
      `INSERT INTO conversations
        (id, title, created_at, updated_at, archived_at, deleted_at, default_provider, default_model, system_prompt)
       VALUES (?, ?, ?, ?, NULL, NULL, 'openai', 'gpt-6.1-sol', NULL)`,
    ).run(conversationId, '旧版会话标题', '2026-01-02T00:00:00.000Z', '2026-01-02T00:10:00.000Z');
    raw.prepare(
      `INSERT INTO turns (id, conversation_id, user_message_id, created_at, status, attempt_count)
       VALUES (?, ?, ?, ?, 'completed', 1)`,
    ).run(turnId, conversationId, userId, '2026-01-02T00:00:00.000Z');
    raw.prepare(
      `INSERT INTO messages
        (id, conversation_id, turn_id, role, content, reasoning_content, model, provider, created_at, status, attempt, superseded_at, error_details)
       VALUES (?, ?, ?, 'user', '旧问题', NULL, 'gpt-6.1-sol', 'openai', ?, 'complete', 1, NULL, NULL)`,
    ).run(userId, conversationId, turnId, '2026-01-02T00:00:00.000Z');
    raw.prepare(
      `INSERT INTO messages
        (id, conversation_id, turn_id, role, content, reasoning_content, model, provider, created_at, status, attempt, superseded_at, error_details)
       VALUES (?, ?, ?, 'assistant', '旧回答', NULL, 'gpt-6.1-sol', 'openai', ?, 'complete', 1, NULL, NULL)`,
    ).run(assistantId, conversationId, turnId, '2026-01-02T00:00:01.000Z');
    raw.prepare(
      `INSERT INTO api_requests
        (id, provider_request_id, conversation_id, turn_id, assistant_message_id, provider, model,
         started_at, ended_at, status, request_parameters, raw_usage, normalized_usage,
         pricing_snapshot_id, cost_amount, cost_currency, cost_usd, exchange_rate_snapshot_id,
         calculation_status, pricing_basis, error_details, created_at)
       VALUES (?, NULL, ?, ?, ?, 'openai', 'gpt-6.1-sol', ?, ?, 'completed', '{}',
         '{"input_tokens":100,"output_tokens":10}', '{"inputTokens":100,"outputTokens":10}',
         NULL, '0.0003', 'USD', '0.0003', NULL, 'calculated', '旧版价格', NULL, ?)`,
    ).run(
      requestId,
      conversationId,
      turnId,
      assistantId,
      '2026-01-02T00:00:00.000Z',
      '2026-01-02T00:00:01.000Z',
      '2026-01-02T00:00:00.000Z',
    );
    raw.close();

    const backup = backupBeforeMigration(dbPath, path.join(dir, 'backups'))!;
    expect(backup.fromVersion).toBe(1);
    expect(fs.existsSync(backup.backupPath)).toBe(true);

    const backupRaw = new DatabaseSync(backup.backupPath);
    const backupVersion = backupRaw
      .prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get() as { version: number };
    expect(backupVersion.version).toBe(1);
    const backupColumns = backupRaw
      .prepare('PRAGMA table_info(conversations)')
      .all()
      .map((row) => (row as { name: string }).name);
    expect(backupColumns).not.toContain('title_source');
    const backupRequestColumns = backupRaw
      .prepare('PRAGMA table_info(api_requests)')
      .all()
      .map((row) => (row as { name: string }).name);
    expect(backupRequestColumns).not.toContain('request_purpose');
    backupRaw.close();

    const db = new Database(dbPath);
    const store = new Store(db);
    expect(db.schemaVersion).toBe(2);

    const conversation = store.getConversation(conversationId)!;
    expect(conversation.title).toBe('旧版会话标题');
    expect(conversation.titleSource).toBe('first_message');
    expect(conversation.autoTitleAttemptedAt).not.toBeNull();

    const request = store.getRequest(requestId)!;
    expect(request.requestPurpose).toBe('chat');
    expect(request.turnId).toBe(turnId);
    expect(request.costAmount).toBe('0.0003');
    expect(store.getConversationStats(conversationId).costUsd).toBe('0.0003');
    expect(store.getGlobalStats(null, null).requestCount).toBe(1);

    const fresh = store.createConversation({
      title: '升级后的新会话',
      provider: 'openai',
      model: 'gpt-6.1-sol',
    });
    expect(fresh.titleSource).toBe('default');
    expect(fresh.autoTitleAttemptedAt).toBeNull();

    db.close();

    // 用迁移前备份恢复：备份本身可被新版本正常升级并保留旧账。
    const restoredPath = path.join(dir, 'restored.db');
    fs.copyFileSync(backup.backupPath, restoredPath);
    const restored = new Database(restoredPath);
    const restoredStore = new Store(restored);
    expect(restored.schemaVersion).toBe(2);
    expect(restoredStore.getConversation(conversationId)?.title).toBe('旧版会话标题');
    expect(restoredStore.getRequest(requestId)?.costAmount).toBe('0.0003');
    restored.close();

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
