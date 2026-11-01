import fs from 'node:fs';
import path from 'node:path';
import { app, dialog, type BrowserWindow } from 'electron';
import type { BackupResult, RestoreResult } from '../../shared/types';
import type { Store } from '../db/repositories';

interface BackupDocument {
  format: 'tokenledger-backup';
  formatVersion: 1;
  createdAt: string;
  appVersion: string;
  schemaVersion: number;
  note: string;
  counts: { conversations: number; requests: number };
  tables: Record<string, Record<string, string | number | null>[]>;
}

const MAX_BACKUP_BYTES = 512 * 1024 * 1024;

function buildBackup(store: Store, appVersion: string): BackupDocument {
  return {
    format: 'tokenledger-backup',
    formatVersion: 1,
    createdAt: new Date().toISOString(),
    appVersion,
    schemaVersion: store.schemaVersion,
    note: '此备份包含聊天记录、用量与费用数据，不包含任何 API Key。',
    counts: {
      conversations: store.countConversations(),
      requests: store.countRequests(),
    },
    tables: store.dumpAll() as BackupDocument['tables'],
  };
}

function writeBackupFile(filePath: string, document: BackupDocument): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(document, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

function validateBackup(value: unknown): BackupDocument {
  if (!value || typeof value !== 'object') throw new Error('不是有效的 JSON 备份文件');
  const doc = value as Partial<BackupDocument>;
  if (doc.format !== 'tokenledger-backup') throw new Error('备份格式标识不匹配');
  if (doc.formatVersion !== 1) throw new Error(`不支持的备份版本：${String(doc.formatVersion)}`);
  if (!doc.tables || typeof doc.tables !== 'object' || Array.isArray(doc.tables)) {
    throw new Error('备份缺少 tables 数据');
  }
  return doc as BackupDocument;
}

export class BackupService {
  constructor(
    private readonly store: Store,
    private readonly getWindow: () => BrowserWindow | null,
    private readonly appVersion: string,
  ) {}

  async create(): Promise<BackupResult> {
    const document = buildBackup(this.store, this.appVersion);
    const window = this.getWindow();
    const defaultPath = path.join(
      app.getPath('documents'),
      `tokenledger-backup-${new Date().toISOString().slice(0, 10)}.json`,
    );
    const dialogResult = window
      ? await dialog.showSaveDialog(window, {
          title: '创建全量数据备份',
          defaultPath,
          filters: [{ name: 'TokenLedger 备份', extensions: ['json'] }],
        })
      : await dialog.showSaveDialog({
          title: '创建全量数据备份',
          defaultPath,
          filters: [{ name: 'TokenLedger 备份', extensions: ['json'] }],
        });
    if (dialogResult.canceled || !dialogResult.filePath) {
      return { ok: false, canceled: true };
    }
    try {
      writeBackupFile(dialogResult.filePath, document);
      return {
        ok: true,
        path: dialogResult.filePath,
        conversationCount: document.counts.conversations,
        requestCount: document.counts.requests,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '写入备份失败' };
    }
  }

  async restore(): Promise<RestoreResult> {
    const window = this.getWindow();
    const dialogResult = window
      ? await dialog.showOpenDialog(window, {
          title: '从备份恢复',
          properties: ['openFile'],
          filters: [{ name: 'TokenLedger 备份', extensions: ['json'] }],
        })
      : await dialog.showOpenDialog({
          title: '从备份恢复',
          properties: ['openFile'],
          filters: [{ name: 'TokenLedger 备份', extensions: ['json'] }],
        });
    if (dialogResult.canceled || dialogResult.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    const filePath = dialogResult.filePaths[0];
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_BACKUP_BYTES) throw new Error('备份文件过大（超过 512 MB）');
      const document = validateBackup(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
      const conversationCount = document.tables.conversations?.length ?? 0;
      const requestCount = document.tables.api_requests?.length ?? 0;

      const confirm = window
        ? await dialog.showMessageBox(window, {
            type: 'warning',
            buttons: ['取消', '覆盖并恢复'],
            defaultId: 0,
            cancelId: 0,
            title: '确认恢复备份',
            message: '恢复备份会覆盖当前全部聊天记录与费用统计。',
            detail: `备份包含 ${conversationCount} 个会话、${requestCount} 次 API 请求（创建于 ${
              document.createdAt
            }）。\n\n恢复前会自动将当前数据备份到应用数据目录的 backups/ 文件夹。API Key 不受影响。`,
          })
        : await dialog.showMessageBox({
            type: 'warning',
            buttons: ['取消', '覆盖并恢复'],
            defaultId: 0,
            cancelId: 0,
            title: '确认恢复备份',
            message: '恢复备份会覆盖当前全部聊天记录与费用统计。',
            detail: `备份包含 ${conversationCount} 个会话、${requestCount} 次 API 请求。`,
          });
      if (confirm.response !== 1) return { ok: false, canceled: true };

      const backupDir = path.join(app.getPath('userData'), 'backups');
      const safetyPath = path.join(
        backupDir,
        `pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
      );
      writeBackupFile(safetyPath, buildBackup(this.store, this.appVersion));

      this.store.restoreAll(document.tables);
      return { ok: true, conversationCount, requestCount };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : '恢复备份失败',
      };
    }
  }

  async backupCurrentToUserData(): Promise<string> {
    const backupDir = path.join(app.getPath('userData'), 'backups');
    const target = path.join(backupDir, `auto-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    writeBackupFile(target, buildBackup(this.store, this.appVersion));
    return target;
  }
}
