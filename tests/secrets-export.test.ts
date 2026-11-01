import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SecretStore, type EncryptionBackend } from '../src/main/services/secrets';
import { conversationToJson, conversationToMarkdown, requestsToCsv } from '../src/main/services/export-format';
import type { PricingSnapshot } from '../src/shared/types';
import { OPENAI_USAGE_RAW, createChatHarness, tempDir, waitForEvent } from './helpers';

class FakeBackend implements EncryptionBackend {
  name = 'fake-keychain';
  constructor(public available = true) {}
  async isAvailable(): Promise<boolean> {
    return this.available;
  }
  async encryptString(plain: string): Promise<Buffer> {
    return Buffer.from(`enc:${Buffer.from(plain, 'utf8').toString('base64')}`, 'utf8');
  }
  async decryptString(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }> {
    const text = encrypted.toString('utf8');
    if (!text.startsWith('enc:')) throw new Error('bad cipher');
    return {
      result: Buffer.from(text.slice(4), 'base64').toString('utf8'),
      shouldReEncrypt: false,
    };
  }
}

describe('API Key 安全存储', () => {
  it('只写入密文并使用 0600 权限', async () => {
    const dir = tempDir();
    const store = new SecretStore(dir, new FakeBackend());
    const key = 'test-openai-secret-key-1234567890';
    await store.setKey('openai', key);
    const file = path.join(dir, 'secrets.json');
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).not.toContain(key);
    expect(raw).not.toContain('very-secret');
    expect(raw).toContain('cipher');
    const stat = fs.statSync(file);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(await store.getKey('openai')).toBe(key);
    expect((await store.getStatus('openai')).configured).toBe(true);
  });

  it('删除后状态与明文均消失', async () => {
    const dir = tempDir();
    const store = new SecretStore(dir, new FakeBackend());
    await store.setKey('deepseek', 'test-deepseek-secret-key-123456');
    await store.deleteKey('deepseek');
    expect(await store.getKey('deepseek')).toBeNull();
    expect((await store.getStatus('deepseek')).configured).toBe(false);
  });

  it('系统安全存储不可用时拒绝保存明文', async () => {
    const dir = tempDir();
    const store = new SecretStore(dir, new FakeBackend(false));
    expect(await store.isAvailable()).toBe(false);
    await expect(store.setKey('openai', 'sk-abcdefgh')).rejects.toThrow('安全存储不可用');
    expect(fs.existsSync(path.join(dir, 'secrets.json'))).toBe(false);
  });

  it('安全存储不可用时可使用仅内存的会话密钥', async () => {
    const dir = tempDir();
    const store = new SecretStore(dir, new FakeBackend(false));
    store.setSessionKey('openai', 'session-only-test-key-123456');
    expect(await store.getKey('openai')).toBe('session-only-test-key-123456');
    const status = await store.getStatus('openai');
    expect(status.configured).toBe(true);
    expect(status.storage).toBe('session');
    expect(fs.existsSync(path.join(dir, 'secrets.json'))).toBe(false);
    await store.deleteKey('openai');
    expect(await store.getKey('openai')).toBeNull();
  });

  it('拒绝过短或包含空白的密钥', async () => {
    const store = new SecretStore(tempDir(), new FakeBackend());
    await expect(store.setKey('openai', 'short')).rejects.toThrow('过短');
    await expect(store.setKey('openai', 'sk-valid-but space')).rejects.toThrow('空格');
  });
});

describe('导出格式', () => {
  async function buildExport() {
    const h = createChatHarness({ usageRaw: OPENAI_USAGE_RAW, text: '导出测试回答' });
    const result = await h.chat.send({
      provider: 'openai',
      model: 'gpt-6.1-sol',
      content: '导出测试问题',
    });
    await waitForEvent(h.events, 'completed');
    const detail = h.store.getConversationDetail(result.conversationId);
    const snapshots: Record<string, PricingSnapshot | null> = {};
    for (const turn of detail.turns) {
      for (const request of turn.requests) {
        if (request.pricingSnapshotId) {
          snapshots[request.pricingSnapshotId] = h.store.getPricingSnapshot(request.pricingSnapshotId);
        }
      }
    }
    return { h, result, detail, snapshots };
  }

  it('Markdown 包含会话、轮次、费用与请求明细', async () => {
    const { h, detail, snapshots } = await buildExport();
    const markdown = conversationToMarkdown({ detail, pricingSnapshots: snapshots });
    expect(markdown).toContain('# 导出测试问题');
    expect(markdown).toContain('导出测试回答');
    expect(markdown).toContain('本轮统计');
    expect(markdown).toContain('$0.004850');
    expect(markdown).toContain('openai-2026.11.01');
    expect(markdown).toContain('req_');
    expect(markdown).not.toContain('test-openai-key-not-real');
    h.db.close();
  });

  it('JSON 包含结构化的 usage、价格快照与统计', async () => {
    const { h, detail, snapshots } = await buildExport();
    const json = conversationToJson({ detail, pricingSnapshots: snapshots });
    expect(json.format).toBe('tokenledger-conversation');
    expect(json.conversation.id).toBe(detail.conversation.id);
    expect(json.stats.costUsd).toBe('0.00485');
    expect(json.turns[0].requests[0].pricingSnapshot?.table.inputPerM).toBe('2.00');
    expect(json.turns[0].requests[0].costUsd).toBe('0.00485');
    const text = JSON.stringify(json);
    expect(text).not.toContain('test-openai-key-not-real');
    h.db.close();
  });

  it('CSV 包含逐请求字段且金额不为空', async () => {
    const { h, result } = await buildExport();
    const rows = h.store.loadStatRequests({ conversationId: result.conversationId });
    const csv = requestsToCsv(rows);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toContain('request_id');
    expect(lines[0]).toContain('cost_usd');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('gpt-6.1-sol');
    expect(lines[1]).toContain('0.00485');
    expect(lines[1]).toContain(result.requestId);
    h.db.close();
  });
});
