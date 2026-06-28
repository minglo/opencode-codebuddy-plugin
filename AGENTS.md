# AGENTS.md

## 项目概述

OpenCode 插件，为 CodeBuddy (IOA) 提供 OAuth 认证和请求拦截。单文件项目，入口 `src/index.ts`，编译产物 `dist/index.js`。

```bash
npm install && npm run build   # tsc 编译到 dist/
```

- 无测试、无 lint、无 CI。仅 `npm run build`（还有 `prepublishOnly: tsc`）。
- `@opencode-ai/plugin` 声明为 `peerDependencies`（运行时也需要），同时 `devDependencies` 中固定为 `latest` — 本地开发时若 SDK 有 breaking change，构建会突然失败。
- ESM (`"type": "module"`)，`tsconfig` 用 `NodeNext` 模块解析，`target: ES2022`。

## 架构

`src/index.ts` 是唯一源文件。导出两个东西：

- `CodeBuddyAuthPlugin: Plugin` — 真正的实现，供 `npm` 字段加载
- `default export` = `{ id: "codebuddy-plugin", server: CodeBuddyAuthPlugin }` — 给 OpenCode plugin loader 使用

Provider ID 硬编码为 `"codebuddy"`（`PROVIDER_ID` 常量），所有 hooks 都用此 ID。

### 六个核心 Hooks

请求流向（顺序）：
```
OpenCode 收集 user 输入
  ↓ chat.message
  预热 session → conversationId LRU
  ↓ chat.headers
  注入非认证 headers(X-Conversation-ID / B3 / X-Model-ID 等)
  ↓ chat.params
  改 baseURL
  ↓ auth.loader.fetch
  叠加 Authorization / X-Tenant-Id / 401/403 刷新重试
  ↓ 上游 CodeBuddy API
```

1. **`config(config)`** — 启动时调用。如用户未声明，自动注入 `provider.codebuddy = { npm: "@ai-sdk/openai-compatible", options.baseURL = ${serverUrl}/v2, models: {} }`。然后读 `~/.local/share/opencode/auth.json` 拿 access token，调 `GET /v3/config` 动态拉取 craft agent 可用模型，写入 `provider.codebuddy.models`。**不会覆盖用户已声明的 model 条目**。
   - 模型发现超时 `DISCOVERY_TIMEOUT_MS = 5000` — 5s 没拿到就用 fallback
   - fallback：单个 `auto` model（`maxInputTokens: 168000, maxOutputTokens: 32000, tool_call: true`）
   - **只采纳 `supportsToolCall === true` 的模型**（`src/index.ts:139`）

2. **`event({ event })`** — 监听 OpenCode 事件：
   - `session.compacted` → 删除该 sessionID 的 conversationId LRU 条目
   - `session.deleted` → 同上
   - 目的：compaction 改了 prefix，旧 conversation ID 在上游再也命中不了；session 删除时清掉 LRU 防止内存泄漏

3. **`chat.message(input, _output)`** — OpenCode 收到新 user 消息时触发。用 `input.sessionID` 预热 conversationId LRU，保证**第一次** fetch 之前 map 已就绪

4. **`chat.headers(input, output)`** — 设置非认证 headers（见 `buildRequestHeaders`）。model id 直接从 `input.model.id` 拿，不再解析 body
   - 仅当 `input.model.providerID === "codebuddy"` 时生效

5. **`auth.loader`** — 返回 `{ apiKey: "cli-proxy", baseURL, fetch }`。自定义 `fetch` 拦截所有 `/chat/completions` 请求：
   - **保留 `init.headers`（含 chat.headers 设的所有字段），只叠加认证字段**（`new Headers(init?.headers)` + set Authorization / X-Tenant-Id / X-User-Id / X-Enterprise-Id）
   - 转发到 `${resolvedServerUrl}${CONFIG.chatCompletionsPath}`（`/v2/chat/completions`）
   - **遇到 401/403 自动用 refresh token 调 `/v2/plugin/auth/token/refresh`，成功后通过 `input.client.auth.set` 写回新 token，再重试一次**

6. **`chat.params(input, output)`** — 仅当 `input.model.providerID === "codebuddy"` 时设置 `output.options.baseURL = resolvedServerUrl`（注意：这里没有 `/v2` 后缀，因为 SDK 会自己拼 path）

### OAuth 登录

`auth.methods[0].authorize()` 走 IOA 流程：`POST /v2/plugin/auth/state` 拿 state + authUrl → 浏览器登录 → 轮询 `GET /v2/plugin/auth/token?state=...`：

- 轮询间隔 `sleep(3000)`（3 秒）
- 整体超时 10 分钟（`Date.now() + 10 * 60 * 1000`）

## Caching 行为

OpenCode 每个 turn 都把**完整 message history**重新发给 `/chat/completions`，prefix 天然稳定。本插件在此基础上做了一层 **session 级 conversation ID 稳定化**，以便上游做 prompt caching。

- `sessionConversationIds: LRUMap<sessionID, conversationId>` 维护**每个 OpenCode session 第一个请求时生成的 UUID**
- 同 session 内所有请求复用同一 UUID（跨 turn、跨 tool call）
- 不同 session 隔离
- 触发 `session.compacted` 或 `session.deleted` 时该 sessionID 的条目被删除
- LRU 上限由 `CODEBUDDY_CONVERSATION_ID_MAP_MAX` 控制（默认 1000）
- 设为 `CODEBUDDY_STABLE_CONVERSATION_ID=0` 降级为 per-request UUID（原行为）

**前提**：依赖 CodeBuddy 上游按 `X-Conversation-ID` 做 prompt cache。本地不维护 cache。

## 环境切换

**优先用 user-side 配置**，不要改源码。`config` hook 会自动检测：

```jsonc
// 国际版：baseURL 含 codebuddy.ai → 自动 resolvedDomain = "www.codebuddy.ai"
{ "provider": { "codebuddy": { "options": { "baseURL": "https://www.codebuddy.ai/v2" } } } }
```

| 环境 | baseURL | 自动 X-Domain |
|------|---------|---------------|
| 国内版（默认） | `https://copilot.tencent.com/v2` | `www.codebuddy.cn` |
| 国际版 | `https://www.codebuddy.ai/v2` | `www.codebuddy.ai` |

`CONFIG` 常量中 `serverUrl` 和 `domain` 是**初始默认值**，仅在 user config 没覆盖 baseURL 时生效。**`CONFIG.chatCompletionsPath` (`/v2/chat/completions`) 是硬编码的**，API path 与 baseURL 中的 `/v2` 必须保持一致 — 切换到非 `/v2` 的 API 需要同时改源码。

## 环境变量

读取时机：插件加载时（`CONFIG` 对象初始化时一次性读 `process.env`），后续修改 env 不会生效。

| 变量 | 默认 | 作用 |
|------|------|------|
| `CODEBUDDY_DEFAULT_MODEL` | (空) | 强制覆盖 OpenCode 选择的 model |
| `CODEBUDDY_TENANT_ID` | (空,从 JWT 提) | 覆盖从 JWT `iss`/`tenant_id` 自动提取的 tenant |
| `CODEBUDDY_ENTERPRISE_ID` | (空,从 JWT 提) | 覆盖从 JWT roles 自动提取的 enterprise |
| `CODEBUDDY_USER_ID` | (空,从 JWT 提) | 覆盖从 JWT `sub`/`user_id` 自动提取的 user |
| `CODEBUDDY_STABLE_CONVERSATION_ID` | `1` | `0` = 降级到 per-request UUID(关闭稳定化) |
| `CODEBUDDY_CONVERSATION_ID_MAP_MAX` | `1000` | session → conversationId LRU 的最大容量 |

JWT 自动提取逻辑见 `resolveTenantId`/`resolveEnterpriseId`/`resolveUserId`。

## 用户配置三种模式

1. 只加 `plugin`，不声明 provider → 自动创建 provider + 自动发现 models（推荐）
2. 声明 provider 不声明 models → 自动发现 models
3. 手动声明 provider + models → 插件不覆盖已声明的 model 条目（`if (models[m.id]) continue;`）

## Token 存储

- 路径：`~/.local/share/opencode/auth.json`
- `config` hook 直接 `fs.readFileSync` 此文件拿 token
- 刷新后通过 `input.client.auth.set({ path: { id: "codebuddy" }, body: { type: "oauth", access, refresh, expires } })` 写回
- session 删除时 `event` hook 会清掉对应的 LRU 条目

## 全局安装（无需 npm 发布）

OpenCode 自动加载 `~/.config/opencode/plugins/*.js`（Windows: `%USERPROFILE%\.config\opencode\plugins\`）。本项目未发布到 npm，可在该目录放一个 wrapper 文件，re-export 绝对路径下的 `dist/index.js`：

```js
// ~/.config/opencode/plugins/codebuddy-plugin.js
export { default } from "file:///D:/opencode-codebuddy-plugin/dist/index.js";
```

这样 `npm run build` 之后新 dist 自动生效。修改路径需要同步更新此 wrapper。

清理：`Remove-Item ~/.config/opencode/plugins/codebuddy-plugin.js`。
