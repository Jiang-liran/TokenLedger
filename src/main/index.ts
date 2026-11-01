import { app, BrowserWindow, Menu, nativeTheme, safeStorage, session } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { Database } from './db/database';
import { Store } from './db/repositories';
import { SecretStore, MemorySecretStore, type EncryptionBackend, type KeyStore } from './services/secrets';
import { Logger } from './services/logger';
import { PricingService } from './services/pricing';
import { ChatService } from './services/chat';
import { ModelsService } from './services/models';
import { BalanceService } from './services/balance';
import { ExportService } from './services/export';
import { BackupService } from './services/backup';
import { registerIpc } from './ipc';
import { createMockStream } from './services/mock';
import { IPC } from '../shared/ipc';
import type { BudgetAlert, ChatStreamEvent } from '../shared/types';
import { APP_VERSION } from '../shared/version';

const TEST_MODE = process.env.TOKENLEDGER_TEST_MODE === '1';
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL ?? null;
if (TEST_MODE) {
  // 自动化测试运行在受限沙箱中，Chromium 的 OS 级沙箱无法初始化。
  // 仅测试模式启用；正式应用保留完整沙箱。
  app.commandLine.appendSwitch('no-sandbox');
}

app.setName('TokenLedger');
const userDataDir = process.env.TOKENLEDGER_USER_DATA_DIR
  ? path.resolve(process.env.TOKENLEDGER_USER_DATA_DIR)
  : app.getPath('userData');
fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
app.setPath('userData', userDataDir);

const hasSingleInstanceLock = TEST_MODE ? true : app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

let mainWindow: BrowserWindow | null = null;
let database: Database | null = null;
let logger: Logger | null = null;
let chatService: ChatService | null = null;

function sendToWindow(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 940,
    minHeight: 620,
    show: false,
    title: 'TokenLedger',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 20 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f5f5f7',
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: true,
      devTools: !app.isPackaged || TEST_MODE,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    const allowed =
      (DEV_SERVER_URL && url.startsWith(DEV_SERVER_URL)) ||
      url.startsWith('file://' + path.join(__dirname, '../renderer/'));
    if (!allowed) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    logger?.error(`页面加载失败 ${code} ${description}`, url);
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    logger?.error('渲染进程异常退出', details.reason);
  });
  window.webContents.on('context-menu', (_event, params) => {
    const items: Electron.MenuItemConstructorOptions[] = [];
    if (params.selectionText.trim()) {
      items.push({ role: 'copy', label: '复制' });
    }
    if (params.isEditable) {
      if (items.length > 0) items.push({ type: 'separator' });
      items.push({ role: 'cut', label: '剪切' });
      items.push({ role: 'paste', label: '粘贴' });
      items.push({ role: 'selectAll', label: '全选' });
    }
    if (items.length > 0) {
      Menu.buildFromTemplate(items).popup({ window });
    }
  });

  window.once('ready-to-show', () => window.show());

  if (DEV_SERVER_URL) {
    void window.loadURL(DEV_SERVER_URL);
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  return window;
}

function buildMenu(): void {
  const isDev = !!DEV_SERVER_URL;
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'TokenLedger',
      submenu: [
        { role: 'about', label: '关于 TokenLedger' },
        { type: 'separator' },
        { role: 'services', label: '服务' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏 TokenLedger' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '显示全部' },
        { type: 'separator' },
        { role: 'quit', label: '退出 TokenLedger' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        ...(isDev
          ? ([
              { role: 'reload', label: '重新加载' },
              { role: 'toggleDevTools', label: '开发者工具' },
              { type: 'separator' },
            ] as Electron.MenuItemConstructorOptions[])
          : []),
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '进入全屏' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { type: 'separator' },
        { role: 'front', label: '前置全部窗口' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createServices(): void {
  database = new Database(path.join(userDataDir, 'tokenledger.db'));
  const store = new Store(database);
  logger = new Logger(path.join(userDataDir, 'logs'));

  const interrupted = store.markInterrupted();
  if (interrupted.requests > 0 || interrupted.messages > 0) {
    logger.info('已将上次异常退出的请求标记为中断', interrupted);
  }

  const backend: EncryptionBackend = {
    name: 'macOS 钥匙串（Electron safeStorage）',
    isAvailable: async () => {
      try {
        return await safeStorage.isAsyncEncryptionAvailable();
      } catch {
        return false;
      }
    },
    encryptString: (plain) => safeStorage.encryptStringAsync(plain),
    decryptString: async (encrypted) => {
      const result = await safeStorage.decryptStringAsync(encrypted);
      return { result: result.result, shouldReEncrypt: result.shouldReEncrypt };
    },
  };

  let secrets: KeyStore;
  if (TEST_MODE) {
    const memory = new MemorySecretStore();
    memory.preload('openai', 'test-openai-key-not-real');
    memory.preload('deepseek', 'test-deepseek-key-not-real');
    secrets = memory;
  } else {
    secrets = new SecretStore(userDataDir, backend);
  }

  const pricing = new PricingService(store);
  try {
    pricing.ensureFxSnapshot();
  } catch (error) {
    logger.warn('初始化汇率快照失败', error);
  }

  chatService = new ChatService({
    store,
    secrets,
    pricing,
    logger,
    emit: (event: ChatStreamEvent) => sendToWindow(IPC.chatEvent, event),
    emitBudgetAlert: (alert: BudgetAlert) => sendToWindow(IPC.budgetAlert, alert),
    stream: TEST_MODE ? createMockStream() : undefined,
  });

  const models = new ModelsService(secrets, pricing);
  const balance = new BalanceService(secrets);
  const getWindow = () => mainWindow;
  const exporter = new ExportService(store, getWindow);
  const backup = new BackupService(store, getWindow, APP_VERSION);

  registerIpc({
    store,
    secrets,
    pricing,
    chat: chatService,
    models,
    balance,
    exporter,
    backup,
    logger,
    isTestMode: TEST_MODE,
    dataDir: userDataDir,
    getWindow,
    devServerUrl: DEV_SERVER_URL,
  });

  app.on('will-quit', () => {
    try {
      chatService?.abortAll();
      database?.close();
      database = null;
    } catch (error) {
      logger?.warn('关闭数据库时出错', error);
    }
  });
}

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return;
  nativeTheme.themeSource = 'system';
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);

  createServices();
  buildMenu();
  app.setAboutPanelOptions({
    applicationName: 'TokenLedger',
    applicationVersion: APP_VERSION,
    version: `Electron ${process.versions.electron}`,
    copyright: '本地优先的 AI 用量与费用账本',
  });

  mainWindow = createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
    }
  });

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || TEST_MODE) app.quit();
});

process.on('uncaughtException', (error) => {
  logger?.error('未捕获异常', error);
});

process.on('unhandledRejection', (reason) => {
  logger?.warn('未处理的 Promise 拒绝', reason);
});

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});
