import { DatabaseSync } from 'node:sqlite';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        deleted_at TEXT,
        default_provider TEXT NOT NULL CHECK (default_provider IN ('openai','deepseek')),
        default_model TEXT NOT NULL,
        system_prompt TEXT
      );

      CREATE TABLE turns (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        user_message_id TEXT,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
        role TEXT NOT NULL CHECK (role IN ('system','user','assistant')),
        content TEXT NOT NULL,
        reasoning_content TEXT,
        model TEXT,
        provider TEXT,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 1,
        superseded_at TEXT,
        error_details TEXT
      );

      CREATE TABLE pricing_snapshots (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        pricing_version TEXT NOT NULL,
        price_source TEXT NOT NULL,
        effective_at TEXT NOT NULL,
        currency TEXT NOT NULL,
        billing_tier TEXT NOT NULL,
        input_per_m TEXT NOT NULL,
        cached_input_per_m TEXT,
        cache_write_30m_per_m TEXT,
        cache_write_12h_per_m TEXT,
        output_per_m TEXT NOT NULL,
        long_context_json TEXT,
        pricing_basis TEXT NOT NULL,
        is_user_override INTEGER NOT NULL DEFAULT 0,
        notes_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE exchange_rate_snapshots (
        id TEXT PRIMARY KEY,
        base TEXT NOT NULL,
        quote TEXT NOT NULL,
        rate TEXT NOT NULL,
        source TEXT NOT NULL,
        source_url TEXT,
        effective_at TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        is_user_configured INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE api_requests (
        id TEXT PRIMARY KEY,
        provider_request_id TEXT,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        assistant_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        status TEXT NOT NULL,
        request_parameters TEXT,
        raw_usage TEXT,
        normalized_usage TEXT,
        pricing_snapshot_id TEXT REFERENCES pricing_snapshots(id) ON DELETE SET NULL,
        cost_amount TEXT,
        cost_currency TEXT,
        cost_usd TEXT,
        exchange_rate_snapshot_id TEXT REFERENCES exchange_rate_snapshots(id) ON DELETE SET NULL,
        calculation_status TEXT NOT NULL,
        pricing_basis TEXT,
        error_details TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE cost_recalculation_log (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        old_pricing_snapshot_id TEXT,
        new_pricing_snapshot_id TEXT,
        old_cost_amount TEXT,
        old_cost_currency TEXT,
        old_cost_usd TEXT,
        new_cost_amount TEXT,
        new_cost_currency TEXT,
        new_cost_usd TEXT,
        reason TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE price_overrides (
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_per_m TEXT,
        cached_input_per_m TEXT,
        cache_write_30m_per_m TEXT,
        cache_write_12h_per_m TEXT,
        output_per_m TEXT,
        off_peak_input_per_m TEXT,
        off_peak_cached_input_per_m TEXT,
        off_peak_output_per_m TEXT,
        currency TEXT,
        source_url TEXT,
        effective_from TEXT NOT NULL,
        notes TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (provider, model)
      );

      CREATE TABLE holiday_overrides (
        date TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('add','remove')),
        note TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX idx_conversations_updated ON conversations(updated_at DESC);
      CREATE INDEX idx_conversations_deleted ON conversations(deleted_at);
      CREATE INDEX idx_turns_conversation ON turns(conversation_id, created_at);
      CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);
      CREATE INDEX idx_messages_turn ON messages(turn_id);
      CREATE INDEX idx_requests_conversation ON api_requests(conversation_id, started_at);
      CREATE INDEX idx_requests_turn ON api_requests(turn_id);
      CREATE INDEX idx_requests_started ON api_requests(started_at);
      CREATE INDEX idx_requests_status ON api_requests(status);
      CREATE INDEX idx_fx_fetched ON exchange_rate_snapshots(fetched_at DESC);
    `,
  },
];

export class Database {
  readonly db: DatabaseSync;
  private txDepth = 0;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    if (path !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA synchronous = NORMAL;');
    }
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const applied = new Set(
      this.db
        .prepare('SELECT version FROM schema_migrations')
        .all()
        .map((row) => Number((row as { version: number }).version)),
    );
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      this.transaction(() => {
        this.db.exec(migration.sql);
        this.db
          .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(migration.version, migration.name, new Date().toISOString());
      });
    }
  }

  get schemaVersion(): number {
    const row = this.db
      .prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get() as { version: number | null } | undefined;
    return row?.version ?? 0;
  }

  transaction<T>(fn: () => T): T {
    const isOuter = this.txDepth === 0;
    const savepoint = `sp_${this.txDepth}`;
    if (isOuter) this.db.exec('BEGIN IMMEDIATE;');
    else this.db.exec(`SAVEPOINT ${savepoint};`);
    this.txDepth += 1;
    try {
      const result = fn();
      this.txDepth -= 1;
      if (isOuter) this.db.exec('COMMIT;');
      else this.db.exec(`RELEASE ${savepoint};`);
      return result;
    } catch (error) {
      this.txDepth -= 1;
      try {
        if (isOuter) this.db.exec('ROLLBACK;');
        else this.db.exec(`ROLLBACK TO ${savepoint};`);
      } catch {
        // 回滚失败时保留原始错误。
      }
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
