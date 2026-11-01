import fs from 'node:fs';
import path from 'node:path';
import type { ProviderId, ProviderKeyStatus } from '../../shared/types';

export interface EncryptionBackend {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  encryptString(plain: string): Promise<Buffer>;
  decryptString(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
}

interface SecretFileEntry {
  cipher: string;
  updatedAt: string;
}

interface SecretFile {
  version: 1;
  entries: Partial<Record<ProviderId, SecretFileEntry>>;
}

/**
 * API Key 存储：
 * - 使用 Electron safeStorage（macOS 上由 Keychain 保护的密钥）加密；
 * - 只把密文写入 userData/secrets.json，文件权限 0600；
 * - 明文永不写入 SQLite、日志、备份或渲染进程；
 * - 若系统安全存储不可用，则拒绝保存，而不是降级为明文。
 */
export class SecretStore {
  private readonly filePath: string;
  private readonly backend: EncryptionBackend;
  private cache: SecretFile | null = null;
  private availabilityProbe: Promise<boolean> | null = null;
  private readonly sessionKeys = new Map<ProviderId, string>();

  constructor(userDataDir: string, backend: EncryptionBackend) {
    this.filePath = path.join(userDataDir, 'secrets.json');
    this.backend = backend;
  }

  get storageBackend(): string {
    return this.backend.name;
  }

  /**
   * 使用 Electron 45 推荐的异步 safeStorage 接口，并做一次加密/解密自检。
   * 仅“接口可用”不足以说明钥匙串可访问；自检失败时按不可用处理，
   * 避免向用户展示成功状态后在保存时失败。
   */
  isAvailable(): Promise<boolean> {
    if (!this.availabilityProbe) {
      this.availabilityProbe = (async () => {
        try {
          if (!(await this.backend.isAvailable())) return false;
          const encrypted = await this.backend.encryptString('tokenledger-probe');
          const decrypted = await this.backend.decryptString(encrypted);
          return decrypted.result === 'tokenledger-probe';
        } catch {
          return false;
        }
      })();
    }
    return this.availabilityProbe;
  }

  private readFile(): SecretFile {
    if (this.cache) return this.cache;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as SecretFile;
      if (!parsed || parsed.version !== 1 || typeof parsed.entries !== 'object' || !parsed.entries) {
        throw new Error('密钥文件格式无效');
      }
      this.cache = parsed;
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cache = { version: 1, entries: {} };
        return this.cache;
      }
      throw new Error('无法读取本地密钥存储');
    }
  }

  private writeFile(file: SecretFile): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(file), { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      // 权限设置失败不阻断保存，但文件本身仍是 0600 创建。
    }
    this.cache = file;
  }

  async getStatus(provider: ProviderId): Promise<ProviderKeyStatus> {
    try {
      const file = this.readFile();
      const entry = file.entries[provider];
      const available = await this.isAvailable();
      if (this.sessionKeys.has(provider) && !entry?.cipher) {
        return {
          configured: true,
          updatedAt: new Date().toISOString(),
          storage: 'session',
        };
      }
      return {
        configured: !!entry?.cipher || this.sessionKeys.has(provider),
        updatedAt: entry?.updatedAt ?? null,
        storage: available ? 'keychain' : this.sessionKeys.has(provider) ? 'session' : 'unavailable',
      };
    } catch {
      return {
        configured: this.sessionKeys.has(provider),
        updatedAt: null,
        storage: this.sessionKeys.has(provider) ? 'session' : 'unavailable',
      };
    }
  }

  async getKey(provider: ProviderId): Promise<string | null> {
    const sessionKey = this.sessionKeys.get(provider);
    if (sessionKey) return sessionKey;
    if (!(await this.isAvailable())) return null;
    let file: SecretFile;
    try {
      file = this.readFile();
    } catch {
      return null;
    }
    const entry = file.entries[provider];
    if (!entry?.cipher) return null;
    try {
      const buffer = Buffer.from(entry.cipher, 'base64');
      const decrypted = await this.backend.decryptString(buffer);
      if (!decrypted.result) return null;
      if (decrypted.shouldReEncrypt) {
        // Electron 建议：密钥轮换后重新加密，使用新的密钥材料。
        const reEncrypted = await this.backend.encryptString(decrypted.result);
        entry.cipher = reEncrypted.toString('base64');
        entry.updatedAt = new Date().toISOString();
        this.writeFile(file);
      }
      return decrypted.result;
    } catch {
      return null;
    }
  }

  async setKey(provider: ProviderId, key: string): Promise<void> {
    if (!(await this.isAvailable())) {
      throw new Error('系统安全存储不可用，无法安全保存 API Key。请解锁钥匙串后重试。');
    }
    const trimmed = key.trim();
    if (trimmed.length < 8) throw new Error('API Key 长度过短');
    if (trimmed.length > 4096) throw new Error('API Key 长度异常');
    if (/\s/.test(trimmed)) throw new Error('API Key 不应包含空格或换行');
    const file = this.readFile();
    const encrypted = await this.backend.encryptString(trimmed);
    file.entries[provider] = {
      cipher: encrypted.toString('base64'),
      updatedAt: new Date().toISOString(),
    };
    this.writeFile(file);
  }

  /**
   * 仅本次运行使用：密钥只保存在主进程内存中，绝不写入磁盘。
   * 用于系统安全存储暂时不可用（例如钥匙串被锁定/拒绝访问）的场景。
   */
  setSessionKey(provider: ProviderId, key: string): void {
    const trimmed = key.trim();
    if (trimmed.length < 8) throw new Error('API Key 长度过短');
    if (trimmed.length > 4096) throw new Error('API Key 长度异常');
    if (/\s/.test(trimmed)) throw new Error('API Key 不应包含空格或换行');
    this.sessionKeys.set(provider, trimmed);
  }

  async deleteKey(provider: ProviderId): Promise<void> {
    this.sessionKeys.delete(provider);
    const file = this.readFile();
    delete file.entries[provider];
    this.writeFile(file);
  }
}

/** 仅用于测试：不落盘、不加密，避免自动化测试依赖真实钥匙串。 */
export class MemorySecretStore {
  private readonly keys = new Map<ProviderId, string>();

  get storageBackend(): string {
    return '测试用内存密钥存储（仅测试）';
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  preload(provider: ProviderId, key: string): void {
    this.keys.set(provider, key);
  }

  async getStatus(provider: ProviderId): Promise<ProviderKeyStatus> {
    return {
      configured: this.keys.has(provider),
      updatedAt: this.keys.has(provider) ? '2026-11-01T00:00:00.000Z' : null,
      storage: 'keychain',
    };
  }

  async getKey(provider: ProviderId): Promise<string | null> {
    return this.keys.get(provider) ?? null;
  }

  async setKey(provider: ProviderId, key: string): Promise<void> {
    this.keys.set(provider, key.trim());
  }

  setSessionKey(provider: ProviderId, key: string): void {
    this.keys.set(provider, key.trim());
  }

  async deleteKey(provider: ProviderId): Promise<void> {
    this.keys.delete(provider);
  }
}

export type KeyStore = SecretStore | MemorySecretStore;
