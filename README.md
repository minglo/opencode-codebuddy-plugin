# opencode-codebuddy-plugin

OpenCode plugin that wires [CodeBuddy](https://www.codebuddy.cn) (a.k.a. **IOA**, Tencent's coding agent) into OpenCode as an authenticated provider. It implements the six OpenCode plugin hooks required to authenticate, model-discover, and proxy chat-completions requests against the CodeBuddy API.

Supports **two authentication modes**:
- **OAuth** — runs the IOA `/v2/plugin/auth/state` → browser → poll flow.
- **API Key** — paste a `ck_xxx` CodeBuddy API Key generated from the CodeBuddy website; uses a static model list.

> Source is a single file: [`src/index.ts`](./src/index.ts). The build artifact is `dist/index.js`.

---

## Features

- **OAuth login** — runs the IOA `/v2/plugin/auth/state` → browser → poll flow directly from your editor.
- **API Key login** — paste a `ck_xxx` key at `/connect codebuddy`; no browser flow, no token polling, no refresh.
- **Automatic model discovery** — calls `GET /v3/config` at startup (OAuth mode) and populates `provider.codebuddy.models` with every craft-agent model that supports tool calls. In API Key mode, a configurable static list from `CODEBUDDY_MODELS` is used.
- **Token auto-refresh on 401/403** — the custom `fetch` interceptor catches auth failures (OAuth only), calls `/v2/plugin/auth/token/refresh`, writes the new token back to `auth.json`, and retries the request once.
- **Stable per-session `X-Conversation-ID`** — promotes the upstream prompt cache by reusing the same conversation UUID for every turn within an OpenCode session (cleared on `session.compacted` / `session.deleted`).
- **Environment switch** — the same plugin serves `copilot.tencent.com` (CN, default) and `www.codebuddy.ai` (international); switchable via `CODEBUDDY_INTERNET_ENVIRONMENT` or by setting `CODEBUDDY_API_ENDPOINT` directly.

---

## Architecture

The plugin implements six OpenCode hooks. Requests flow through them in this order:

```
OpenCode collects user input
  │
  ▼  chat.message
warm up session → ensure conversationId is in the LRU
  │
  ▼  chat.headers
inject non-auth headers (X-Conversation-ID, B3, X-Model-ID, …)
  │
  ▼  chat.params
override baseURL
  │
  ▼  auth.loader.fetch
layer in Authorization / X-Tenant-Id / X-User-Id / X-Enterprise-Id,
forward to ${serverUrl}/v2/chat/completions,
and on 401/403 refresh the token and retry once
  │
  ▼  upstream CodeBuddy API
```

| Hook | Purpose |
|---|---|
| `config` | Auto-injects the `codebuddy` provider if missing, then enriches `models` from `/v3/config`. |
| `event` | Listens for `session.compacted` / `session.deleted` and evicts the corresponding LRU entry. |
| `chat.message` | Pre-warms the conversationId LRU for the new session. |
| `chat.headers` | Sets non-auth headers (`X-Conversation-ID`, `B3`, `X-Model-ID`, …). |
| `auth.loader` | Returns `{ apiKey, baseURL, fetch }`; the custom `fetch` injects auth and handles 401/403. |
| `chat.params` | Overrides `options.baseURL` to the resolved server URL. |

Only `chat.headers` and `chat.params` are gated on `input.model.providerID === "codebuddy"`.

---

## Requirements

- Node.js ≥ 18 (ESM, `target: ES2022`, `module: NodeNext`).
- A working `tsc` toolchain.
- An OpenCode install that loads plugins from `package.json`'s `dependencies` / `devDependencies` or from `~/.config/opencode/plugins/`.
- The peer dependency `@opencode-ai/plugin` (also pinned under `devDependencies`).

## Build

```bash
npm install
npm run build        # tsc → dist/
```

The `prepublishOnly` script also runs `tsc`, so `npm publish` is safe out of the box.

---

## Configuration

The plugin needs **no configuration** to be useful — it will create a `codebuddy` provider, run OAuth when the user clicks "login", and discover models automatically. Three opt-in modes are supported:

### Mode 1 — plugin only (recommended)

Add the plugin to your OpenCode config and do nothing else. The plugin will inject the provider, run `/auth login codebuddy`, and discover models.

```jsonc
{
  "plugin": ["opencode-codebuddy-plugin"]
}
```

### Mode 2 — declare the provider, let the plugin discover models

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

### Mode 3 — pin specific models manually

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

In modes 1 and 2 the plugin overwrites `models` with the discovered list. In mode 3 the plugin **only adds models whose id is not already declared** (`if (models[m.id]) continue;`), so your hand-picked entries are preserved.

---

## Environment variables

All variables are read **once**, at plugin load time, when the `CONFIG` object is initialized. Changing them at runtime has no effect.

| Variable | Default | Effect |
|---|---|---|
| `CODEBUDDY_AUTH_MODE` | `auto` | `auto` (use API Key if `CODEBUDDY_API_KEY` is set, otherwise OAuth), `oauth` (force OAuth), or `api` (force API Key). |
| `CODEBUDDY_API_KEY` | _(empty)_ | CodeBuddy API Key (`ck_xxx`). Takes priority over `/connect`-stored key. Implies API Key mode in `auto`. |
| `CODEBUDDY_INTERNET_ENVIRONMENT` | `internal` | `internal` or `ioa` → CN endpoint (`copilot.tencent.com` + `www.codebuddy.cn`); anything else → international (`www.codebuddy.ai`). Ignored if `CODEBUDDY_API_ENDPOINT` is set. |
| `CODEBUDDY_API_ENDPOINT` | _(empty)_ | Full base URL override (e.g. `https://example.com`). Skips the `CODEBUDDY_INTERNET_ENVIRONMENT` switch. |
| `CODEBUDDY_MODELS` | `claude-opus-4.6-1m` | Comma-separated model list used in API Key mode (skips `/v3/config` discovery). |
| `CODEBUDDY_DEFAULT_MODEL` | _(empty)_ | Force-overrides the model OpenCode picks. |
| `CODEBUDDY_TENANT_ID` | _(from JWT)_ | Overrides the tenant id auto-extracted from the JWT (`iss` / `tenant_id`). OAuth mode only. |
| `CODEBUDDY_ENTERPRISE_ID` | _(from JWT)_ | Overrides the enterprise id auto-extracted from the JWT roles. OAuth mode only. |
| `CODEBUDDY_USER_ID` | _(from JWT)_ | Overrides the user id auto-extracted from the JWT (`sub` / `user_id`). OAuth mode only. |
| `CODEBUDDY_STABLE_CONVERSATION_ID` | `1` | Set to `0` to fall back to per-request UUIDs (disable session-level stabilization). |
| `CODEBUDDY_CONVERSATION_ID_MAP_MAX` | `1000` | Capacity of the session → conversationId LRU. |

---

## Environment switch

The plugin supports two ways to pick the upstream endpoint:

1. **`CODEBUDDY_API_ENDPOINT`** — full base URL override. Wins over everything else.
2. **`CODEBUDDY_INTERNET_ENVIRONMENT`** — `internal` or `ioa` → CN (`https://copilot.tencent.com` + `X-Domain: www.codebuddy.cn`); anything else → international (`https://www.codebuddy.ai` + `X-Domain: www.codebuddy.ai`).
3. **`baseURL` in OpenCode config** — when set in `provider.codebuddy.options.baseURL`, the host is also used to re-derive `X-Domain`.

| Configuration | Server | `X-Domain` |
|---|---|---|
| _(default, no env vars set)_ | `https://copilot.tencent.com` | `www.codebuddy.cn` |
| `CODEBUDDY_INTERNET_ENVIRONMENT=internal` | `https://copilot.tencent.com` | `www.codebuddy.cn` |
| `CODEBUDDY_INTERNET_ENVIRONMENT=external` (or empty) | `https://www.codebuddy.ai` | `www.codebuddy.ai` |
| `CODEBUDDY_API_ENDPOINT=https://my-proxy.example.com` | the override URL | derived from URL host |

The hard-coded `CONFIG.chatCompletionsPath` is `/v2/chat/completions`, so any `baseURL` override must keep the `/v2` segment aligned with the API path. Pointing the plugin at a non-`/v2` API requires patching the source.

---

## API Key mode

`/connect codebuddy` now shows **two options**:

1. **IOA 登录 (浏览器)** — the original OAuth flow.
2. **API Key** — paste a `ck_xxx` key. Stored as `{ type: "api", key }` in `auth.json`.

Alternatively, set `CODEBUDDY_API_KEY` in the environment; this takes priority over the stored key and avoids the `/connect` flow entirely.

Headers sent in API Key mode:
- `Authorization: Bearer <key>`
- `X-API-Key: <key>`

No `X-Tenant-Id` / `X-Enterprise-Id` / `X-User-Id` are sent (no JWT to decode), matching the `codebuddy2api` behavior.

The static model list is taken from `CODEBUDDY_MODELS` (comma-separated, default `claude-opus-4.6-1m`). Remote `/v3/config` discovery is **skipped** in API Key mode to avoid an unauthorized request.

A typical `.env` for API Key mode (mirroring the well-known `codebuddy2api` setup):

```env
CODEBUDDY_AUTH_MODE=api
CODEBUDDY_API_KEY=ck_xxxxxxxxxxxxxxxx.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
CODEBUDDY_INTERNET_ENVIRONMENT=internal
CODEBUDDY_MODELS=claude-opus-4.6-1m
```

### About error code 14017 (体验版尚未激活)

If your CodeBuddy/IOA account has not yet activated the trial, the upstream API returns:

```json
{"code": 14017, "msg": "体验版尚未激活。请退出当前账号后重新登录，即可立即激活并开始免费体验。"}
```

This is an **account-level** issue, not a plugin issue. The plugin passes the error through as-is. To resolve:

1. **Log out and log back in** at [codebuddy.cn](https://www.codebuddy.cn) to activate the trial.
2. If the issue persists, generate an **API Key** in the CodeBuddy website console and switch to API Key mode — corporate API Keys are not subject to the trial gate.

---

## Caching behavior

OpenCode re-sends the full message history on every turn, so prefix stability is free at the client side. The plugin layers a **session-level conversation-id stabilizer** on top, to align with the upstream prompt cache:

- `sessionConversationIds: LRUMap<sessionID, conversationId>` stores the first UUID minted for each OpenCode session.
- Every request within the same session reuses the same `X-Conversation-ID` (across turns and tool calls).
- Different sessions are isolated.
- `session.compacted` and `session.deleted` events evict the corresponding entry.
- Capacity is bounded by `CODEBUDDY_CONVERSATION_ID_MAP_MAX` (default `1000`).
- Setting `CODEBUDDY_CONVERSATION_ID=0` opts out and reverts to per-request UUIDs.

The cache itself lives upstream; this plugin does not store any model output.

---

## Global install (no npm publish)

OpenCode auto-loads every `*.js` in `~/.config/opencode/plugins/` (Windows: `%USERPROFILE%\.config\opencode\plugins\`). Since this package is not published, drop a one-line wrapper that re-exports the local `dist/`:

```js
// ~/.config/opencode/plugins/codebuddy-plugin.js
export { default } from "file:///D:/opencode-codebuddy-plugin/dist/index.js";
```

After `npm run build` the new `dist/index.js` is picked up on the next OpenCode restart. Update the absolute path if you move the checkout.

Cleanup:

```powershell
Remove-Item ~/.config/opencode/plugins/codebuddy-plugin.js
```

---

## Token storage

- Path: `~/.local/share/opencode/auth.json`
- The `config` hook reads it directly via `fs.readFileSync`.
- OAuth mode: after a successful refresh the new token is written back through `input.client.auth.set({ path: { id: "codebuddy" }, body: { type: "oauth", access, refresh, expires } })`.
- API Key mode: the key is stored under the same path; it is **not** refreshed (regenerate it manually on the CodeBuddy website when needed). The env-var `CODEBUDDY_API_KEY` always wins over the stored value.

---

## Project layout

```
.
├── src/
│   └── index.ts          # the only source file — exports CodeBuddyAuthPlugin + default
├── dist/                 # build output (gitignored)
├── LICENSE
├── README.md
├── package.json
└── tsconfig.json
```

---

## License

[MIT](./LICENSE) — © 2026 HunkYuan.
