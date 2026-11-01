import fs from 'node:fs';
import path from 'node:path';
import { app, dialog, type BrowserWindow } from 'electron';
import type { ExportResult, PricingSnapshot } from '../../shared/types';
import type { Store } from '../db/repositories';
import {
  conversationToJson,
  conversationToMarkdown,
  requestsToCsv,
  type ConversationExportBundle,
} from './export-format';

function safeFileName(title: string, fallback: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|\n\r\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return cleaned || fallback;
}

function dateStamp(): string {
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
    now.getDate(),
  ).padStart(2, '0')}`;
}

export class ExportService {
  constructor(
    private readonly store: Store,
    private readonly getWindow: () => BrowserWindow | null,
  ) {}

  private bundle(conversationId: string): ConversationExportBundle {
    const detail = this.store.getConversationDetail(conversationId);
    const pricingSnapshots: Record<string, PricingSnapshot | null> = {};
    for (const turn of detail.turns) {
      for (const request of turn.requests) {
        if (!request.pricingSnapshotId || pricingSnapshots[request.pricingSnapshotId] !== undefined) {
          continue;
        }
        pricingSnapshots[request.pricingSnapshotId] = this.store.getPricingSnapshot(
          request.pricingSnapshotId,
        );
      }
    }
    return { detail, pricingSnapshots };
  }

  private async saveFile(
    title: string,
    defaultName: string,
    content: string,
    filters: Electron.FileFilter[],
  ): Promise<ExportResult> {
    const window = this.getWindow();
    const dialogResult = window
      ? await dialog.showSaveDialog(window, {
          title,
          defaultPath: path.join(app.getPath('documents'), defaultName),
          filters,
        })
      : await dialog.showSaveDialog({
          title,
          defaultPath: path.join(app.getPath('documents'), defaultName),
          filters,
        });
    if (dialogResult.canceled || !dialogResult.filePath) {
      return { ok: false, canceled: true };
    }
    try {
      fs.writeFileSync(dialogResult.filePath, content, { encoding: 'utf-8', mode: 0o600 });
      return { ok: true, path: dialogResult.filePath };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : '写入文件失败',
      };
    }
  }

  async exportConversationMarkdown(conversationId: string): Promise<ExportResult> {
    const bundle = this.bundle(conversationId);
    const content = conversationToMarkdown(bundle);
    const name = safeFileName(bundle.detail.conversation.title, 'tokenledger-conversation');
    return this.saveFile('导出会话 Markdown', `${name}.md`, content, [
      { name: 'Markdown', extensions: ['md'] },
    ]);
  }

  async exportConversationJson(conversationId: string): Promise<ExportResult> {
    const bundle = this.bundle(conversationId);
    const content = JSON.stringify(conversationToJson(bundle), null, 2);
    const name = safeFileName(bundle.detail.conversation.title, 'tokenledger-conversation');
    return this.saveFile('导出会话 JSON', `${name}.json`, content, [
      { name: 'JSON', extensions: ['json'] },
    ]);
  }

  async exportStatsCsv(from: string | null, to: string | null): Promise<ExportResult> {
    const rows = this.store.loadStatRequests({ from, to });
    const csv = requestsToCsv(rows);
    return this.saveFile('导出费用统计 CSV', `tokenledger-costs-${dateStamp()}.csv`, csv, [
      { name: 'CSV', extensions: ['csv'] },
    ]);
  }
}
