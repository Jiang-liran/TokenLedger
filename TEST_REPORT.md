# TokenLedger 测试报告

版本：**v1.0.1**
测试日期：2026-11-01
环境：macOS 27.0.1（arm64 / Apple Silicon）· Node 26.9.0 · Electron 45.2.1（Node 24.22.1）· TypeScript 7.0.2 · Vite 8.3.5 · Vitest 5.0.5 · electron-builder 26.18.0

## 1. 执行结果总览

| 检查项 | 命令 | 结果 |
|---|---|---|
| TypeScript 严格类型检查 | `npm run typecheck` | ✅ 0 错误 |
| 单元 + 集成测试 | `npm test` | ✅ **14 个文件 / 180 个用例全部通过** |
| Electron UI 端到端 | `npm run ui-test` | ✅ **28 项检查通过**，0 页面异常，0 console error |
| 打包应用冒烟 | `npm run package:smoke` | ✅ 4 项检查通过（本次钥匙串可用，未触发会话密钥分支） |
| 生产构建 | `npm run build` | ✅ 主进程、preload、渲染进程成功 |
| arm64 打包 | `electron-builder --mac --arm64` | ✅ `TokenLedger.app` + ZIP（未签名） |
| DMG | `hdiutil` / `diskutil image create` | ❌ 当前环境无法创建磁盘映像（如实记录） |

## 2. 自动化测试明细

### 2.1 Vitest（180）

| 文件 | 用例数 | 覆盖内容 |
|---|---:|---|
| `tests/usage.test.ts` | 11 | OpenAI/DeepSeek usage 规范化、缓存、推理、缺失字段 |
| `tests/cost.test.ts` | 16 | 普通输入、缓存读取、30m/12h 写入、长上下文、DeepSeek 峰谷、精度、FX |
| `tests/holidays.test.ts` | 14 | 上海时区峰谷边界、周末、节假日、覆盖外 unknown、用户覆盖 |
| `tests/providers.test.ts` | 20 | 两家请求体、能力适配、SSE 事件、模型别名、OpenAI max 钳制 |
| `tests/errors.test.ts` | 10 | 401/402/404/429/400/5xx、网络/超时/中止、日志脱敏 |
| `tests/stats.test.ts` | 11 | 聚合、币种、未知/部分、按用途汇总、日期分组 |
| `tests/budget-time.test.ts` | 12 | 四档预算、时间范围、自定义日期 |
| `tests/pricing-service.test.ts` | 13 | 快照、峰谷、别名、未配置、覆盖、FX、节假日 |
| `tests/secrets-export.test.ts` | 8 | 密文/权限、删除、不可用、会话密钥、Markdown/JSON/CSV |
| `tests/transport.test.ts` | 8 | 官方 URL/Authorization、OpenAI/DeepSeek SSE、HTTP 错误、余额 |
| `tests/chat-db.test.ts` | 30 | 请求/Turn/会话/全局、重生成、错误、中止、重启、备份、快照、重算 |
| `tests/context.test.ts` | 5 | OpenAI/DeepSeek 三轮上下文、跨服务商、重生成、失败轮次排除 |
| `tests/titles.test.ts` | 21 | AI 标题自动/手动全流程、费用、并发、失败、迁移语义、跨服务商 |
| `tests/migration.test.ts` | 1 | v1 → v2 迁移、迁移前备份、恢复旧账、旧请求标记 chat |

### 2.2 新增 AI 标题测试（重点）

- 首轮成功后自动请求标题，保存标题并计入 Turn 与会话费用；
- 第二轮普通聊天不再次自动命名；
- 独立标题模型（`gpt-6-luna`）按自身价格计费；
- 标题 usage 的缓存读取与推理 Token 不重复计费；
- 标题请求没有价格时仍可命名，但费用未知而非 0；
- 标题请求失败/无 usage/模型失败时聊天正常，请求保留；
- 自动命名关闭时不产生请求，使用首条消息备用标题；
- 用户手动改名后，自动任务不覆盖；
- 标题生成期间用户手动改名，完成后不覆盖且请求费用保留；
- 标题生成期间删除会话，费用仍保留在全局记录；
- 标题生成期间切换会话，标题写入正确的 conversation_id；
- 快速发送第二轮不会产生第二个自动标题；
- 自动任务与手动任务并发时第二次请求被拒绝；
- 多次手动重新生成标题会独立累计费用；
- “启动修复”为中断的自动标题补本地备用标题；
- 跨服务商未授权时不发请求；显式允许后使用 DeepSeek 并记录 CNY/USD；
- 历史升级会话不会被批量重命名；
- 全局按用途筛选与总额一致性。

### 2.3 Electron UI 端到端（28）

命令：`npm run ui-test`（真实 Electron 窗口，测试模式模拟流，不调用真实 API）

1. 应用启动并加载主界面
2. 测试模式密钥状态正常
3. 流式输出实时增长
4. 第一轮聊天 + AI 命名 Token/费用正确（5,692 Tokens / $0.005330）
5. 会话累计包含标题生成费用
6. 聊天底部重复的会话累计已移除，顶部与侧边栏保留
7. 第二轮后会话累计正确（11,192 / $0.010180）
8. 费用明细可展开，区分聊天与 AI 命名请求
9. 新建对话默认标题为「新对话」
10. 新建会话独立归零
11. 重新打开历史会话恢复累计
12. 全局统计汇总多会话多请求（16,884 / $0.015510）
13. 按服务商筛选并可恢复
14. 按请求用途筛选可区分聊天与 AI 标题生成
15. 版本号显示 1.0.1
16. 窄窗口无水平溢出，输入框不遮挡消息区
17. 设置页加载 API Key、AI 命名、汇率、预算与数据区
18. 用户停止生成后状态正确
19. 侧边栏不把未知费用显示为 $0
20. 停止后请求标记未知且不记为 $0
21. 数据库请求记录汇总（6 次，1 次未知）
22. API Key 未出现在数据目录明文文件中
23. API Key 未写入数据库记录
24. 重启后聊天与费用完整恢复
25. 重启后设置可读取
26. 用户手动改名后标题保持，不被自动命名覆盖
27. 手动 AI 重新生成标题并记录新增费用（11,384 / $0.010660）
28. 同一会话切换服务商后按各自价格累计（14,884 Tokens）

页面异常 0，console error 0。

截图：`docs/screenshots/`（12 张，含浅色、深色、设置、窄窗口、混合服务商、打包应用）。

### 2.4 打包应用检查

命令：`npm run package:smoke`
对象：`release/mac-arm64/TokenLedger.app/Contents/MacOS/TokenLedger`

- 打包应用启动、版本 1.0.1、preload 正常；
- 打包应用聊天 + AI 标题 + 计费正常（5,692 / $0.005330）；
- 生产模式启动正常；本次 macOS 钥匙串 safeStorage 可用；
- 会话密钥回退路径已由单元测试与前一版打包测试覆盖（本次因钥匙串可用未触发 UI 分支）。

## 3. 多轮上下文检查结果

现有实现：

- **OpenAI**：Responses API `store:false` + 完整本地 `input`，**不使用** `previous_response_id`；
- **DeepSeek**：Chat Completions 完整本地 `messages`；
- 跨服务商：只传 user/assistant 文本，不传 response id、Key 或内部元数据；
- 失败/中止/中断的 Turn 整轮排除，避免孤立的用户消息进入后续请求；
- 重新生成时排除被替换的 assistant 消息；
- DeepSeek `reasoning_content` 不重传。

回归测试逐轮读取实际构造的 `StreamRequest.messages`：

- OpenAI 第 2 轮 = 第一轮 user + assistant + 新 user；第 3 轮 = 前两轮完整对话 + 新 user；
- DeepSeek 同样验证三轮完整历史；
- OpenAI → DeepSeek 切换后，DeepSeek 请求包含本地可见历史；
- 重新生成只包含本轮 user，不包含被 superseded 的 assistant。

### 关于“102 输出 / 59 输入”的现象

无法在没有用户当时原始请求/响应日志的情况下给出确定解释，因此不做臆测。当前实现的请求级测试证明：后续请求确实携带完整本地历史，且没有使用服务端 response id；不同模型、tokenizer、缓存/隐藏系统提示、流式 usage 的统计口径都可能造成数字观感差异。若需要定位，建议保留该轮 `api_requests.raw_usage` 与 `request_parameters` 后复核。

## 4. 数据库迁移与备份

- 迁移版本从 1 升级到 **2**：新增标题来源/版本/生成时间/自动尝试时间；`api_requests` 新增 `request_purpose`，`turn_id` 允许 NULL。
- 旧请求全部标记为 `chat`；旧会话标记为 `first_message` 且 `auto_title_attempted_at` 预填，**不会批量自动重命名**。
- 迁移在事务中执行；启动前用 `VACUUM INTO` 生成 `backups/pre-migration-v1-*.db`。备份失败则中止启动。
- `tests/migration.test.ts` 使用真实 v1 结构 DB 验证：
  - 旧会话、旧请求、旧费用保留；
  - 旧请求 purpose=chat；
  - 旧备份可被新版本打开并迁移；
  - 迁移前备份不包含 v2 字段，确认是真实旧快照。

## 5. 构建与产物

- `release/mac-arm64/TokenLedger.app`：273 MB（Electron 框架为主）
- `release/TokenLedger-1.0.1-arm64.zip`：113 MB
- 应用 `CFBundleIdentifier`：`com.tokenledger.desktop`；版本 1.0.1；最低 macOS 12
- 签名：**未签名、未公证**（`identity: null`，`CSC_IDENTITY_AUTO_DISCOVERY=false`）
- 未生成 DMG：当前环境 `hdiutil` / `diskutil image create` 无法创建磁盘映像

SHA-256：

```
zip  f559603e778a86dffbeba1d7740c4b4b40bb76840b414c76fcc46f8e4fce4612
asar bf7e067547ac123787b6bac6c72e31c56691f42ae2ed43a23f70ff69d450850c
```

> 构建产物为本地验证产物，不提交到公开源代码仓库。

## 6. 未验证项目（如实记录）

1. **真实 OpenAI / DeepSeek API 调用**：未使用真实 Key，避免费用；请求构造、SSE、usage 与错误映射由 Mock HTTP/模拟流覆盖，真实账号权限、地区限制、官方账单仍未验证。
2. **真实生产 Keychain 长期行为**：本次打包运行显示 safeStorage 可用，但未写入真实 Key；会话密钥/密钥不可用分支由模拟后端测试。
3. **DMG 与公证**：环境无法生成 DMG；应用未签名、未公证。
4. **标题模型真实输出质量**：Mock 返回固定标题；真实模型的中文标题质量、拒绝/超时行为需真实调用验证。
5. **无障碍审计、超大数据量压力、真实网络代理/断网**：未做专项验证。

## 7. 本次修复/加固记录

| 问题 | 处理 |
|---|---|
| 失败/中止轮次的孤立用户消息会进入下一轮上下文 | 上下文只纳入已有成功 assistant 的 Turn，并添加回归测试 |
| 标题费用未归集 | 新增 `request_purpose`、价格快照、Turn 关联、全局用途筛选 |
| 标题可能覆盖用户手动标题 | 标题来源 + 版本乐观并发；请求开始后手动改名会使标题更新失败 |
| 自动标题重复 | `auto_title_attempted_at` 原子置位 + 每次会话任务锁 |
| 标题请求失败影响聊天 | 异步触发、失败回退本地标题、请求费用单独保留 |
| 底部重复会话累计 | 移除聊天底部总费用，保留顶部与侧边栏 |
| 历史请求无法升级 | 迁移 v2 重建 api_requests，保留旧字段/费用 |
| 迁移前无安全备份 | `VACUUM INTO` 一致性备份，失败中止启动 |
| 统计明细阅读困难 | 增大字号/对比度、等宽数字、请求模型/用途/价格版本、可滚动表格 |
| 窄窗口头部换行 | 隐藏次要筛选提示、固定 tabs 尺寸、页面标题不换行 |

## 8. 复现命令

```bash
npm install
npm run typecheck
npm test
npm run build
npm run ui-test
npm run package:smoke
npm run dist:mac
```
