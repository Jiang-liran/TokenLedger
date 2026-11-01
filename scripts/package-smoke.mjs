import { _electron as electron } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const appPath = path.join(root, 'release/mac-arm64/TokenLedger.app/Contents/MacOS/TokenLedger');
const screenshots = path.join(root, 'docs/screenshots');
const resultsDir = path.join(root, 'test-results');
fs.mkdirSync(resultsDir, { recursive: true });

const results = { checks: [], appPath, testMode: null, productionMode: null, passed: false };
const launched = [];

function cleanEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

async function launch(extraEnv) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenledger-pkg-'));
  const env = {
    ...cleanEnv(),
    TOKENLEDGER_USER_DATA_DIR: userData,
    ...extraEnv,
  };
  const app = await electron.launch({
    executablePath: appPath,
    args: ['--no-sandbox', `--user-data-dir=${userData}`],
    env,
  });
  launched.push(app);
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 30000 });
  return { app, page, userData };
}

try {
  const test = await launch({ TOKENLEDGER_TEST_MODE: '1' });
  const title = await test.page.title();
  assert.equal(title, 'TokenLedger');
  const meta = await test.page.evaluate(() => window.tokenledger.getMeta());
  assert.equal(meta.testMode, true);
  assert.equal(meta.version, '1.0.1');
  results.testMode = meta;

  const sidebarText = await test.page.locator('.sidebar').innerText();
  assert.match(sidebarText, /v1\.0\.1/);
  assert.match(sidebarText, /测试模式/);

  const noNode = await test.page.evaluate(() => typeof window.require === 'undefined');
  assert.equal(noNode, true, '渲染进程不应暴露 Node require');
  results.checks.push('打包应用启动、版本号与 preload 正常');

  await test.page.locator('[data-testid="composer-input"]').fill('打包应用冒烟测试：请回复一段 Markdown。');
  await test.page.locator('[data-testid="composer-input"]').press('Enter');
  await test.page.waitForSelector('[data-testid="stop-button"]', { state: 'detached', timeout: 25000 });
  await test.page.waitForFunction(
    () => (document.querySelector('.chat-header-title h1')?.textContent ?? '').includes('TokenLedger 测试标题'),
    { timeout: 15000 },
  );
  await test.page.waitForSelector('[data-testid="assistant-message"] .cost-chip', { timeout: 15000 });
  const costText = await test.page.locator('[data-testid="assistant-message"] .cost-chip').last().innerText();
  assert.match(costText, /5,692 Tokens/);
  assert.match(costText, /\$0\.005330/);
  results.checks.push(`打包应用聊天、AI 标题与计费正常：${costText.replace(/\s+/g, ' ')}`);
  await test.page.screenshot({ path: path.join(screenshots, '09-packaged-test-mode.png') });
  results.checks.push('打包应用截图已保存');
  await test.app.close();

  const production = await launch({});
  const productionMeta = await production.page.evaluate(() => window.tokenledger.getMeta());
  results.productionMode = productionMeta;
  const body = await production.page.locator('body').innerText();
  assert.match(body, /配置 OpenAI API Key/);
  assert.equal(productionMeta.testMode, false);
  const rendererHasNode = await production.page.evaluate(() => typeof window.require !== 'undefined');
  assert.equal(rendererHasNode, false);
  results.checks.push(
    `生产模式启动正常；密钥存储：${productionMeta.storageBackend}；可用：${productionMeta.secureStorageAvailable}`,
  );
  await production.page.screenshot({ path: path.join(screenshots, '10-packaged-onboarding.png') });

  if (!productionMeta.secureStorageAvailable) {
    await production.page.getByRole('button', { name: '设置', exact: true }).click();
    await production.page.waitForSelector('.settings-wrap');
    await production.page.locator('[data-testid="key-input-openai"]').fill('session-test-key-123456');
    await production.page.getByRole('button', { name: '仅本次运行' }).first().click();
    await production.page.waitForTimeout(500);
    const settingsText = await production.page.locator('.settings-wrap').innerText();
    assert.match(settingsText, /仅本次运行（内存）/);
    assert.equal(
      fs.existsSync(path.join(production.userData, 'secrets.json')),
      false,
      '会话密钥不应写入磁盘',
    );
    results.checks.push('安全存储不可用时，会话密钥仅保存在内存且不落盘');
    await production.page.screenshot({ path: path.join(screenshots, '10b-packaged-session-key.png') });
  }

  await production.app.close();

  results.passed = true;
  console.log('打包应用启动与冒烟测试通过');
} catch (error) {
  results.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error('打包应用测试失败：', results.error);
  process.exitCode = 1;
} finally {
  for (const app of launched) {
    try {
      await app.close();
    } catch {
      // 已关闭
    }
  }
  results.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(resultsDir, 'package-smoke.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results.checks, null, 2));
}
