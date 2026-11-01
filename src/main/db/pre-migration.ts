import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LATEST_SCHEMA_VERSION } from './database';

export interface PreMigrationBackup {
  backupPath: string;
  fromVersion: number;
}

/**
 * 在迁移前用 VACUUM INTO 生成一致性快照（包含 WAL 中已提交的数据）。
 * 仅当现有数据库版本低于目标版本时创建；全新的空库不备份。
 */
export function backupBeforeMigration(
  dbPath: string,
  backupDir: string,
  latestVersion = LATEST_SCHEMA_VERSION,
): PreMigrationBackup | null {
  if (!fs.existsSync(dbPath)) return null;
  const raw = new DatabaseSync(dbPath);
  try {
    let version = 0;
    try {
      const row = raw.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as
        | { version: number | null }
        | undefined;
      version = row?.version ?? 0;
    } catch {
      version = 0;
    }
    if (version <= 0 || version >= latestVersion) return null;
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, `pre-migration-v${version}-${stamp}.db`);
    raw.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    return { backupPath, fromVersion: version };
  } finally {
    raw.close();
  }
}
