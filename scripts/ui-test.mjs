import { _electron as electron } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const root = process.cwd();
const screenshotsDir = path.join(root, 'docs', 'screenshots');
const resultsDir = path.join(root, 'test-results');
fs.mkdirSync(screenshotsDir, { recursive: true });
fs.mkdirSync(resultsDir, { recursive: true });

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenledger-e2e-'));
const env = {
  ...process.env,
  TOKENLEDGER_TEST_MODE: '1',
  TOKENLEDGER_USER_DATA_DIR: userData,
};
delete env.ELECTRON_RUN_AS_NODE;

const results = {
  startedAt: new Date().toISOString(),
  userData,
  checks: [],
  screenshots: [],
  consoleErrors: [],
  pageErrors: [],
  passed: false,
};

function record(name, detail = '') {
  results.checks.push({ name, detail, at: new Date().toISOString() });
  console.log(`✓ ${name}${detail ? ` — ${detail}` : ''}`);
}

async function launch() {
  const app = await electron.launch({
    executablePath: electronPath,
    args: ['--no-sandbox', `--user-data-dir=${userData}`, 'dist/main/index.js'],
    env,
  });
  const page = await app.firstWindow();
  page.on('console', (message) => {
    if (message.type() === 'error') results.consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => results.pageErrors.push(error.message));
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 20000 });
  return { app, page };
}

async function screenshot(page, name) {
  const file = path.join(screenshotsDir, `${name}.png`);
  await page.screenshot({ path: file });
  results.screenshots.push(file);
  console.log(`  screenshot: ${file}`);
}

async function waitForChatTitle(page, expected, timeout = 15000) {
  await page.waitForFunction(
    (title) => {
      const element = document.querySelector('.chat-header-title h1');
      return !!element && (element.textContent ?? '').includes(title);
    },
    expected,
    { timeout },
  );
}

async function sendAndWait(page, text) {
  const input = page.locator('[data-testid="composer-input"]');
  await input.fill(text);
  await input.press('Enter');
  await page.waitForSelector('[data-testid="stop-button"]', { state: 'visible', timeout: 10000 });
  await page.waitForSelector('[data-testid="assistant-message"]');
  await page.waitForFunction(
    () => {
      const nodes = document.querySelectorAll('[data-testid="assistant-message"]');
      const last = nodes[nodes.length - 1];
      return !!last && (last.textContent ?? '').length > 120;
    },
    { timeout: 15000 },
  );
  await page.waitForSelector('[data-testid="stop-button"]', { state: 'detached', timeout: 20000 });
}

let app;
let page;
try {
  ({ app, page } = await launch());
  record('应用启动并加载主界面');

  assert.ok((await page.locator('body').innerText()).includes('已准备好'), '测试模式应已配置密钥');
  record('测试模式密钥状态正常');

  await screenshot(page, '01-welcome-light');

  const firstMessage = '第一条消息：请解释什么是操作系统的死锁。';
  const initialLength = await page.locator('[data-testid="assistant-message"]').count();
  assert.equal(initialLength, 0);

  await page.locator('[data-testid="composer-input"]').fill(firstMessage);
  await page.locator('[data-testid="composer-input"]').press('Enter');
  await page.waitForSelector('[data-testid="stop-button"]', { state: 'visible', timeout: 10000 });
  await page.waitForSelector('[data-testid="assistant-message"]');
  await page.waitForSelector('[data-testid="assistant-message"] .md');
  const textA = await page.locator('[data-testid="assistant-message"] .md').last().innerText();
  await page.waitForTimeout(300);
  const textB = await page.locator('[data-testid="assistant-message"] .md').last().innerText();
  assert.ok(textB.length >= textA.length, '流式内容应持续增长');
  record('流式输出实时增长', `${textA.length} → ${textB.length} 字符`);

  await page.waitForSelector('[data-testid="stop-button"]', { state: 'detached', timeout: 25000 });
  await waitForChatTitle(page, '操作系统的死锁解析');
  const costChip = page.locator('[data-testid="assistant-message"] .cost-chip').last();
  await costChip.waitFor({ timeout: 10000 });
  const costText = await costChip.innerText();
  assert.match(costText, /5,692 Tokens/);
  assert.match(costText, /\$0\.005330/);
  record('第一轮聊天 + AI 命名 Token 与费用正确', costText.replace(/\s+/g, ' '));

  const headerChip = page.locator('.chat-header .chip').filter({ hasText: '本会话' }).first();
  const header1 = await headerChip.innerText();
  assert.match(header1, /5,692 Tokens/);
  assert.match(header1, /\$0\.005330/);
  record('会话累计包含标题生成费用', header1.replace(/\s+/g, ' '));

  const chatInner = await page.locator('.chat-inner').innerText();
  assert.doesNotMatch(chatInner, /本会话累计/);
  assert.match(await page.locator('.sidebar').innerText(), /5,692 Tokens/);
  record('聊天底部重复的会话累计已移除，顶部与侧边栏保留');

  await page.locator('[data-testid="composer-input"]').fill('第二条消息：请继续补充一个例子。');
  await page.locator('[data-testid="composer-input"]').press('Enter');
  await page.waitForSelector('[data-testid="stop-button"]', { state: 'visible', timeout: 10000 });
  await page.waitForSelector('[data-testid="stop-button"]', { state: 'detached', timeout: 25000 });
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="assistant-message"] .cost-chip').length === 2,
    { timeout: 15000 },
  );
  const header2 = await headerChip.innerText();
  assert.match(header2, /11,192 Tokens/);
  assert.match(header2, /\$0\.010180/);
  record('第二轮后会话累计正确', header2.replace(/\s+/g, ' '));

  await page.locator('[data-testid="assistant-message"] .cost-chip').first().click();
  const details = await page.locator('[data-testid="assistant-message"] .cost-details').first().innerText();
  assert.match(details, /缓存读取/);
  assert.match(details, /5,200/);
  assert.match(details, /4,500/);
  assert.match(details, /请求/);
  assert.match(details, /AI 命名/);
  assert.match(details, /0\.000480/);
  record('费用明细可展开，区分聊天与 AI 命名请求');
  await screenshot(page, '02-chat-light');

  await page.locator('[data-testid="new-chat-button"]').click();
  await page.waitForTimeout(400);
  assert.match(await page.locator('.chat-header-title h1').innerText(), /新对话/);
  record('新建对话默认标题为「新对话」');
  await page.locator('[data-testid="composer-input"]').fill('新会话消息：独立统计测试。');
  await page.locator('[data-testid="composer-input"]').press('Enter');
  await page.waitForSelector('[data-testid="stop-button"]', { state: 'detached', timeout: 25000 });
  await waitForChatTitle(page, '独立统计测试会话');
  const headerNew = await page.locator('.chat-header .chip').filter({ hasText: '本会话' }).first().innerText();
  assert.match(headerNew, /5,692 Tokens/);
  assert.match(headerNew, /\$0\.005330/);
  record('新建会话独立归零', headerNew.replace(/\s+/g, ' '));

  await page.locator('[data-testid="conversation-item"]').filter({ hasText: '操作系统的死锁解析' }).first().click();
  await page.waitForTimeout(500);
  const reopened = await page.locator('.chat-header .chip').filter({ hasText: '本会话' }).first().innerText();
  assert.match(reopened, /11,192 Tokens/);
  assert.match(reopened, /\$0\.010180/);
  record('重新打开历史会话恢复累计', reopened.replace(/\s+/g, ' '));

  await page.getByRole('button', { name: '用量统计' }).click();
  await page.waitForSelector('text=会话费用排名', { timeout: 10000 });
  await page.waitForTimeout(400);
  const usageText = await page.locator('.page-body').innerText();
  assert.match(usageText, /16,884/);
  assert.match(usageText, /\$0\.015510/);
  assert.match(usageText, /OpenAI/);
  assert.match(usageText, /DeepSeek/);
  assert.match(usageText, /AI 标题生成/);
  record('全局统计汇总多会话多请求');
  await screenshot(page, '03-usage-light');

  await page.getByLabel('服务商筛选').selectOption('deepseek');
  await page.waitForTimeout(700);
  const filteredDeepSeek = await page.locator('.page-body').innerText();
  assert.match(filteredDeepSeek, /\$0\.000000/);
  assert.doesNotMatch(filteredDeepSeek, /16,884/);
  await page.getByLabel('服务商筛选').selectOption('');
  await page.waitForTimeout(700);
  const restoredAll = await page.locator('.page-body').innerText();
  assert.match(restoredAll, /16,884/);
  record('按服务商筛选全局统计并可恢复');

  await page.getByLabel('请求用途').selectOption('title_generation');
  await page.waitForTimeout(700);
  const filteredTitle = await page.locator('.page-body').innerText();
  assert.match(filteredTitle, /384/);
  assert.match(filteredTitle, /\$0\.000960/);
  assert.match(filteredTitle, /AI 标题生成/);
  await page.getByLabel('请求用途').selectOption('');
  await page.waitForTimeout(700);
  record('按请求用途筛选可区分聊天与 AI 标题生成');

  const sidebarText = await page.locator('.sidebar').innerText();
  assert.match(sidebarText, /v1\.0\.1/);
  record('版本号显示正确');

  await page.setViewportSize({ width: 1000, height: 700 });
  await page.waitForTimeout(300);
  const narrowLayout = await page.evaluate(() => {
    const scroll = document.querySelector('[data-testid="message-scroll"]')?.getBoundingClientRect();
    const composer = document.querySelector('.composer')?.getBoundingClientRect();
    return {
      scrollBottom: scroll?.bottom ?? 0,
      composerTop: composer?.top ?? 0,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  assert.ok(narrowLayout.overflow <= 1, `窄窗口不应出现水平溢出：${narrowLayout.overflow}`);
  assert.ok(
    narrowLayout.scrollBottom <= narrowLayout.composerTop + 1,
    '消息滚动区不应被输入框遮挡',
  );
  await screenshot(page, '12-narrow-window');
  record('窄窗口下无水平溢出，输入框不遮挡消息区');
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.waitForTimeout(300);

  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.waitForSelector('.settings-wrap', { timeout: 10000 });
  await page.waitForTimeout(400);
  const settingsText = await page.locator('.settings-wrap').innerText();
  assert.match(settingsText, /API Key/);
  assert.match(settingsText, /费用与汇率/);
  assert.match(settingsText, /预算提醒/);
  assert.match(settingsText, /AI 智能会话标题/);
  record('设置页加载 API Key、AI 命名、汇率、预算与数据区');
  await screenshot(page, '04-settings-light');

  await page.getByRole('button', { name: '用量统计' }).click();
  await page.waitForTimeout(300);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(400);
  await screenshot(page, '05-usage-dark');

  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.waitForTimeout(300);
  await screenshot(page, '06-settings-dark');

  await page.locator('[data-testid="conversation-item"]').first().click();
  await page.waitForTimeout(400);
  await screenshot(page, '07-chat-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  // 停止生成：必须保留部分内容，并以“无法确定”而非 $0 记录。
  await page.locator('[data-testid="new-chat-button"]').click();
  await page.waitForTimeout(300);
  await page.locator('[data-testid="composer-input"]').fill('停止生成测试：请写一段很长的内容。');
  await page.locator('[data-testid="composer-input"]').press('Enter');
  await page.waitForSelector('[data-testid="stop-button"]', { state: 'visible', timeout: 10000 });
  await page.locator('[data-testid="stop-button"]').click();
  await page.waitForSelector('[data-testid="stop-button"]', { state: 'detached', timeout: 15000 });
  await page.waitForTimeout(600);
  const stopText = await page.locator('body').innerText();
  assert.match(stopText, /已停止生成/);
  const stopSidebar = await page.locator('[data-testid="conversation-item"]').first().innerText();
  assert.match(stopSidebar, /费用未知/);
  assert.match(stopSidebar, /用量未知/);
  assert.doesNotMatch(stopSidebar, /0 Tokens\s+\$0\.000000/);
  record('用户停止生成后状态正确');
  record('侧边栏不把未知费用显示为 $0');

  const stopConversationId = await page.evaluate(async () => {
    const list = await window.tokenledger.listConversations(false);
    return list[0]?.id ?? null;
  });
  assert.ok(stopConversationId, '应能读取会话 ID');

  const dbPath = path.join(userData, 'tokenledger.db');
  assert.ok(fs.existsSync(dbPath), '数据库应保存在应用数据目录');
  let db = new DatabaseSync(dbPath);
  const aborted = db
    .prepare("SELECT status, calculation_status, cost_amount, normalized_usage FROM api_requests WHERE status = 'aborted'")
    .all();
  assert.ok(aborted.length >= 1, '停止后应保留 aborted 请求记录');
  assert.equal(aborted[0].calculation_status, 'unknown');
  assert.equal(aborted[0].cost_amount, null);
  record('停止后请求标记为用量未知且不记为 $0', JSON.stringify(aborted[0]));

  const turnStats = db
    .prepare(
      'SELECT COUNT(*) AS c, SUM(CASE WHEN calculation_status = \'unknown\' THEN 1 ELSE 0 END) AS unknown FROM api_requests',
    )
    .get();
  record('数据库请求记录汇总', `总计 ${turnStats.c} 次，费用未知 ${turnStats.unknown} 次`);

  const allFiles = fs.readdirSync(userData, { recursive: true });
  const textFiles = allFiles
    .map((file) => path.join(userData, String(file)))
    .filter((file) => fs.existsSync(file) && fs.statSync(file).isFile() && fs.statSync(file).size < 5_000_000);
  const leaked = textFiles.filter((file) => {
    try {
      const content = fs.readFileSync(file, 'utf8');
      return (
        content.includes('test-openai-key-not-real') ||
        content.includes('test-deepseek-key-not-real')
      );
    } catch {
      return false;
    }
  });
  assert.equal(leaked.length, 0, `密钥不应出现在磁盘明文文件中：${leaked.join(', ')}`);
  record('API Key 未出现在数据目录明文文件中');

  const dbLeak = db
    .prepare("SELECT COUNT(*) AS c FROM api_requests WHERE raw_usage LIKE '%test-openai-key%' OR request_parameters LIKE '%test-openai-key%'")
    .get();
  assert.equal(dbLeak.c, 0);
  record('API Key 未写入数据库记录');

  db.close();
  await app.close();

  // 重启并验证持久化。
  ({ app, page } = await launch());
  await page.waitForTimeout(800);
  const bodyAfterRestart = await page.locator('body').innerText();
  const conversationCount = await page.locator('[data-testid="conversation-item"]').count();
  assert.ok(conversationCount >= 3, `重启后应保留多个会话，实际 ${conversationCount}`);
  assert.match(bodyAfterRestart, /操作系统的死锁解析/);
  await page.locator('[data-testid="conversation-item"]').filter({ hasText: '操作系统的死锁解析' }).first().click();
  await page.waitForTimeout(600);
  const headerAfterRestart = await page
    .locator('.chat-header .chip')
    .filter({ hasText: '本会话' })
    .first()
    .innerText();
  assert.match(headerAfterRestart, /11,192 Tokens/);
  assert.match(headerAfterRestart, /\$0\.010180/);
  record('重启后聊天与费用完整恢复', headerAfterRestart.replace(/\s+/g, ' '));
  await screenshot(page, '08-restart-light');

  const settingsAfter = await page.evaluate(async () => window.tokenledger.getSettings());
  assert.equal(settingsAfter.fx.rate.length > 0, true);
  record('重启后设置可读取');

  // 手动改名，并验证 AI 重新生成标题需要用户主动操作。
  const moreButton = page.locator('.chat-header button[aria-label="更多会话操作"]').first();
  await moreButton.click();
  await page.getByRole('button', { name: '重命名', exact: true }).click();
  await page.locator('.modal input').fill('手动命名测试');
  await page.locator('.modal').getByRole('button', { name: '保存', exact: true }).click();
  await waitForChatTitle(page, '手动命名测试');
  await page.waitForTimeout(500);
  assert.match(await page.locator('.chat-header-title h1').innerText(), /手动命名测试/);
  record('用户手动改名后标题保持，不被自动命名覆盖');

  await moreButton.click();
  await page.getByRole('button', { name: 'AI 重新生成标题', exact: true }).click();
  await waitForChatTitle(page, 'TokenLedger 测试标题');
  const manualHeader = await page.locator('.chat-header .chip').filter({ hasText: '本会话' }).first().innerText();
  assert.match(manualHeader, /11,384 Tokens/);
  assert.match(manualHeader, /\$0\.010660/);
  record('手动 AI 重新生成标题并记录新增费用', manualHeader.replace(/\s+/g, ' '));

  // 同一会话内切换服务商，验证按各自价格累计。
  await page.locator('.chat-header .chip').filter({ hasText: 'GPT-6.1 Sol' }).first().click();
  await page.getByRole('button', { name: 'DeepSeek', exact: true }).click();
  await page.locator('.menu-item').filter({ hasText: 'DeepSeek Flash' }).first().click();
  await page.waitForTimeout(300);
  await page.locator('[data-testid="composer-input"]').fill('切换服务商后的 DeepSeek 提问');
  await page.locator('[data-testid="composer-input"]').press('Enter');
  await page.waitForSelector('[data-testid="stop-button"]', { state: 'detached', timeout: 25000 });
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="assistant-message"]').length === 3,
    { timeout: 15000 },
  );
  const mixedHeader = await page.locator('.chat-header .chip').filter({ hasText: '本会话' }).first().innerText();
  assert.match(mixedHeader, /14,884 Tokens/);
  assert.match(mixedHeader, /\$0\.011117/);
  const mixedChip = page.locator('[data-testid="assistant-message"] .cost-chip').last();
  const mixedText = await mixedChip.innerText();
  assert.match(mixedText, /3,500 Tokens/);
  await mixedChip.click();
  const mixedDetails = await page.locator('[data-testid="assistant-message"] .cost-details').last().innerText();
  assert.match(mixedDetails, /¥/);
  assert.match(mixedDetails, /缓存读取/);
  record('同一会话切换服务商后按各自价格累计', mixedHeader.replace(/\s+/g, ' '));
  await screenshot(page, '11-mixed-provider-light');
  await page.keyboard.press('Escape');

  assert.equal(results.pageErrors.length, 0, `页面异常：${results.pageErrors.join(' | ')}`);

  await app.close();
  results.passed = true;
  console.log('\nUI 端到端测试全部通过');
} catch (error) {
  results.error = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error('\nUI 测试失败：', results.error);
  process.exitCode = 1;
} finally {
  if (app) {
    try {
      await app.close();
    } catch {
      // 已关闭或失败
    }
  }
  results.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(resultsDir, 'ui-results.json'), JSON.stringify(results, null, 2));
  console.log(`\n结果已写入 ${path.join(resultsDir, 'ui-results.json')}`);
}
