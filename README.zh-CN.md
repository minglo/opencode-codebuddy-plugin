# opencode-codebuddy-plugin

为 [CodeBuddy](https://www.codebuddy.cn)（即 **IOA**，腾讯编程助手）提供 OpenCode 插件，将 CodeBuddy 作为已认证 provider 接入 OpenCode。本插件实现了将 OpenCode 与 CodeBuddy API 对接所需的全部六个 hook。

支持 **两种鉴权模式**：
- **OAuth** — 走 IOA `/v2/plugin/auth/state` → 浏览器 → 轮询拿 token 流程。
- **API Key** — 直接粘贴在 CodeBuddy 官网生成的 `ck_xxx` Key，使用静态模型列表。

> 单文件项目：[`src/index.ts`](./src/index.ts)。编译产物为 `dist/index.js`。

---

## 特性

- **OAuth 登录** — 直接在编辑器内走 IOA 流程：`/v2/plugin/auth/state` → 浏览器 → 轮询拿 token。
- **API Key 登录** — 在 `/connect codebuddy` 处粘贴 `ck_xxx` Key；无需浏览器、不轮询、不刷新。
- **自动模型发现** — OAuth 模式启动时调用 `GET /v3/config`，把支持 tool call 的 craft agent 模型全部写入 `provider.codebuddy.models`；API Key 模式使用 `CODEBUDDY_MODELS` 指定的静态列表。
- **401/403 自动刷新 token** — 自定义 `fetch` 拦截器捕获鉴权失败（仅 OAuth 模式），调 `/v2/plugin/auth/token/refresh` 拿新 token，写回 `auth.json` 后重试一次。
- **session 级 `X-Conversation-ID` 稳定化** — 同一个 OpenCode session 内所有请求复用同一 UUID，跨 turn、跨 tool call 一致，提升上游 prompt cache 命中率（`session.compacted` / `session.deleted` 时清掉 LRU 条目）。
- **环境自动切换** — 同一份插件同时支持 `copilot.tencent.com`（国内版，默认）和 `www.codebuddy.ai`（国际版）；可通过 `CODEBUDDY_INTERNET_ENVIRONMENT` 切换，或直接用 `CODEBUDDY_API_ENDPOINT` 覆盖完整 URL。

---

## 架构

本插件实现了六个 OpenCode hook，请求按以下顺序流过：

```
OpenCode 收集用户输入
  │
  ▼  chat.message
预热 session → 确保 conversationId 已在 LRU 中
  │
  ▼  chat.headers
注入非认证 headers（X-Conversation-ID / B3 / X-Model-ID 等）
  │
  ▼  chat.params
改写 baseURL
  │
  ▼  auth.loader.fetch
叠加 Authorization / X-Tenant-Id / X-User-Id / X-Enterprise-Id，
转发到 ${serverUrl}/v2/chat/completions，
遇到 401/403 则刷新 token 后重试一次
  │
  ▼  上游 CodeBuddy API
```

| Hook | 作用 |
|---|---|
| `config` | 自动注入 `codebuddy` provider（如缺失），然后用 `/v3/config` 填充 `models`。 |
| `event` | 监听 `session.compacted` / `session.deleted`，淘汰对应的 LRU 条目。 |
| `chat.message` | 为新 session 预热 conversationId LRU。 |
| `chat.headers` | 设置非认证 headers（`X-Conversation-ID`、`B3`、`X-Model-ID` 等）。 |
| `auth.loader` | 返回 `{ apiKey, baseURL, fetch }`；自定义 `fetch` 注入认证信息并处理 401/403。 |
| `chat.params` | 用解析后的 server URL 覆盖 `options.baseURL`。 |

仅 `chat.headers` 和 `chat.params` 受 `input.model.providerID === "codebuddy"` 门控。

---

## 环境要求

- Node.js ≥ 18（ESM，`target: ES2022`，`module: NodeNext`）
- `tsc` 工具链
- 能从 `package.json` 的 `dependencies` / `devDependencies` 或 `~/.config/opencode/plugins/` 加载插件的 OpenCode
- peer 依赖 `@opencode-ai/plugin`（同时固定在 `devDependencies` 中）

## 构建

```bash
npm install
npm run build        # tsc → dist/
```

`prepublishOnly` 也会跑 `tsc`，所以 `npm publish` 之前不需要额外步骤。

---

## 用户配置

本插件**开箱即用** — 它会自动创建 `codebuddy` provider、提供 OAuth 登录入口、自动发现模型。支持三种可选配置模式：

### 模式 1 — 只声明 plugin（推荐）

```jsonc
{
  "plugin": ["opencode-codebuddy-plugin"]
}
```

插件会自动注入 provider，提供 `/auth login codebuddy` 入口并发现模型。

### 模式 2 — 声明 provider，models 留给插件发现

```jsonc
{
  "plugin": ["opencode-codebuddy-plugin"],
  "provider": {
    "codebuddy": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "https://copilot.tencent.com/v2" }
    }
  }
}
```

### 模式 3 — 手动指定 model

```jsonc
{
  "plugin": ["opencode-codebuddy-plugin"],
  "provider": {
    "codebuddy": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "https://copilot.tencent.com/v2" },
      "models": {
        "my-model": { /* … */ }
      }
    }
  }
}
```

模式 1 和 2 下，插件会**覆盖**整个 `models`；模式 3 下插件只补全未声明的条目（`if (models[m.id]) continue;`），你手写的 model 配置会被原样保留。

---

## 环境变量

所有变量**只在插件加载时读一次**（`CONFIG` 对象初始化时），运行时改 env 不会生效。

| 变量 | 默认 | 作用 |
|---|---|---|
| `CODEBUDDY_AUTH_MODE` | `auto` | `auto`（若设置了 `CODEBUDDY_API_KEY` 则用 API Key，否则用 OAuth）、`oauth`（强制 OAuth）、`api`（强制 API Key）。 |
| `CODEBUDDY_API_KEY` | _(空)_ | CodeBuddy API Key（`ck_xxx`）。优先级高于 `/connect` 存储的 key。在 `auto` 模式下隐含启用 API Key 模式。 |
| `CODEBUDDY_INTERNET_ENVIRONMENT` | `internal` | `internal` 或 `ioa` → 国内端点（`copilot.tencent.com` + `www.codebuddy.cn`）；其他 → 国际（`www.codebuddy.ai`）。若 `CODEBUDDY_API_ENDPOINT` 已设置则忽略此项。 |
| `CODEBUDDY_API_ENDPOINT` | _(空)_ | 完整 base URL 覆盖（例如 `https://example.com`），跳过 `CODEBUDDY_INTERNET_ENVIRONMENT` 的自动判断。 |
| `CODEBUDDY_MODELS` | `claude-opus-4.6-1m` | API Key 模式下的模型列表（逗号分隔），跳过 `/v3/config` 发现。 |
| `CODEBUDDY_DEFAULT_MODEL` | _(空)_ | 强制覆盖 OpenCode 选择的 model。 |
| `CODEBUDDY_TENANT_ID` | _(从 JWT 提)_ | 覆盖从 JWT `iss` / `tenant_id` 自动提取的 tenant。仅 OAuth 模式。 |
| `CODEBUDDY_ENTERPRISE_ID` | _(从 JWT 提)_ | 覆盖从 JWT roles 自动提取的 enterprise。仅 OAuth 模式。 |
| `CODEBUDDY_USER_ID` | _(从 JWT 提)_ | 覆盖从 JWT `sub` / `user_id` 自动提取的 user。仅 OAuth 模式。 |
| `CODEBUDDY_STABLE_CONVERSATION_ID` | `1` | 设为 `0` 降级为 per-request UUID（关闭 session 级稳定化）。 |
| `CODEBUDDY_CONVERSATION_ID_MAP_MAX` | `1000` | session → conversationId LRU 的最大容量。 |

---

## 环境切换

插件支持两种方式选上游端点：

1. **`CODEBUDDY_API_ENDPOINT`** — 完整 base URL 覆盖，优先级最高。
2. **`CODEBUDDY_INTERNET_ENVIRONMENT`** — `internal` 或 `ioa` → 国内（`https://copilot.tencent.com` + `X-Domain: www.codebuddy.cn`）；其他 → 国际（`https://www.codebuddy.ai` + `X-Domain: www.codebuddy.ai`）。
3. **OpenCode 配置里的 `baseURL`** — 若在 `provider.codebuddy.options.baseURL` 中显式设置，会再次根据 host 推导 `X-Domain`。

| 配置 | Server | `X-Domain` |
|---|---|---|
| _(默认，无 env 变量)_ | `https://copilot.tencent.com` | `www.codebuddy.cn` |
| `CODEBUDDY_INTERNET_ENVIRONMENT=internal` | `https://copilot.tencent.com` | `www.codebuddy.cn` |
| `CODEBUDDY_INTERNET_ENVIRONMENT=external`（或留空） | `https://www.codebuddy.ai` | `www.codebuddy.ai` |
| `CODEBUDDY_API_ENDPOINT=https://my-proxy.example.com` | 覆盖的 URL | 从 URL host 推导 |

`CONFIG.chatCompletionsPath` 硬编码为 `/v2/chat/completions`，所以 baseURL 中的 `/v2` 必须与 API path 保持一致。要切换到非 `/v2` 的 API，需要同步改源码。

---

## API Key 模式

`/connect codebuddy` 现在提供 **两个选项**：

1. **IOA 登录 (浏览器)** — 原始 OAuth 流程。
2. **API Key** — 粘贴 `ck_xxx` Key，存入 `auth.json` 的 `{ type: "api", key }`。

也可以直接设置 `CODEBUDDY_API_KEY` 环境变量，优先级高于存储的 key，并且完全不需要走 `/connect` 流程。

API Key 模式下发的请求头：
- `Authorization: Bearer <key>`
- `X-API-Key: <key>`

**不发送** `X-Tenant-Id` / `X-Enterprise-Id` / `X-User-Id`（没有 JWT 可解），与 `codebuddy2api` 行为一致。

模型列表从 `CODEBUDDY_MODELS` 读取（逗号分隔，默认 `claude-opus-4.6-1m`）。**跳过**远程 `/v3/config` 发现，避免无权访问该接口。

API Key 模式的典型 `.env`（对齐常见的 `codebuddy2api` 配置）：

```env
CODEBUDDY_AUTH_MODE=api
CODEBUDDY_API_KEY=ck_xxxxxxxxxxxxxxxx.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
CODEBUDDY_INTERNET_ENVIRONMENT=internal
CODEBUDDY_MODELS=claude-opus-4.6-1m
```

### 关于错误码 14017（体验版尚未激活）

如果你的 CodeBuddy/IOA 账号尚未激活体验版，上游 API 会返回：

```json
{"code": 14017, "msg": "体验版尚未激活。请退出当前账号后重新登录，即可立即激活并开始免费体验。"}
```

这是**账号级别**的问题，不是插件问题，插件只是原样透传。解决方法：

1. 在 [codebuddy.cn](https://www.codebuddy.cn) **退出账号后重新登录**即可激活体验版。
2. 如果重登后仍报此错，在 CodeBuddy 官网控制台**生成 API Key** 并切换到 API Key 模式 — 企业 API Key 不受体验版限制。

---

## 缓存行为

OpenCode 每个 turn 都会把完整 message history 重发到 `/chat/completions`，客户端侧的 prefix 天然稳定。插件在此之上加了一层 **session 级 conversation-id 稳定化**，以配合上游的 prompt cache：

- `sessionConversationIds: LRUMap<sessionID, conversationId>` 存储每个 OpenCode session 第一次请求时生成的 UUID。
- 同 session 内所有请求复用同一 `X-Conversation-ID`（跨 turn、跨 tool call）。
- 不同 session 互相隔离。
- 触发 `session.compacted` 或 `session.deleted` 时淘汰对应条目。
- LRU 容量由 `CODEBUDDY_CONVERSATION_ID_MAP_MAX` 控制（默认 `1000`）。
- 设为 `CODEBUDDY_STABLE_CONVERSATION_ID=0` 可关闭稳定化，降级为 per-request UUID。

缓存本身存放在上游，本插件不持久化任何模型输出。

---

## 全局安装（无需发布到 npm）

OpenCode 会自动加载 `~/.config/opencode/plugins/` 下所有 `*.js`（Windows：`%USERPROFILE%\.config\opencode\plugins\`）。本项目暂未发布到 npm，可以放一个 wrapper 文件 re-export 本地的 `dist/`：

```js
// ~/.config/opencode/plugins/codebuddy-plugin.js
export { default } from "file:///D:/opencode-codebuddy-plugin/dist/index.js";
```

`npm run build` 之后新 `dist/index.js` 在 OpenCode 下次启动时自动生效。如果本地路径变化，需要同步更新这个 wrapper 文件。

清理：

```powershell
Remove-Item ~/.config/opencode/plugins/codebuddy-plugin.js
```

---

## Token 存储

- 路径：`~/.local/share/opencode/auth.json`
- `config` hook 直接 `fs.readFileSync` 读取。
- OAuth 模式：刷新成功后通过 `input.client.auth.set({ path: { id: "codebuddy" }, body: { type: "oauth", access, refresh, expires } })` 写回。
- API Key 模式：key 也存在该路径，但**不刷新**（需要在 CodeBuddy 官网手动重新生成）。环境变量 `CODEBUDDY_API_KEY` 始终优先于存储值。

---

## 目录结构

```
.
├── src/
│   └── index.ts          # 唯一源文件 — 导出 CodeBuddyAuthPlugin 和 default
├── dist/                 # 编译产物（已 gitignore）
├── LICENSE
├── README.md
├── README.zh-CN.md
├── package.json
└── tsconfig.json
```

---

## 许可证

[MIT](./LICENSE) — © 2026 HunkYuan。
