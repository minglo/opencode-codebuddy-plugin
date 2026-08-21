# opencode-codebuddy-oauth

为 [CodeBuddy](https://www.codebuddy.cn)（即 **IOA**，腾讯编程助手）提供 OpenCode 插件，将 CodeBuddy 作为已认证 provider 接入 OpenCode。

支持 **两种鉴权模式**：

- **OAuth** — 走 IOA `/v2/plugin/auth/state` → 浏览器 → 轮询拿 token 流程。
- **API Key** — 直接粘贴在 CodeBuddy 官网生成的 `ck_xxx` Key，模型通过 `opencode.json` 配置。

> **2.0.0 为破坏性重设计**：env 变量重命名 9 项、baseURL 优先级反转，**无兼容层**，旧配置静默失效。升级前请阅读[迁移指南](#迁移指南-v1--v2)。

---

## 安装

在项目（或全局 `~/.config/opencode/opencode.json`）的 `plugin` 数组中声明本插件：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-codebuddy-oauth"]
}
```

> 已构建待发布：`npm publish` 后即可直接以包名 `opencode-codebuddy-oauth` 安装；发布前如需本地验证，请使用 `file:` / `git:` 引用。环境要求：Node.js ≥ 18，OpenCode ≥ 1.18.0（peer 依赖 `@opencode-ai/plugin`）。

## 快速开始

启动 OpenCode 后运行：

- **`/connect codebuddy`** → 选择 **IOA 登录 (浏览器)**，按提示在浏览器中完成 IOA 认证（OAuth 模式）。
- **`/connect codebuddy`** → 选择 **API Key 登录**，粘贴 `ck_xxx` Key（API Key 模式）。

插件会自动创建 `codebuddy` provider、发现模型（OAuth 模式）。开箱即用，无需额外配置。

---

## 特性

- **OAuth 登录** — 直接在编辑器内走 IOA 流程：`/v2/plugin/auth/state` → 浏览器 → 轮询拿 token。
- **API Key 登录** — 在 `/connect codebuddy` 处粘贴 `ck_xxx` Key；无需浏览器、不轮询、不刷新。
- **自动模型发现** — OAuth 模式启动时调用 `GET /v3/config`（带 5 分钟 TTL 缓存 + 并发单飞去重），把支持 tool call 的 craft agent 模型写入 `provider.codebuddy.models`；API Key 模式下模型从 `opencode.json` 配置读取。
- **401/403 自动刷新 token** — 自定义 `fetch` 拦截器捕获鉴权失败（仅 OAuth 模式），调 `/v2/plugin/auth/token/refresh` 拿新 token，写回 `auth.json` 后重试一次；`RefreshLock` 按 provider 单例去重并发刷新。过期 token 在请求发出前预刷新（5 分钟 skew），避免浪费 RTT。
- **SSE 缓冲** — 流式响应按阈值/换行/标点/最大延迟合并分块输出，降低 UI 渲染频率；`reasoning_content` 与 `content` 混排保留。
- **session 级 `X-Conversation-ID` 稳定化** — 同一个 OpenCode session 内所有请求复用同一 UUID，跨 turn、跨 tool call 一致，提升上游 prompt cache 命中率（`session.compacted` / `session.deleted` 时清掉 LRU 条目）。
- **环境自动切换** — 同一份插件同时支持 `copilot.tencent.com`（国内版，默认）和 `www.codebuddy.ai`（国际版）；可通过 `CODEBUDDY_NETWORK` 切换，或直接用 `CODEBUDDY_ENDPOINT` 覆盖完整 URL。

---

## 架构

插件实现 4 个 OpenCode hook：

| Hook | 作用 |
| ---- | ---- |
| `config` | 注入 `codebuddy` provider（如缺失），解析服务器地址（含 baseURL 兜底覆写），OAuth 模式下用 `/v3/config` 填充 `models`。 |
| `event` | 监听 `session.compacted` / `session.deleted`，淘汰对应的 conversationId LRU 条目。 |
| `auth.loader` | 返回 `{ apiKey, baseURL, fetch }`；自定义 `fetch` 注入认证信息、处理 401/403 刷新重试、包装 SSE 缓冲。提供 `/connect` 的 OAuth 与 API Key 两种登录方法。 |
| `chat.headers` | 注入非认证 headers（`X-Conversation-ID`、B3、`X-Model-ID` 等），仅 `providerID === "codebuddy"` 时生效。 |

请求流：

```
OpenCode 收集用户输入
  │
  ▼  chat.headers
注入非认证 headers（X-Conversation-ID / B3 / X-Model-ID 等）
  │
  ▼  auth.loader.fetch
叠加 Authorization / X-Tenant-Id / X-User-Id / X-Enterprise-Id，
转发到 ${serverUrl}/v2/chat/completions，
401/403 则刷新 token 后重试一次，SSE 流式响应经缓冲器输出
  │
  ▼  上游 CodeBuddy API
```

源码为分层纯核 + 薄胶水：`src/index.ts` 仅接线，核心逻辑在 `config.ts` / `auth-state.ts` / `auth-flow.ts` / `auth-fetch.ts` / `models.ts` / `headers.ts` / `sse-buffer.ts` / `jwt.ts` / `lru.ts` / `fetch-json.ts` 等独立模块（vitest 全覆盖）。

---

## 环境变量

所有变量**只在插件加载时读一次**（`getConfig()` 调用时），运行时改 env 不会生效。

| 变量 | 默认 | 作用 |
| ---- | ---- | ---- |
| `CODEBUDDY_ENDPOINT` | _(空)_ | 完整 base URL 覆盖（例如 `https://example.com`），**优先级最高**，跳过 `CODEBUDDY_NETWORK` 与 baseURL 判断。 |
| `CODEBUDDY_NETWORK` | `internal` | `internal` / `ioa` → 国内端点（`copilot.tencent.com` + `X-Domain: www.codebuddy.cn`）；其他值（含 `internet`）→ 国际（`www.codebuddy.ai`）。 |
| `CODEBUDDY_AUTH` | `auto` | `auto`（若设置了 `CODEBUDDY_API_KEY` 则用 API Key，否则用 OAuth）、`oauth`（强制 OAuth）、`api`（强制 API Key）。 |
| `CODEBUDDY_MODEL` | _(空)_ | 强制覆盖请求使用的 model（写进 `X-Model-ID`）。 |
| `CODEBUDDY_STABLE_CONVERSATION` | `1` | 设为 `0` 降级为 per-request UUID（关闭 session 级 conversation-id 稳定化）。 |
| `CODEBUDDY_CONVERSATION_MAP_MAX` | `1000` | session → conversationId LRU 的最大容量；`0` 时退化为仅保留最近一个 session。 |
| `CODEBUDDY_SSE` | `1` | 设为 `0` 禁用 SSE 缓冲（响应原样透传）。 |
| `CODEBUDDY_SSE_THRESHOLD` | `24` | SSE 缓冲字节阈值，达到即 flush；`0` 等价逐 delta 冲。 |
| `CODEBUDDY_SSE_DELAY_MS` | `40` | SSE 缓冲最大延迟（毫秒），到达即定时 flush。 |
| `CODEBUDDY_TENANT_ID` | _(从 JWT 提)_ | 覆盖从 JWT `iss` / `tenant_id` 自动提取的 tenant。仅 OAuth 模式。 |
| `CODEBUDDY_ENTERPRISE_ID` | _(从 JWT 提)_ | 覆盖从 JWT roles 自动提取的 enterprise。仅 OAuth 模式。 |
| `CODEBUDDY_USER_ID` | _(从 JWT 提)_ | 覆盖从 JWT `sub` / `user_id` 自动提取的 user。仅 OAuth 模式。 |
| `CODEBUDDY_API_KEY` | _(空)_ | CodeBuddy API Key（`ck_xxx`），优先级高于 `/connect` 存储的 key；在 `auto` 模式下隐含启用 API Key 模式。 |

### 地址优先级链

```
CODEBUDDY_ENDPOINT  >  CODEBUDDY_NETWORK  >  provider.codebuddy.options.baseURL  >  默认（internal）
```

1. **`CODEBUDDY_ENDPOINT`** 设置 → 直接使用（最高优先级）。
2. **`CODEBUDDY_NETWORK`** 决定国内 / 国际端点。
3. **`provider.codebuddy.options.baseURL`**（opencode.json 配置）→ 仅当 `CODEBUDDY_ENDPOINT` **未设置**时生效，可覆盖 `CODEBUDDY_NETWORK` 的结果。
4. 否则默认国内端点 `https://copilot.tencent.com`。

> **2.0.0 优先级反转（破坏性）**：v1 中 opencode.json 里配置的 `provider.options.baseURL` 会覆盖 env 解析结果；v2 中 env（`CODEBUDDY_ENDPOINT` / `CODEBUDDY_NETWORK`）优先，baseURL 仅在 `CODEBUDDY_ENDPOINT` 未设置时生效。若你依赖 baseURL 指定自定义端点，升级后需要改用 `CODEBUDDY_ENDPOINT`。

---

## 迁移指南（v1 → v2）

**2.0.0 无兼容层**：旧 env 变量静默失效（不报错、不警告），v1 的 `provider.options.baseURL` 优先级反转。升级 = 重命名 env + 核对 baseURL 用法。

### env 重命名映射

| v1（旧） | v2（新） | 说明 |
| ---- | ---- | ---- |
| `CODEBUDDY_API_ENDPOINT` | `CODEBUDDY_ENDPOINT` | 完整 URL 覆盖，优先级最高 |
| `CODEBUDDY_INTERNET_ENVIRONMENT` | `CODEBUDDY_NETWORK` | `internal`/`ioa` → 国内，其他值（含 `internet`）→ 国际 |
| `CODEBUDDY_AUTH_MODE` | `CODEBUDDY_AUTH` | `auto` / `oauth` / `api` |
| `CODEBUDDY_DEFAULT_MODEL` | `CODEBUDDY_MODEL` | 强制覆盖请求 model |
| `CODEBUDDY_SSE_BUFFER` | `CODEBUDDY_SSE` | `0` = 禁用缓冲 |
| `CODEBUDDY_SSE_BUFFER_THRESHOLD` | `CODEBUDDY_SSE_THRESHOLD` | 缓冲字节阈值 |
| `CODEBUDDY_SSE_BUFFER_MAX_DELAY_MS` | `CODEBUDDY_SSE_DELAY_MS` | 最大延迟 flush |
| `CODEBUDDY_CONVERSATION_ID_MAP_MAX` | `CODEBUDDY_CONVERSATION_MAP_MAX` | LRU 容量 |
| `CODEBUDDY_STABLE_CONVERSATION_ID` | `CODEBUDDY_STABLE_CONVERSATION` | `0` = 禁用稳定化 |

**未变**：`CODEBUDDY_TENANT_ID` / `CODEBUDDY_ENTERPRISE_ID` / `CODEBUDDY_USER_ID` / `CODEBUDDY_API_KEY`。

### 其他变更

- **hook 清单**：v1 README 声称的 `chat.params` / `chat.message` hook 实际不存在（v1 亦未实现），v2 仅实现 `config` / `event` / `auth.loader` / `chat.headers` 四个 hook。
- **包名**：npm 包名沿用 `opencode-codebuddy-oauth`；`files` 白名单仅含 `dist`，`.opencode/` 与脚本不再打包。
- **模型发现缓存**：新增 5 分钟 TTL + 并发单飞；401/403 不缓存（走刷新提示）。

---

## API Key 模式

`/connect codebuddy` 提供两个选项：

1. **IOA 登录 (浏览器)** — 原始 OAuth 流程。
2. **API Key** — 粘贴 `ck_xxx` Key，存入 `auth.json` 的 `{ type: "api", key }`。

也可以直接设置 `CODEBUDDY_API_KEY` 环境变量，优先级高于存储的 key，完全不需要走 `/connect` 流程。

API Key 模式下发的请求头：

- `Authorization: Bearer <key>`
- `X-API-Key: <key>`

**不发送** `X-Tenant-Id` / `X-Enterprise-Id` / `X-User-Id`（没有 JWT 可解）。

API Key 模式下**不会**自动发现模型（`/v3/config` 接口在 API Key 认证下不返回模型列表）。需要在 `opencode.json` 中手动声明模型：

```jsonc
{
  "plugin": ["opencode-codebuddy-oauth"],
  "provider": {
    "codebuddy": {
      "models": {
        "auto": {
          "name": "Auto",
          "limit": { "context": 168000, "output": 32000 },
          "tool_call": true
        }
      }
    }
  }
}
```

典型 `.env`：

```env
CODEBUDDY_AUTH=api
CODEBUDDY_API_KEY=ck_xxxxxxxxxxxxxxxx.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
CODEBUDDY_NETWORK=internal
```

---

## 缓存行为

OpenCode 每个 turn 都会把完整 message history 重发到 `/chat/completions`，客户端侧 prefix 天然稳定。插件在此之上加了一层 **session 级 conversation-id 稳定化**：

- `LRUMap<sessionID, conversationId>` 存储每个 OpenCode session 第一次请求时生成的 UUID。
- 同 session 内所有请求复用同一 `X-Conversation-ID`（跨 turn、跨 tool call）。
- 触发 `session.compacted` 或 `session.deleted` 时淘汰对应条目。
- LRU 容量由 `CODEBUDDY_CONVERSATION_MAP_MAX` 控制（默认 `1000`；`0` 退化为仅保留最近一个 session）。
- 设为 `CODEBUDDY_STABLE_CONVERSATION=0` 可关闭稳定化，降级为 per-request UUID。

缓存本身存放在上游，本插件不持久化任何模型输出。

---

## Token 存储

- 路径：`~/.local/share/opencode/auth.json`（Linux）／ `%APPDATA%\opencode\auth.json`（Windows）／ `~/Library/Application Support/opencode/auth.json`（macOS），`codebuddy` 键名下。
- `config` hook 异步读取（`fs.promises`，不阻塞）。
- OAuth 模式：刷新成功后通过 `input.client.auth.set({ path: { id: "codebuddy" }, body: { type: "oauth", access, refresh, expires } })` 写回；写回失败时 in-memory 续用并记 error 日志。
- API Key 模式：key 也存在该路径，但**不刷新**（需要在 CodeBuddy 官网手动重新生成）。环境变量 `CODEBUDDY_API_KEY` 始终优先于存储值。

---

## 构建与开发

```bash
npm install
npm run build        # tsup → dist/（ESM + d.ts + sourcemap）
npm test             # vitest 全套
```

`prepublishOnly` 会先跑 `npm test && npm run build`，发布前无需额外步骤。`npm pack` 产物仅包含 `dist` + `README.md` + `LICENSE` + `package.json`（`files: ["dist"]` 白名单）。

### 目录结构

```
.
├── src/               # 分层纯核：config / auth-* / models / headers / sse-buffer / jwt / lru / fetch-json / log
├── test/              # vitest 用例（镜像源文件）
├── dist/              # 编译产物（已 gitignore）
├── LICENSE
├── README.md
├── package.json
└── tsconfig.json
```

---

## 许可证

[MIT](./LICENSE) — © 2026 HunkYuan。