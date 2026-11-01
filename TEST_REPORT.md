# TokenLedger 测试报告

测试日期：2026-11-01
环境：macOS 27.0.1（arm64 / Apple Silicon）· Node 26.9.0 · Electron 45.2.1（Node 24.22.1）· TypeScript 7.0.2 · Vite 8.3.5 · Vitest 5.0.5 · electron-builder 26.18.0

## 1. 执行结果总览

| 检查项 | 命令 | 结果 |
|---|---|---|
| TypeScript 严格类型检查（主/渲染/测试） | `npm run typecheck` | ✅ 0 错误 |
| 单元 + 集成测试 | `npm test`（Vitest） | ✅ 11 个文件 / **152 个用例全部通过** |
| 生产构建 | `npm run build` | ✅ 主进程、preload、渲染进程均成功 |
| Electron UI 端到端 | `npm run ui-test` | ✅ 22 项检查通过，0 页面异常，0 console error |
| 打包应用冒烟 | `npm run package:smoke` | ✅ 5 项检查通过（测试模式 / 生产模式 / 会话密钥） |
| arm64 打包 | `electron-builder --mac --arm64` | ✅ `.app` + ZIP；未签名 |
| DMG | `electron-builder` / `hdiutil` / `diskutil` | ❌ 当前环境无法创建磁盘映像（已记录，不伪造） |

## 2. 自动化测试明细

### 2.1 Vitest（152）

| 文件 | 用例数 | 覆盖内容 |
|---|---:|---|
| `tests/usage.test.ts` | 11 | OpenAI/DeepSeek usage 规范化、缓存读写、推理、缺失字段、汇总 |
| `tests/cost.test.ts` | 16 | OpenAI 输入/缓存/TTL/长上下文、DeepSeek 峰谷/模型差异、精度、汇率、未知 |
| `tests/holidays.test.ts` | 14 | 上海时区峰谷边界、周末、节假日、未覆盖、用户覆盖、覆盖范围 |
| `tests/providers.test.ts` | 20 | 两家请求体、能力适配、SSE 解析、事件/usage、模型别名与前缀 |
| `tests/errors.test.ts` | 10 | 401/402/404/429/400/5xx、网络/超时/中止、日志脱敏 |
| `tests/stats.test.ts` | 10 | 聚合、币种、未知、部分、会话/全局分组、缓存命中、日期 |
| `tests/budget-time.test.ts` | 12 | 四档预算、关闭、未设上限、今日/本周/本月/全部/自定义范围 |
| `tests/pricing-service.test.ts` | 13 | 快照、峰谷、别名、未配置、用户覆盖、自定义模型、汇率、节假日 |
| `tests/secrets-export.test.ts` | 8 | 密文/权限、删除、不可用、会话密钥不落盘、Markdown/JSON/CSV、无 Key 泄漏 |
| `tests/transport.test.ts` | 8 | 官方 URL/Authorization/请求体、OpenAI/DeepSeek SSE、HTTP 错误、流中断、模型/余额 |
| `tests/chat-db.test.ts` | 30 | 真实 Store + ChatService + 临时 SQLite 的完整业务流程（见下） |

`chat-db.test.ts` 覆盖：

- 首次请求保存官方 usage、价格快照、精确费用；标题本地生成；
- 请求开始时写入 streaming 记录；
- 第二轮上下文、会话累计、新会话归零；
- 同一会话 OpenAI → DeepSeek 混合计费（USD + CNY + USD 折算）；
- 重新生成：同一 Turn 两次请求、旧回复 superseded、费用不丢；
- 无 usage：回答保留、费用未知非 0；
- 流式错误：部分文本保留、请求 error、费用未知；
- 停止生成：aborted、部分文本、费用未知；
- 缺少 Key / 空消息 / 未知价格模型；
- DeepSeek 空闲时段 5 折、未来日期日历未覆盖 → 未知；
- 价格覆盖只影响新请求、旧快照与旧费用不变；
- 历史费用重算 + 审计日志（旧/新费用、旧/新快照）；
- 预算提醒集成；
- 关闭并重开 SQLite 后完整恢复；
- 异常退出 streaming → interrupted；
- 软删除保留全局费用、彻底删除移除；
- 全量备份恢复、未知表注入拒绝；
- 归档不影响费用；
- 删除全部数据保留设置。

### 2.2 Electron UI 端到端（Playwright）

命令：`npm run ui-test`
方式：真实 Electron 窗口 + 受限测试模式（模拟流，不访问真实 API），DOM 驱动输入/点击，`page.screenshot` 截图。

通过项（22）：

1. 应用启动并加载主界面
2. 测试模式密钥状态正常
3. 流式输出实时增长（文本长度递增）
4. 第一轮 Token 与费用正确（5,500 Tokens / $0.004850）
5. 会话累计第一轮正确
6. 第二轮后会话累计正确（11,000 / $0.009700）
7. 费用明细可展开，显示缓存读取与输入
8. 新建会话独立归零
9. 重新打开历史会话恢复累计
10. 全局统计汇总多会话多请求（16,500 Tokens / $0.014550）
11. 按服务商筛选全局统计并可恢复
12. 版本号显示 1.0.0
13. 设置页加载 API Key、汇率、预算与数据区
14. 用户停止生成后状态正确
15. 停止后请求标记 unknown，`cost_amount = NULL`（不是 $0）
16. 数据库请求记录汇总（4 次请求，1 次未知）
17. API Key 未出现在数据目录明文文件中
18. API Key 未写入数据库记录
19. 重启后聊天与费用完整恢复（11,000 / $0.009700）
20. 重启后设置可读取
21. 同一会话切换服务商后按各自价格累计（14,500 Tokens），明细显示人民币原生费用与美元折算
22. 停止生成的会话在侧边栏显示“用量未知 / 费用未知”，不显示 $0.000000

页面异常：0；console error：0。

截图（`docs/screenshots/`）：

- `01-welcome-light.png`
- `02-chat-light.png`
- `03-usage-light.png`
- `04-settings-light.png`
- `05-usage-dark.png`
- `06-settings-dark.png`
- `07-chat-dark.png`
- `08-restart-light.png`
- `09-packaged-test-mode.png`
- `10-packaged-onboarding.png`
- `10b-packaged-session-key.png`
- `11-mixed-provider-light.png`

### 2.3 打包应用检查（5）

命令：`npm run package:smoke`
对象：`release/mac-arm64/TokenLedger.app/Contents/MacOS/TokenLedger`

1. 打包应用启动、版本号 1.0.0、preload 正常；
2. 渲染进程没有 `window.require`（无 Node 权限）；
3. 打包应用聊天与计费正常（5,500 / $0.004850）；
4. 生产模式启动正常，未配置 Key 时显示配置引导；
5. 安全存储不可用时，“仅本次运行”密钥只保存在内存，`secrets.json` 未创建。

截图：`09-packaged-test-mode.png`、`10-packaged-onboarding.png`、`10b-packaged-session-key.png`。

## 3. 需求验收场景对照

| # | 要求 | 验证方式 | 结果 |
|---:|---|---|---|
| 1 | OpenAI 请求构造 | `providers.test.ts` 请求体断言 | ✅ |
| 2 | DeepSeek 请求构造 | `providers.test.ts` / `transport.test.ts` | ✅ |
| 3 | 模型切换 | 同会话 OpenAI→DeepSeek；模型能力适配测试 | ✅ |
| 4 | 多轮上下文 | `chat-db` 上下文消息断言 | ✅ |
| 5 | 流式解析 | SSE 单元测试 + OpenAI/DeepSeek mock SSE + UI 流式增长 | ✅ |
| 6 | API 错误显示 | 状态码映射 + 流中断 + UI 停止/错误 | ✅ |
| 7 | 输入/输出 Token 保存 | `chat-db` | ✅ |
| 8 | 缓存读取不重复 | usage/cost 断言 | ✅ |
| 9 | 缓存写入不重复 | 30m/12h 分项计价断言 | ✅ |
| 10 | 推理不重复 | 有无 reasoning 费用相同 | ✅ |
| 11 | usage 缺失显示未知 | 无 usage 请求 → unknown，非 0 | ✅ |
| 12 | 多请求汇总同一 Turn | 重新生成 2 次请求，Turn 2 次、费用相加 | ✅ |
| 13 | OpenAI 普通输入计价 | $0.004850 已知答案 | ✅ |
| 14 | OpenAI 缓存读取计价 | $0.00045 分项断言 | ✅ |
| 15 | TTL 缓存写入计价 | 0.0075 + 0.02 = 0.0399 | ✅ |
| 16 | DeepSeek 命中/未命中 | CNY 0.00608 | ✅ |
| 17 | DeepSeek 峰谷 | 高峰 0.00608 / 空闲 0.00304 | ✅ |
| 18 | 节假日规则 | 2026-10-01 高峰时段仍为空闲；覆盖外 unknown | ✅ |
| 19 | 不同模型价格 | flash vs v4-pro；gpt-6.1-sol vs gpt-5.5 | ✅ |
| 20 | 历史价格快照不被覆盖 | 覆盖价格后旧请求仍 0.00485、旧快照 2.00 | ✅ |
| 21 | 小额费用精度 | $0.0000005 不显示成 $0.000000 | ✅ |
| 22 | CNY → USD 折算 | 0.00608 CNY → 0.00091387872 USD | ✅ |
| 23 | 第一轮统计 | chat-db / UI | ✅ |
| 24 | 第二轮累计 | chat-db / UI | ✅ |
| 25 | 新建会话归零 | chat-db / UI | ✅ |
| 26 | 重开历史会话恢复 | chat-db 重开 SQLite / UI 重启 | ✅ |
| 27 | 同会话切换模型 | 多模型价格与按请求快照；切换服务商覆盖 | ✅ |
| 28 | 混合服务商累计 | 会话 USD+CNY+美元折算；UI 用量页 | ✅ |
| 29 | 重生成不漏记 | 同 Turn 2 请求、费用 0.0097 | ✅ |
| 30 | 多会话全局统计 | 3 次请求 / 2 会话 / 16,500 Tokens | ✅ |
| 31 | 断网/错误不崩溃 | 网络错误映射、流错误、UI 错误保留 | ✅（模拟） |
| 32 | 停止生成状态 | aborted + 部分文本 + 未知费用（UI/DB） | ✅ |
| 33 | 无最终 usage 不虚报 | costAmount NULL、calculation_status unknown | ✅ |
| 34 | SQLite 重启完整 | 关闭/重开数据库、UI 重启 | ✅ |
| 35 | Key 不在日志/数据库/磁盘 | 单元 + UI 扫描数据目录 + DB 查询 | ✅ |
| 36 | 应用重启可用 | UI 重启 + 打包应用启动 | ✅ |

## 4. 构建与产物

> 以下为本地验证构建产物，未提交到公开 Git 仓库；仓库只包含源代码、测试与文档。

- `dist/main/index.js`：1.0 MB（esbuild，CJS）
- `dist/preload/index.js`：约 5 KB
- `dist/renderer/`：Vite 产物（JS ≈ 962 KB，CSS ≈ 68 KB，KaTeX 字体）
- `release/mac-arm64/TokenLedger.app`：273 MB（Electron 框架为主）
- `release/TokenLedger-1.0.0-arm64.zip`：113 MB
- `app.asar`：70 个文件，不含 `node_modules`（依赖已打包），无源码/测试文件
- `CFBundleIdentifier`：`com.tokenledger.desktop`；版本 1.0.0；最低 macOS 12
- 签名：**未签名、未公证**（`identity: null`，`CSC_IDENTITY_AUTO_DISCOVERY=false`）

SHA-256：

```
zip  2267585681de997a78aa95c64028a016f12510e2cb0ea8cbeff7bd64a71bdbde
asar adb0e6f32c0d2250cfefcc0d6cc2765b4fa789b928b37abf3c8affd760a06614
```

> 注：此哈希对应最终构建；若之后修改源码并重新打包，请以新产物为准。

## 5. 未验证项目（如实记录）

1. **真实 OpenAI / DeepSeek API 调用**：未使用真实 API Key，避免产生费用。请求构造、SSE 解析、错误映射、usage 计费由 Mock HTTP 与集成测试覆盖；真实模型权限、地区限制、官方最终账单未验证。
2. **真实 macOS 钥匙串写入**：自动化环境钥匙串加密自检失败，测试使用内存/模拟后端；真实桌面会话中的 Keychain 保存与系统弹窗需用户首次配置时确认。已实现仅内存回退并通过打包应用测试。
3. **DMG 与公证**：当前环境无法创建 DMG；未签名、未公证。
4. **辅助功能（VoiceOver）与完整键盘导航**：未做专门的无障碍测试；主要按钮有 aria-label，但未逐项审计。
5. **长时间/大数据量压力测试**：未测试数万条消息、超大上下文的性能与内存占用。
6. **真实网络代理、企业 TLS、断网切换**：仅通过错误映射与 mock 流验证，未在真实网络故障下跑完整 UI。
7. **OpenAI Billing 页面 / DeepSeek 余额真实响应**：余额接口已用 mock 验证字段映射；真实响应需用户 Key。

## 6. 失败与修复记录

| 问题 | 修复 |
|---|---|
| 首次启动迁移失败（`schema_migrations` 重复建表） | 迁移 SQL 移除重复建表；单元/Electron 实测通过 |
| 测试环境 `ELECTRON_RUN_AS_NODE=1` 导致 Electron 变 Node | 测试脚本删除该环境变量；正式包不受影响 |
| Electron 下载器卡住 | 直接下载官方 zip、解压并写 `path.txt` |
| TS7 移除 baseUrl | 调整 tsconfig 为相对导入 |
| Electron 45 弃用同步 safeStorage | 改用异步 API + 加密自检 + 会话密钥回退 |
| 打包首次含 63MB node_modules | `files` 排除 `node_modules`，asar 缩减为 70 个文件 |
| DMG 构建失败 | 改交付 ZIP + `.app`，文档说明环境限制 |
| UI 测试 StrictMode 丢失事件 | 拆分 bootstrap 与订阅 effect |
| Playwright 定位歧义 | 使用 exact / first 修正 |

## 7. 复现命令

```bash
npm install
npm run typecheck
npm test
npm run build
npm run ui-test
npm run dist:mac          # 需要 electron-builder 缓存可写
npm run package:smoke
```

（`dist:mac` 当前配置为 zip + dir，不含 DMG。）
