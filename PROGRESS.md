# 开发进度

最后更新：2026-11-01

## 当前状态

**开发、测试、打包均已完成。** 交付物为 Apple Silicon 应用、ZIP 安装包、完整源码与文档。

## 阶段进度

| 阶段 | 内容 | 状态 |
|---|---|---|
| A | 工程准备、依赖、Git、目录结构、架构与数据库设计 | ✅ 完成 |
| B | 主进程、React 前端、SQLite、密钥存储、OpenAI/DeepSeek 适配、流式聊天、历史管理 | ✅ 完成 |
| C | Usage 规范化、价格目录、Decimal 计费、三级统计、价格快照、汇率、余额 | ✅ 完成 |
| D | 主界面、Markdown/KaTeX/代码高亮、模型选择、设置、统计页、明暗模式、交互与错误提示 | ✅ 完成 |
| E | 类型检查、单元/集成/传输/UI 端到端测试、构建、修复 | ✅ 完成 |
| F | arm64 `.app` 与 ZIP、README、架构、测试报告、已知限制 | ✅ 完成（DMG 受环境限制） |

## 已完成模块

- Electron 主进程：窗口安全策略、单实例、菜单、生命周期、崩溃后中断恢复。
- IPC：白名单通道、Zod 参数校验、来源校验、预加载 bridge、错误脱敏。
- SQLite：版本化迁移、WAL、外键、事务、软删除/彻底删除、会话/消息/Turn/请求/价格快照/汇率/覆盖/节假日/重算日志。
- API Key：Electron 45 异步 safeStorage、自检、0600 密文、内存会话回退、脱敏日志。
- OpenAI：Responses API 无状态历史、推理强度能力适配、SSE 事件、usage 缓存读取/写入 TTL、错误映射。
- DeepSeek：Chat Completions、`include_usage`、思考模式/强度、reasoning_content、余额、模型列表、峰谷与节假日。
- 聊天：流式显示、停止、重新生成、上下文截断、价格快照、失败/中止/未知用量。
- 计费：OpenAI 普通/缓存/缓存写入/长上下文、DeepSeek CNY 峰谷/缓存/输出、FX 折算、Decimal 精度、未知不填零。
- 统计：请求 / Turn / 会话 / 全局，日期与服务商/模型筛选，缓存命中，未知费用计数。
- 界面：macOS 风格侧边栏、聊天气泡、费用明细、会话统计、用量页、设置页、余额弹窗、Toast、确认框、明暗主题。
- 数据：Markdown/JSON/CSV 导出、全量备份/恢复、删除全部数据、历史费用重算与审计。
- 测试：152 个 Vitest 用例、22 项 Electron UI 端到端检查、5 项打包应用检查。

## 开发中遇到并已解决的问题

1. **环境中 `ELECTRON_RUN_AS_NODE=1` 全局存在**：直接运行 Electron 会进入 Node 模式，`require('electron')` 返回路径字符串。测试/开发脚本显式移除该变量；打包应用不受影响。
2. **Electron 二进制通过 `@electron/get` 下载卡住**：改为直接下载官方 zip 并解压到 `node_modules/electron/dist`，写入 `path.txt`。
3. **TypeScript 7 移除 `baseUrl` / 非相对 paths**：调整 tsconfig，全部使用相对导入。
4. **迁移中重复创建 `schema_migrations`**：导致首次迁移回滚，已从迁移 SQL 中移除重复建表。
5. **Electron 45 弃用同步 safeStorage**：切换到 `isAsyncEncryptionAvailable` / `encryptStringAsync` / `decryptStringAsync`，并增加加密自检；受限环境中自检失败时提供仅内存密钥。
6. **受限沙箱无法初始化 Chromium OS 沙箱**：仅在 `TOKENLEDGER_TEST_MODE=1` 时追加 `--no-sandbox`；正式应用保留沙箱。打包验证同样使用测试开关。
7. **DMG 创建失败**：`electron-builder` 的 dmgbuild 调用 `hdiutil` 报 `plistlib.InvalidFileException`；手动 `hdiutil` 报“目录非空”，macOS 27 `diskutil image create from` 报 OSStatus 1。改用 ZIP + `.app`，并在 README 说明。
8. **React StrictMode 下事件订阅被清理**：拆分 bootstrap 与事件订阅 effect，避免第二次挂载后丢失流式事件。
9. **Playwright 定位冲突**：`设置` 与“前往设置”同名，使用 `exact: true`；“仅本次运行”存在两个服务商按钮，使用 `.first()`。
10. **测试中费用期望值笔误**：修正为 0.01061387872 等精确值，保持断言基于真实算式。

## 未解决问题 / 已知限制

- **真实 API 未验证**：没有用户提供的 API Key，且不得擅自产生费用。官方请求构造、SSE、错误映射由 Mock HTTP 与集成测试覆盖；真实账号的模型权限、地区限制与官方最终账单需用户自行核对。
- **DMG 未生成**：当前 macOS 27 + 受限沙箱无法创建磁盘映像；已提供 `.app` 与 ZIP。
- **未签名 / 未公证**：无 Developer ID；README 说明 Gatekeeper 处理方式。
- **真实钥匙串保存未在正常桌面会话验证**：受限环境中自检失败，已通过仅内存密钥分支保证可用性；真实桌面通常可正常使用 Keychain。
- 仅 arm64；无自动更新；无遥测。

## 下一步（交付后可选）

- 在真实 macOS 会话中填写两家 Key，验证模型列表、流式 usage、余额与真实账单对账。
- 使用 Developer ID 签名、公证并生成 DMG。
- 根据官方调价在设置中覆盖价格，或更新 `src/shared/pricing/catalog.ts` 与价格版本。
