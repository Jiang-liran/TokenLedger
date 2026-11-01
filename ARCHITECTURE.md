# TokenLedger 技术架构

版本：1.0.0 · 价格核对日期：2026-11-01

## 1. 总体结构

```
src/
├── main/                    Electron 主进程（Node 环境）
│   ├── index.ts             生命周期、窗口、菜单、服务装配
│   ├── ipc.ts               白名单 IPC + Zod 参数校验 + 来源校验
│   ├── db/
│   │   ├── database.ts      连接、PRAGMA、事务、迁移
│   │   └── repositories.ts  会话/消息/请求/快照/统计/备份
│   └── services/
│       ├── chat.ts          聊天编排、上下文、错误与中断收敛
│       ├── transport.ts     官方 HTTP/SSE 客户端、错误映射
│       ├── pricing.ts       价格目录、覆盖、峰谷、快照、重算
│       ├── fx.ts            ECB 汇率（仅用户主动触发）
│       ├── models.ts        官方模型列表 + 内置回退
│       ├── balance.ts       DeepSeek 余额
│       ├── secrets.ts       safeStorage 密钥存储
│       ├── budget.ts        本地预算提醒
│       ├── export.ts        导出对话框与写文件
│       ├── export-format.ts Markdown / JSON / CSV 纯函数
│       ├── backup.ts        全量备份 / 恢复
│       ├── mock.ts          仅测试模式的模拟流
│       └── logger.ts        脱敏日志
├── preload/index.ts         contextBridge 白名单 API
├── renderer/                React 界面（无 Node 权限）
│   ├── App.tsx / store.ts   zustand 状态与 IPC 事件处理
│   ├── components/          聊天、费用、统计、设置、余额
│   └── styles.css           设计系统与明暗主题
└── shared/                  纯 TS 领域层（主/渲染/测试共用）
    ├── types.ts             API 与领域类型
    ├── usage.ts             usage 规范化
    ├── stats.ts             精确聚合
    ├── pricing/             价格目录、峰谷、节假日
    ├── cost/                Decimal 计费引擎与格式化
    ├── providers/           请求构造、SSE、事件解析、错误
    ├── settings.ts          设置默认值与合并校验
    ├── ipc.ts               IPC 通道与 preload 接口类型
    └── time.ts              统计日期范围
```

构建产物：

- `dist/main/index.js`、`dist/preload/index.js`：esbuild 打包为 CJS（仅 `electron` 外部化）；
- `dist/renderer/`：Vite 构建的静态 SPA；
- `release/mac-arm64/TokenLedger.app`：electron-builder 生成的 arm64 应用（未签名）。

## 2. 进程隔离与安全边界

| 能力 | 主进程 | 渲染进程 |
|---|---|---|
| API 网络通信 | ✅ | ❌（CSP `connect-src 'none'`） |
| API Key 读写 | ✅ | ❌（仅知道是否已配置） |
| SQLite | ✅ | ❌ |
| Token / 费用计算 | ✅ | ❌（只展示主进程返回的结果） |
| Markdown/KaTeX 渲染 | ❌ | ✅ |
| 系统文件对话框 | ✅ | 通过主进程 |
| 外部链接 | 白名单 + `shell.openExternal` | 只能请求主进程打开 |

窗口配置：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、`webviewTag: false`；禁止新窗口与页面导航；拒绝所有权限请求（摄像头、麦克风、通知等）。

IPC 安全：

1. 只注册 `src/shared/ipc.ts` 中列出的通道；
2. 每个处理器校验 `event.sender === 主窗口 webContents` 与 `senderFrame.url`（`file://` 或开发服务器）；
3. 每个 payload 使用 Zod 校验类型、长度与枚举；
4. 错误统一脱敏后返回，不泄漏堆栈或密钥；
5. preload 不暴露 `ipcRenderer` 原始对象。

CSP（生产）：

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; font-src 'self' data:; connect-src 'none';
object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

## 3. 数据模型

SQLite（Node 内置 `node:sqlite`；WAL、`foreign_keys=ON`、`busy_timeout=5000`）。迁移记录在 `schema_migrations`，当前版本 1。选择内置驱动而非原生模块，避免 Electron ABI 重编译并让主进程与 Vitest 使用同一 SQLite 实现。

```
conversations 1 ─── n turns 1 ─── n messages
      │                  │
      │                  └──── n api_requests ─── 1 pricing_snapshots
      │                                      └── 0..1 exchange_rate_snapshots
      └──────────────── n messages
```

### conversations

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | UUID |
| title | TEXT | 第一条用户消息本地截取，不调用模型 |
| created_at / updated_at | TEXT ISO | |
| archived_at | TEXT NULL | 归档不删除数据、不剔除全局费用 |
| deleted_at | TEXT NULL | 软删除：从列表隐藏，费用仍计入全局 |
| default_provider / default_model | TEXT | 会话内可切换，发送时更新 |
| system_prompt | TEXT NULL | 预留 |

### turns

| 字段 | 说明 |
|---|---|
| id | TEXT PK |
| conversation_id | FK → conversations，级联删除 |
| user_message_id | 指向本轮用户消息（逻辑关联） |
| created_at | ISO |
| status | running / completed / error / aborted / interrupted |
| attempt_count | 第几次生成（重新生成递增） |

### messages

`role`（system/user/assistant）、`content`、`reasoning_content`、`model`、`provider`、`status`（streaming/complete/error/superseded）、`attempt`、`superseded_at`、`error_details`。重新生成时旧回复置为 superseded，但保留内容与关联请求。

### api_requests（核心账本，每次真实请求一行）

| 字段 | 说明 |
|---|---|
| id | 内部请求 UUID |
| provider_request_id | 服务商返回的 response id / chat id（若有） |
| conversation_id / turn_id / assistant_message_id | 归属 |
| provider / model | 当时的服务商与模型 |
| started_at / ended_at | UTC ISO |
| status | streaming / completed / error / aborted / interrupted |
| request_parameters | JSON：API 类型、上下文条数、截断标记、推理设置、价格快照 ID（不含消息正文） |
| raw_usage | 服务商原始 usage JSON |
| normalized_usage | 规范化 usage JSON（null 表示未知） |
| pricing_snapshot_id | FK → pricing_snapshots |
| cost_amount / cost_currency | 原生币种的高精度十进制字符串 |
| cost_usd | 折算美元（可能为 NULL） |
| exchange_rate_snapshot_id | 折算所用汇率快照 |
| calculation_status | calculated / partial / unknown |
| pricing_basis | 峰谷/长上下文/覆盖等计价依据 |
| error_details | 可读错误与费用未知原因 |

请求在发送前先插入 `streaming` 行；完成/失败/中止时在同一事务中更新消息、请求、Turn 与会话时间。应用启动时把遗留的 `streaming` 请求标记为 `interrupted`，把 `streaming` 消息标记为 `error`，保留已收到的部分内容。

### pricing_snapshots（不可变）

provider、model、pricing_version、price_source、effective_at、currency、billing_tier、四类单价（输入 / 缓存读取 / 缓存写入 30m / 12h / 输出）、long_context_json、pricing_basis、is_user_override、notes_json、created_at。历史请求永远引用当时快照；修改目录价格不会改变旧行。

### 安全存储与回退

- 使用 Electron 45 推荐的 **异步** `safeStorage.isAsyncEncryptionAvailable()`、`encryptStringAsync()`、`decryptStringAsync()`；同步接口已弃用，不使用。
- 启动后做一次自检（加密/解密固定探针），只有真正可加解密才把状态显示为可用。
- 默认密钥密文写入 `secrets.json`（0600）。
- 自检失败时允许“仅本次运行”：密钥只保存在主进程内存 Map 中，`getKey` 优先返回会话密钥；不会创建 `secrets.json`，退出即失效。界面对此有明确说明。
- `decryptStringAsync` 返回 `shouldReEncrypt` 时，重新加密并更新密文，遵循密钥轮换建议。

### exchange_rate_snapshots

base/quote/rate/source/source_url/effective_at/fetched_at/is_user_configured。每个 DeepSeek 请求折算美元时引用一个快照。

### 其它

- `price_overrides`：用户覆盖的价格（含低谷价、币种、来源、生效日期）。
- `holiday_overrides`：节假日的 add/remove 覆盖。
- `cost_recalculation_log`：历史重算审计（请求 ID、新旧费用、新旧快照 ID、原因、时间）。
- `settings`：单个 `app` JSON（默认模型、上下文上限、汇率、预算、节假日覆盖截止、显示偏好）。

## 4. Usage 规范化

规范结构 `NormalizedUsage`：

```
inputTokens             输入总量（含缓存读取/写入）
uncachedInputTokens     普通输入 = input - cacheRead - cacheWrite
cacheReadTokens         缓存读取
cacheWriteTokens        缓存写入总量
cacheWrite30mTokens     30 分钟缓存写入
cacheWrite12hTokens     12 小时缓存写入
outputTokens            输出
reasoningTokens         推理（已包含在输出中）
totalTokens             服务商 total（缺失则为 null）
```

规则：

- 字段缺失记 `null`，绝不填 0；`cacheWrite=0` 只用于“模型不支持缓存写入/DeepSeek 不收费”这种明确的不适用情形。
- OpenAI：解析 `input_tokens_details.cached_tokens`、`cache_write_tokens`、`cache_write_tokens_details.ttl_30m_tokens/ttl_12h_tokens`；两类写入互不重叠，**不再额外加 cache_write_tokens**。
- DeepSeek：`prompt_cache_hit_tokens` + `prompt_cache_miss_tokens = prompt_tokens`；不一致时报告问题并降低完整度。
- `reasoning_tokens` 永不与输出相加。
- 完整度：`complete / partial / missing`；展示层据此显示“未知”。

## 5. 价格、峰谷与汇率

### 价格目录

`src/shared/pricing/catalog.ts` 是**数据模块**，内置 2026-11-01 核对的官方价格：

- OpenAI：GPT-6 / 6.1 / 6 Luna、GPT-5.6 / 5.5 / 5.4 / 5.2 / 5.1 / 5、GPT-4.1 / 4o、o1/o3/o4 等；含缓存读取、缓存写入 30m/12h、长上下文（>272K 输入）价格；币种 USD。
- DeepSeek：`deepseek-flash`、`deepseek-v4-pro`；高峰/空闲两套 CNY 价格；别名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 按 Flash 计价。

每条价格记录包含：provider、model、pricingVersion、priceSource、lastVerifiedAt、effectiveFrom、currency、tariff、standard/offPeak 表、longContext、capabilities、status、notes、aliases。

解析顺序：精确 ID → 官方别名 → 最长前缀（兼容日期后缀）。未匹配 = 费用未知。

### 价格快照

请求开始时：

1. 合并内置价格与用户覆盖；
2. DeepSeek 依据请求发起时刻（Asia/Shanghai）与节假日日历选择高峰/空闲档；
3. 写入 `pricing_snapshots`（含档位、实际单价、依据、来源、版本）；
4. 计费只读取快照，不重新查当前目录。

用户可在设置中按模型覆盖单价（留空字段沿用内置），并可显式触发“按当前价格重新核算历史费用”。重算会生成新快照、更新请求费用，并把旧费用/新费用/新旧快照写入 `cost_recalculation_log`，原快照行保留。

### DeepSeek 峰谷

- 时区固定 `Asia/Shanghai`，用 `Intl.DateTimeFormat` 取日期、时间、星期，避免依赖系统时区。
- 高峰：周一至周五、非法定节假日、09:00–12:00 或 14:00–18:00。
- 空闲：其余时间，价格为高峰 50%（目录中显式给出两套价格）。
- 节假日数据内置 2025–2026 并支持用户 add/remove；`coverageEnd` 是显式设置，必须由用户确认后延长。
- 超出覆盖范围且用户未允许估算 → `billing_tier = unknown` → 费用未知；允许估算时在 `pricing_basis` 标注“估算”。

### 汇率

- 内置种子：ECB 2026-10-30 参考汇率（EUR/CNY 7.4326、EUR/USD 1.1172）折算 CNY→USD = 0.150309。
- 用户可手动填写并保存；也可点击「ECB」主动请求官方 XML 更新（只在用户点击时发生）。
- 每次汇率变更写入 `exchange_rate_snapshots`，并同步 settings。
- 折算只用于展示与跨币种汇总，不代表官方美元扣款；界面上带 `≈`。

## 6. 计费引擎

`src/shared/cost/engine.ts` 使用 decimal.js（precision 40）：

```
amount = (uncached × P_input
        + cacheRead × P_cached
        + cacheWrite30m × P_write30m
        + cacheWrite12h × P_write12h
        + output × P_output) / 1_000_000
```

- 输入 Token 超过 `272000` 时选择长上下文价格表（若模型提供）。
- 所需 Token 或价格缺失、usage 内部不一致、负的普通输入 → `unknown`，金额为 `null`。
- 推理 Token 不额外计费。
- 费用字符串用 `toFixed(18)` 去尾零，避免浮点累积误差；聚合在 JS 中用 Decimal 求和，不使用 SQLite REAL。
- 美元折算：USD 原生直接返回；CNY 乘以汇率快照；无汇率时保留 CNY，USD 为 null。

## 7. 三级统计

- **Turn**：同一 `turn_id` 下所有请求的 usage/费用汇总；重新生成和重试都保留。
- **Conversation**：同一 `conversation_id` 下所有请求汇总，含不同模型/服务商；soft-deleted 会话仍计入全局。
- **Global**：按日期范围（本机时区）与服务商/模型筛选；包含按日、按服务商、按模型、按会话、按币种分组；未知/部分费用单独计数。

统计不依赖冗余汇总表，直接读取请求行并用 Decimal 聚合，因此不会出现“汇总与明细不一致”。缓存命中率 = 缓存读取 / 输入总量；输入总量包含缓存读取与写入。

## 8. 聊天流程

```
renderer: chat.sendMessage
  → preload invoke
  → main: 校验参数/来源 → 检查 Key → 解析模型能力
  → 创建/复用会话 → 创建 Turn + 用户消息 + 助手占位
  → 创建价格快照 → 插入 streaming 请求行
  → 构造上下文（本地消息，按条数与字符上限截断）
  → provider adapter（fetch + SSE）
      → 文本/推理增量 → IPC 事件 → 渲染
      → usage → 规范化 → 快照计费
  → 同一事务：完成消息、请求、Turn、会话时间
  → completed 事件（TurnView + 会话统计 + 预算提醒）
```

- OpenAI：`store:false` + 全量 `input`，系统提示放 `instructions`；推理模型才发送 `reasoning.effort`。
- DeepSeek：`stream_options.include_usage=true`；`thinking.type` 控制思考模式，`reasoning_effort` 仅在思考开启时发送；历史不重复回传 `reasoning_content`（无 tools）。
- 中止：AbortController；保留已收到文本；请求 `aborted`、费用 `unknown`，不写 0。
- 异常：HTTP/网络/流中断分类为中文可读错误；不自动重试，避免服务端已计费时重复扣费。
- 部分内容每 1.5 秒落库一次，降低异常退出时丢失已接收文本的风险。

## 9. 导出与备份

- 会话 Markdown：包含用户/助手、思考过程（折叠）、本轮统计、逐请求表格、价格版本。
- 会话 JSON：结构化 messages、requests、usage、价格快照、统计数据。
- 费用 CSV：逐请求字段（含 token 分类、金额、计算状态、价格版本、计价依据）。
- 全量备份：固定表白名单 + 元数据；恢复前自动备份当前库；插入时校验表名与列名，拒绝未知结构。
- 备份明确不含 `secrets.json` 与任何 API Key。

## 10. 错误与恢复

| 场景 | 行为 |
|---|---|
| 401/403 | 提示 Key 无效/权限不足，不重试 |
| 402 | 提示余额不足 |
| 404 | 提示模型不存在/无权限，附模型 ID |
| 429 | 区分限流与额度用尽，显示建议等待时间 |
| 400/422 | 识别不支持参数，提示换模型 |
| 5xx / 网络 / 超时 | 可读中文提示，保留请求记录 |
| 流中断 | 保留已收文本，请求 `interrupted`/`error`，费用未知 |
| 用户停止 | 保留文本，请求 `aborted`，费用未知 |
| 应用崩溃 | 启动时把 streaming 记录标记 interrupted，已落库文本保留 |
| 数据库失败 | 事务回滚，界面提示保存失败，不谎报成功 |

## 11. 测试策略

- 纯领域单测：usage 规范化、价格匹配、峰谷/节假日、Decimal 计费、统计聚合、请求构造、SSE 解析、错误映射、导出格式、预算、时间范围。
- 传输集成测试：mock `fetch` 返回真实 SSE 形状，验证官方 URL、Authorization、请求体、增量解析、usage、结束事件与错误。
- 数据库/聊天集成：临时 SQLite + 真实 Store + ChatService + fake stream，覆盖多轮、多服务商、重新生成、未知 usage、错误、中止、重启、软删除、备份恢复、价格快照、历史重算。
- UI 端到端：Playwright 启动真实 Electron 窗口，使用测试模式模拟流，验证流式增长、费用数值、会话隔离、统计筛选、明暗模式、停止生成、重启持久化、密钥不落盘；输出截图到 `docs/screenshots/`。
- 真实 API 调用未执行（无用户 Key，且不得擅自产生费用）；这是 TEST_REPORT 中明确记录的未验证项。
