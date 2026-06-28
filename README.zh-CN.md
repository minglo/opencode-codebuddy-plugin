# opencode-codebuddy-plugin

为 [CodeBuddy](https://www.codebuddy.cn)（即 **IOA**，腾讯编程助手）提供 OpenCode 插件，将 CodeBuddy 作为通过 OAuth 认证的 provider 接入 OpenCode。本插件实现了将 OpenCode 与 CodeBuddy API 对接所需的全部六个 hook。

> 单文件项目：[`src/index.ts`](./src/index.ts)。编译产物为 `dist/index.js`。

---

## 特性

- **OAuth 登录** — 直接在编辑器内走 IOA 流程：`/v2/plugin/auth/state` → 浏览器 → 轮询拿 token。
- **自动模型发现** — 启动时调用 `GET /v3/config`，把支持 tool call 的 craft agent 模型全部写入 `provider.codebuddy.models`（5 秒超时保护，超时则使用单个 `auto` 兜底模型）。
- **401/403 自动刷新 token** — 自定义 `fetch` 拦截器捕获鉴权失败，调 `/v2/plugin/auth/token/refresh` 拿新 token，写回 `auth.json` 后重试一次。
- **session 级 `X-Conversation-ID` 稳定化** — 同一个 OpenCode session 内所有请求复用同一 UUID，跨 turn、跨 tool call 一致，提升上游 prompt cache 命中率（`session.compacted` / `session.deleted` 时清掉 LRU 条目）。
- **环境自动切换** — 同一份插件同时支持 `copilot.tencent.com`（国内版，默认）和 `www.codebuddy.ai`（国际版）；`X-Domain` 头根据配置的 `baseURL` 自动推导。

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
| `CODEBUDDY_DEFAULT_MODEL` | _(空)_ | 强制覆盖 OpenCode 选择的 model。 |
| `CODEBUDDY_TENANT_ID` | _(从 JWT 提)_ | 覆盖从 JWT `iss` / `tenant_id` 自动提取的 tenant。 |
| `CODEBUDDY_ENTERPRISE_ID` | _(从 JWT 提)_ | 覆盖从 JWT roles 自动提取的 enterprise。 |
| `CODEBUDDY_USER_ID` | _(从 JWT 提)_ | 覆盖从 JWT `sub` / `user_id` 自动提取的 user。 |
| `CODEBUDDY_STABLE_CONVERSATION_ID` | `1` | 设为 `0` 降级为 per-request UUID（关闭 session 级稳定化）。 |
| `CODEBUDDY_CONVERSATION_ID_MAP_MAX` | `1000` | session → conversationId LRU 的最大容量。 |

---

## 环境切换

插件**不硬编码**地区，而是从你配置中的 `baseURL` 自动推导上游域名：

| baseURL | 实际 `X-Domain` |
|---|---|
| `https://copilot.tencent.com/v2` _(默认)_ | `www.codebuddy.cn` |
| `https://www.codebuddy.ai/v2` | `www.codebuddy.ai` |

`CONFIG.chatCompletionsPath` 硬编码为 `/v2/chat/completions`，所以 baseURL 中的 `/v2` 必须与 API path 保持一致。要切换到非 `/v2` 的 API，需要同步改源码。

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
- 刷新成功后通过 `input.client.auth.set({ path: { id: "codebuddy" }, body: { type: "oauth", access, refresh, expires } })` 写回。

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
