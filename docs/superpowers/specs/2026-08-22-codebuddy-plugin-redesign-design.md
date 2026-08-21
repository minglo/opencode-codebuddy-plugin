# opencode-codebuddy-oauth v2.0 重构设计

日期：2026-08-22
状态：待评审
范围：`src/index.ts`（1146 行）完全重构为分层插件，发布 npm

## 1. 背景与目标

现有单文件插件混 7 职责（CONFIG 快照 / LRU / SSE 缓冲 / JWT / headers / auth / plugin 组装），经三轮审查确认 36 个问题（见附录 A）：6 个真 bug、4 处死代码、7 处重复、9 项性能问题、7 项架构问题、3 个模型映射 bug。

目标：

1. 拆分为可独立测试的模块，vitest 全覆盖核心逻辑
2. 修复全部 A/N 类 bug
3. 以 tsup 构建发布 npm，版本 2.0.0（破坏性变更）
4. 使用最新 TypeScript 严格集

## 2. 硬约束（不可破坏）

**auth.json 存储格式是 opencode 的契约，不是本插件的。** `/connect` 写入、`loader.getAuth()` 读回、`input.client.auth.set` 持久化均走：

```ts
{ type: "api"; key: string }
| { type: "oauth"; access: string; refresh: string; expires: number }
```

重设计只能加宽容解析（手写窄化守卫），不能改结构。

破坏性自由度限于：env 变量名、内部模块结构、默认值、行为语义。

## 3. 已确认决策

| 决策点 | 结论 |
|---|---|
| 兼容性 | 破坏性重设计，2.0.0 |
| 包名 | 沿用 `opencode-codebuddy-oauth` |
| 运行时依赖 | 零依赖（zod→手写守卫，lru-cache→手写 LRU） |
| 测试 | vitest 全套 |
| SSE max-delay | 实现真定时 flush（配置生效） |
| 构建 | tsup 单入口 ESM + dts |

## 4. 目标结构（方案 A：分层纯核 + 薄胶水）

核心逻辑不 import `@opencode-ai/plugin`，仅 `index.ts` 接线。

```
src/
  index.ts        # Plugin 组装：config/event/auth.loader/chat.headers → 核心
  config.ts       # getConfig() 懒读 env + parseNum + constants
  log.ts          # logger：client.app.log 包装，fallback console
  lru.ts          # Map 精简 LRU ~15 行
  fetch-json.ts   # fetchJson(url, opts) 统一超时/错误处理
  jwt.ts          # decodeJwtPayload + resolveIdentity(payload) 一次解码
  headers.ts      # baseHeaders / buildRequestHeaders / buildAuthHeaders
  auth-state.ts   # 窄化守卫 + pickAuthMode + effectiveAuth + needsRefresh
  auth-flow.ts    # requestAuthState / pollForToken / refreshAccessToken + RefreshLock
  models.ts       # remoteModelToConfig + mergeModelEntry + DiscoveryCache
  sse-buffer.ts   # createSSEBufferedStream（真定时 flush）
test/             # vitest，镜像源文件
```

## 5. 模块设计

### 5.1 config.ts

```ts
export interface CodeBuddyConfig {
  endpoint?: string
  network: "internal" | "ioa" | "internet"
  auth: "auto" | "oauth" | "api"
  model?: string            // 强制覆盖请求 model
  stableConversationId: boolean
  conversationMapMax: number
  sse: { enabled: boolean; threshold: number; maxDelayMs: number }
  tenantId?: string; enterpriseId?: string; userId?: string
}
export function getConfig(): CodeBuddyConfig   // 每次调用读 process.env，可 mock
```

数字解析统一 `num(v, d)`：`Number.isFinite(n) && n >= 0 ? n : d` —— 修复 `\|\|` 吞 0（A1）。`threshold=0` 合法（等价逐 delta 冲）；`conversationMapMax=0` 合法（每次新 conversationId）。

env 重命名映射（破坏性）：

| 旧 | 新 |
|---|---|
| `CODEBUDDY_API_ENDPOINT` | `CODEBUDDY_ENDPOINT` |
| `CODEBUDDY_INTERNET_ENVIRONMENT` | `CODEBUDDY_NETWORK` |
| `CODEBUDDY_AUTH_MODE` | `CODEBUDDY_AUTH` |
| `CODEBUDDY_DEFAULT_MODEL` | `CODEBUDDY_MODEL` |
| `CODEBUDDY_SSE_BUFFER` | `CODEBUDDY_SSE`（`0`=禁用） |
| `CODEBUDDY_SSE_BUFFER_THRESHOLD` | `CODEBUDDY_SSE_THRESHOLD` |
| `CODEBUDDY_SSE_BUFFER_MAX_DELAY_MS` | `CODEBUDDY_SSE_DELAY_MS` |
| `CODEBUDDY_CONVERSATION_ID_MAP_MAX` | `CODEBUDDY_CONVERSATION_MAP_MAX` |
| `CODEBUDDY_STABLE_CONVERSATION_ID` | `CODEBUDDY_STABLE_CONVERSATION`（`0`=禁用） |
| `CODEBUDDY_TENANT_ID` / `_ENTERPRISE_ID` / `_USER_ID` / `_API_KEY` | 不变 |

常量集中此处：`DISCOVERY_TIMEOUT_MS=5000`、`POLL_INTERVAL_MS=3000`、`POLL_TIMEOUT_MS=8000`、`REFRESH_TIMEOUT_MS=5000`、`REFRESH_SKEW_MS=5×60×1000`、`AUTH_STATE_TTL_MS=10×60×1000`、`DEFAULT_EXPIRES_MS=24h`、`DISCOVERY_CACHE_TTL_MS=5min`。

服务端地址解析改为纯函数 `resolveServerUrl(cfg): { url, domain }`，返回值显式传递（修 A5 可变全局竞态），由 index.ts 持有并注入各模块。

### 5.2 log.ts

```ts
export interface Logger { debug(m: string, extra?: object): void; info(...); warn(...); error(...) }
export function createLogger(client?: OpencodeClient): Logger
```

- 有 client：`client.app.log({ service: "codebuddy", level, message, extra })`，fire-and-forget 附 `.catch(() => {})`
- 无 client：warn/error 落 `console.error`，debug/info 静默
- 全项目禁裸 console（修 D6）

### 5.3 lru.ts

Map 实现：get 命中即 delete+set 提升；set 时 size≥max 删 `keys().next().value`。泛型保留。删未使用的 `generateUuid`（B1）。

### 5.4 fetch-json.ts

```ts
export async function fetchJson<T>(url: string, opts: {
  method?: string; headers?: Record<string,string>; body?: string
  timeoutMs: number; signal?: AbortSignal
}): Promise<{ ok: true; data: T } | { ok: false; status?: number; text?: string }>
```

内部 withTimeout（AbortController + 外部 signal 联动），错误文本截断 500 字符。收敛 `requestAuthState/pollForToken/refreshAccessToken/fetchRemoteModels` 四处样板（C5）。

### 5.5 jwt.ts

`decodeJwtPayload(token)` 保留；新增 `resolveIdentity(payload): { tenantId, enterpriseId, userId }`。`buildAuthHeaders` 每 token 只解码一次（修 C3 的 ×3 解码）。

### 5.6 headers.ts

- `baseHeaders(cfg, domain)`：Accept / Content-Type / X-Requested-With / X-Agent-Intent / X-IDE-* / X-Product-Version / X-Env-ID / X-Domain / X-Product / User-Agent（C2 收敛 ×12 行重复；C4 经同一 domain 来源消除手写重复）
- `buildRequestHeaders(sessionId, modelId)`：base + trace/conversation/b3 族。traceId 生成一次，spanId/parentSpanId 由切片派生（D4 部分）
- `buildAuthHeaders(auth, identity)`：
  - api：`Authorization: Bearer key` **与 `X-API-Key` 双头保留**——偏离原去重计划（D9）。理由 [INFERRED]：服务端对 api key 类型校验哪个头未知，生产双头在用；盲删可能 401。注释说明原因。
  - oauth：Authorization + X-Tenant/X-Enterprise/X-User（identity 已解码）

### 5.7 auth-state.ts

```ts
export type AuthState = { type: "api"; key: string } | { type: "oauth"; access: string; refresh: string; expires: number }
export function parseStoredAuth(raw: unknown): AuthState | undefined  // 手写窄化守卫替代 zod（E4），损坏文件 warn 日志返回 undefined
export function pickAuthMode(cfg, stored): "oauth" | "api"
export function effectiveAuth(stored): AuthState | null               // oauth 单分支（C7），expires 校验删除
export function needsRefresh(auth: AuthState, now: number): boolean   // oauth && expires - REFRESH_SKEW_MS < now && refresh 非空
```

A2 修复：`mode === "api"` 时 `authAvailable = !!(cfg.apiKey || stored?.type === "api" && stored.key)`，无 key 打警告而非静默 fallback。

### 5.8 auth-flow.ts

- `requestAuthState(serverUrl)`：fetchJson POST `/v2/plugin/auth/state`
- `pollForToken(state, expiresAt, signal)`：**先查后睡**（修登录后白等 3s）；单例 AbortController + 外部 signal 联动复用（D7）
- `refreshAccessToken(refreshToken, serverUrl)`
- `RefreshLock`：`Map<refreshToken, Promise<RefreshResult>>`，`run(token, fn)` 并发去重、finally 删键（修 D3 全局单例跨 session 卡顿）

预刷新流程（修 A4，省 1 RTT）：fetch 前 `needsRefresh()` 为真且锁空闲 → 先刷再发；401/403 兜底刷新保留。刷新成功后 `activeAuth` 与持久化 body 共用同一对象（修 C6），经 `client.auth.set` 写入。

### 5.9 models.ts

RemoteModel 接口不变。映射定稿（含 N1/N2/N3 修复，字段有效性已经 opencode 源码 `provider.ts` L1460-1550 / `transform.ts` L1654+ 验证）：

```ts
export function remoteModelToConfig(m: RemoteModel): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    name: m.name,
    tool_call: m.supportsToolCall !== false,          // N1：false 必须显式落盘，opencode 默认 true
    attachment: !!(m.supportsImages && !m.disabledMultimodal),
    limit: { context: m.maxAllowedSize ?? m.maxInputTokens ?? 0,
             output: m.maxOutputTokens ?? 0 },
  }
  if (m.supportsReasoning) {
    entry.reasoning = true
    entry.interleaved = { field: "reasoning_content" } // schema 允许 {field}；官方 Poolside 示例同款
    const effort = m.reasoning?.defaultEffort ?? m.reasoning?.effort
    if (effort) entry.options = { reasoningEffort: effort }
    const efforts = m.reasoning?.supportedEfforts
    if (efforts?.length) {
      entry.variants = Object.fromEntries(efforts.map(e => [e, { reasoningEffort: e }]))
      // N3：删除"xhigh 写作 max"的失实注释；不做别名映射（CodeBuddy 返回什么键就暴露什么 variant）
    }
  }
  return entry
}

// N2 修复：顶层 spread 手工优先，子对象各深一层；无任何事后翻转
export function mergeModelEntry(auto, existing) {
  return {
    ...auto, ...existing,
    ...(auto.limit && existing.limit ? { limit: { ...auto.limit, ...existing.limit } } : {}),
    ...(auto.options && existing.options ? { options: { ...auto.options, ...existing.options } } : {}),
    ...(auto.variants && existing.variants ? { variants: { ...auto.variants, ...existing.variants } } : {}),
  }
}
```

有意不映射（记录理由）：`reasoning.summary`（可选增益，暂缓）、`canDisableThinking`（openai-compatible 无"关闭思考"settings，`reasoningToggle` 仅 alibaba/cohere 有映射）、`onlyReasoning`（opencode 无对应概念）。

DiscoveryCache（修 D2）：内存 `{ data, fetchedAt }`，TTL 5min。config() hook 有缓存同步返回、过期后台 revalidate；冷启动阻塞拉取 withTimeout(5s)，失败降级 DEFAULT_MODEL。discovery 过滤条件从 `supportsToolCall` 改为 truthy 即纳入（N1 后 false 也能正确表达，但 craft 场景无工具模型无意义，维持过滤，条件写 `m.supportsToolCall !== false` 保持一致）。

### 5.10 sse-buffer.ts

真定时 flush（修 A3）——原代码 timer 设立即清、回调空操作，`MAX_DELAY_MS` 配置无效。原注释"timer 无法 enqueue"是错的：`controller` 闭包捕获即可在回调 enqueue，仅需防 stream 已关（try/catch 包裹 enqueue）。

设计：

- `buffers = { reasoning: "", content: "" }`，各自独立 timer
- 缓冲非空时设 `setTimeout(maxDelayMs)`；回调内 flush 对应 buffer + 清 timer
- transform 内 flush 触发（threshold 达标 / `FLUSH_RE` 标点 / 类型切换 / finish / tool_calls / `[DONE]` / 非 data 行）时先 `clearTimeout`
- `flushBuf(controller, field)` 收敛 ×8 处 JSON 模板（C1），输出统一完整格式：`{ id:"buffered", object:"chat.completion.chunk", created, choices:[{index:0, delta:{[field]:buf}, finish_reason:null}] }`
- `flush()` 清双 timer + 冲剩余 buffer + leftover
- leftover 用数组收集 join（修 D5 O(n²)）
- `FLUSH_RE = /[。！？.!?；;，,：:]$/` 模块级预编译（修 D8）；`hasFlushTrigger` 去掉每次调用的 `s.trimEnd()` 分配——SSE delta 末尾即有效字符，直接对原串匹配末尾标点

### 5.11 index.ts 组装

- `CodeBuddyAuthPlugin: Plugin`：仅接线 config hook / event hook / auth.loader / chat.headers
- config hook 内 `fs.promises.readFile` 读 auth.json（修 D1），失败走 parseStoredAuth 容错
- chat.headers 注入 buildRequestHeaders 结果；event hook 保留 session.compacted/deleted 清 conversationId
- `chat.message` 空钩子删除（B3）——conversationId 预热由 chat.headers 覆盖
- doRequest 中 stream_options 注入仅在 `parsed.stream` 为真时解 body（D4 部分）；每请求 traceId 从单次生成切片（D4 部分）
- L1067-1075 空操作兜底块删除（B2）
- discovery 双超时统一为 withTimeout（B4）

## 6. 错误处理

- 所有网络失败降级 DEFAULT_MODEL，不阻塞 opencode 启动
- auth.json 损坏：warn 日志 + 视为未登录
- 刷新持久化失败：in-memory 续用 + error 日志（现状行为保留）
- SSE timer 回调 enqueue 包 try/catch（stream 可能已 error/closed）

## 7. 构建与发布

- tsup：`entry: ["src/index.ts"]`、`format: ["esm"]`、`dts: true`、`target: node18`、`clean: true`、`sourcemap: true`
- package.json 修复入口断裂（A6）：`main/types/exports` 全指向 `dist/index.*`；`files: ["dist"]`（移除 `.opencode`）；`scripts.build = tsup`；`prepublishOnly = vitest run && tsup`
- tsconfig：`strict` + `verbatimModuleSyntax` + `noUncheckedIndexedAccess`，target ES2023
- peerDependencies：`@opencode-ai/plugin` 下限以 devDeps 实际安装版本为准
- version 2.0.0；README 重写：安装（opencode.json plugin 数组）、配置（新 env 表）、迁移指南（旧→新 env 映射表）
- repo 内 `.opencode/` 仅作本项目本地开发加载用途（旧 sync-plugin.mjs 机制已废），不进 npm 包（`files: ["dist"]` 已排除）

## 8. 测试计划（vitest）

| 文件 | 用例 |
|---|---|
| sse-buffer | 碎片合并至 threshold；标点触发；maxDelay 定时冲出；定时回调在流关闭后不抛（try/catch 路径）；类型切换先冲再透传；finish/tool_calls 直通；`[DONE]` 前冲空缓冲；多字节 UTF-8 跨包；非 data 行透传；flush 冲剩余 |
| jwt | 各 claim 变体（tenant_id/tenantId/ent_id…iss realm 提取）；畸形 token 返回 null |
| config | num() 吞 0 回归（threshold=0 / mapMax=0 / maxDelayMs=0 均生效）；布尔 env `0`=禁用；resolveServerUrl 三分支 |
| auth-state | 模式选择矩阵（env/stored 组合）；A2 无 key 警告路径；effectiveAuth 单分支；needsRefresh 边界（恰在 skew 内/外）；parseStoredAuth 对损坏输入容错 |
| auth-flow | RefreshLock 并发去重（同 token 单飞、异 token 互阻）；预刷新触发路径（skew 内先刷再发）；pollForToken 先查后睡顺序；401 兜底刷新 |
| models | 映射全字段快照；N1 tool_call:false 落盘；N2 手工 reasoning:false 不被翻转；merge 子对象深合并；craft 过滤 |
| lru | 淘汰顺序；命中提升；容量 0 |
| fetch-json | 超时中止；外部 signal 联动；非 2xx 返回 status/text |
| headers | base/request/auth 三族内容；api 双头保留 |

## 9. 实施顺序

1. 脚手架：tsup + vitest + tsconfig 严格集 + package.json 入口修复
2. 叶子模块自底向上：lru → fetch-json → jwt → log → config → headers
3. auth-state + auth-flow（TDD）
4. models（TDD，含 N1/N2/N3 回归用例）
5. sse-buffer（TDD，最重测试）
6. index.ts 组装 + 手测 `/connect` 登录流 + 真实流式对话
7. README + 迁移指南 → 发布 2.0.0

## 附录 A：问题清单 → 修复位置

| 编号 | 问题 | 修复于 |
|---|---|---|
| A1 | `\|\|` 吞 0 ×3 | config.ts num() |
| A2 | api 模式无 key 静默 fallback | auth-state.ts |
| A3 | SSE timer 死码 / MAX_DELAY 无效 | sse-buffer.ts |
| A4 | 过期 token 先发再刷浪费 RTT | auth-flow.ts 预刷新 |
| A5 | resolvedServerUrl 可变全局竞态 | config.ts resolveServerUrl 纯函数 |
| A6 | main/outDir 断裂 | package.json + tsup |
| B1 | generateUuid 未使用 | 删除 |
| B2 | L1067-1075 空操作块 | 删除 |
| B3 | chat.message 空钩子 | 删除 |
| B4 | 双超时 race timer 泄漏 | index.ts withTimeout 统一 |
| C1 | flush 模板 ×8 | sse-buffer.ts flushBuf |
| C2 | headers ×12 行重复 | headers.ts baseHeaders |
| C3 | JWT ×3 解码 | jwt.ts resolveIdentity |
| C4 | resolveDomainFromUrl 手写重复 | config.ts 单一来源 |
| C5 | fetch 样板 ×4 函数 | fetch-json.ts |
| C6 | activeAuth/writeBody 双份 | auth-flow.ts 共用对象 |
| C7 | effectiveAuth 两分支 | auth-state.ts 单分支 |
| D1 | readFileSync 阻塞 | index.ts fs.promises |
| D2 | discovery 无缓存 | models.ts DiscoveryCache |
| D3 | refreshInFlight 全局锁 | auth-flow.ts RefreshLock |
| D4 | 4× traceId + 非流式解 body | headers.ts + index.ts |
| D5 | leftover O(n²) | sse-buffer.ts 数组收集 |
| D6 | 裸 console | log.ts |
| D7 | pollForToken controller 每轮新建 | auth-flow.ts 复用 |
| D8 | FLUSH_RE 动态编译 | sse-buffer.ts 预编译 |
| D9 | api 双认证头 | **偏离：保留双头**，理由见 5.6 |
| E1 | 单文件 7 职责 | 第 4 节结构 |
| E2 | CONFIG 顶层快照 | config.ts getConfig() |
| E3 | 手写 LRUMap 冗长 | lru.ts 精简 |
| E4 | StoredAuth 宽松解析吞错 | auth-state.ts 守卫 + warn |
| E5 | 魔数散落 | config.ts constants |
| E6 | remoteModelToConfig 6 if | models.ts spread 合并 |
| E7 | 两套随机 ID | 统一 crypto.randomUUID + fallback |
| N1 | tool_call=false 被吞 | models.ts 显式落盘 |
| N2 | 手工 reasoning:false 被翻转 | models.ts mergeModelEntry |
| N3 | xhigh/max 注释失实 | models.ts 删注释 |
