import type {
  Hooks,
  PluginInput,
  Plugin,
} from "@opencode-ai/plugin";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const PROVIDER_ID = "codebuddy";

const CONFIG = {
  serverUrl: "https://copilot.tencent.com",
  chatCompletionsPath: "/v2/chat/completions",
  platform: "VSCode",
  appVersion: "4.9.29177644",
  ideName: "VSCode",
  ideType: "VSCode",
  ideVersion: "1.119.0",
  domain: "www.codebuddy.cn",
  product: "SaaS",
  agentIntent: "craft",
  envId: "production",
  tenantId: process.env.CODEBUDDY_TENANT_ID || "",
  enterpriseId: process.env.CODEBUDDY_ENTERPRISE_ID || "",
  userId: process.env.CODEBUDDY_USER_ID || "",
  defaultModel: process.env.CODEBUDDY_DEFAULT_MODEL || "",
  stableConversationId: process.env.CODEBUDDY_STABLE_CONVERSATION_ID !== "0",
  conversationIdMapMax:
    Number(process.env.CODEBUDDY_CONVERSATION_ID_MAP_MAX) || 1000,
};

interface JwtPayload {
  iss?: string;
  tenant_id?: string;
  tenantId?: string;
  enterprise_id?: string;
  enterpriseId?: string;
  ent_id?: string;
  entId?: string;
  user_id?: string;
  userId?: string;
  uid?: string;
  sub?: string;
  realm_access?: { roles?: string[] };
  resource_access?: { account?: { roles?: string[] } };
}

interface AuthStateResponse {
  code: number;
  data?: {
    state: string;
    authUrl?: string;
  };
}

interface TokenPollResponse {
  code: number;
  data?: {
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number;
  };
}

interface RefreshResponse {
  code: number;
  data?: {
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number;
  };
}

interface RemoteModel {
  id: string;
  name: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  supportsToolCall?: boolean;
  supportsImages?: boolean;
  supportsReasoning?: boolean;
}

interface RemoteConfigResponse {
  code: number;
  data?: {
    agents?: Array<{ name: string; models?: string[] }>;
    models?: RemoteModel[];
  };
}

const DEFAULT_MODEL: RemoteModel = {
  id: "auto",
  name: "Auto",
  maxInputTokens: 168000,
  maxOutputTokens: 32000,
  supportsToolCall: true,
};

const DISCOVERY_TIMEOUT_MS = 5000;

class LRUMap<K, V> {
  private map = new Map<K, V>();
  constructor(private max: number) {}
  get(k: K): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k: K, v: V): void {
    if (this.map.has(k)) {
      this.map.delete(k);
    } else if (this.map.size >= this.max) {
      const first = this.map.keys().next().value;
      if (first !== undefined) this.map.delete(first);
    }
    this.map.set(k, v);
  }
  delete(k: K): boolean {
    return this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
  get size(): number {
    return this.map.size;
  }
}

let resolvedServerUrl = CONFIG.serverUrl;
let resolvedDomain = CONFIG.domain;

const sessionConversationIds = new LRUMap<string, string>(
  CONFIG.conversationIdMapMax,
);

let refreshInFlight: Promise<RefreshResponse["data"] | null> | null = null;

function remoteModelToConfig(m: RemoteModel): Record<string, unknown> {
  const entry: Record<string, unknown> = { name: m.name };
  if (m.maxInputTokens || m.maxOutputTokens) {
    entry.limit = {
      context: m.maxInputTokens ?? 0,
      output: m.maxOutputTokens ?? 0,
    };
  }
  if (m.supportsToolCall) entry.tool_call = true;
  if (m.supportsImages) entry.attachment = true;
  return entry;
}

async function fetchRemoteModels(
  accessToken: string,
  signal?: AbortSignal,
): Promise<RemoteModel[]> {
  const headers: Record<string, string> = {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
    Authorization: `Bearer ${accessToken}`,
    "X-Agent-Intent": CONFIG.agentIntent,
    "X-IDE-Type": CONFIG.ideType,
    "X-IDE-Name": CONFIG.ideName,
    "X-IDE-Version": CONFIG.ideVersion,
    "X-Product-Version": CONFIG.appVersion,
    "X-Env-ID": CONFIG.envId,
    "X-Domain": resolvedDomain,
    "X-Product": CONFIG.product,
    "User-Agent": `${CONFIG.ideName}/${CONFIG.ideVersion} CodeBuddy/${CONFIG.appVersion}`,
  };
  const resp = await fetch(`${resolvedServerUrl}/v3/config`, {
    headers,
    signal,
  });
  if (!resp.ok) return [];
  const body = (await resp.json()) as RemoteConfigResponse;
  if (body.code !== 0 || !body.data) return [];
  const allModels = body.data.models || [];
  const modelMap = new Map(allModels.map((m) => [m.id, m]));
  const craftAgent = (body.data.agents || []).find(
    (a) => a.name === CONFIG.agentIntent,
  );
  const craftIds = craftAgent?.models || [];
  if (craftIds.length === 0) return [DEFAULT_MODEL];
  return craftIds
    .map((id) => modelMap.get(id))
    .filter((m): m is RemoteModel => !!m?.supportsToolCall);
}

function generateUuid(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function decodeJwtPayload(token: string): JwtPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = "=".repeat((4 - (payload.length % 4)) % 4);
    return JSON.parse(Buffer.from(payload + pad, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function resolveTenantId(accessToken: string): string {
  if (CONFIG.tenantId) return CONFIG.tenantId;
  const p = decodeJwtPayload(accessToken);
  if (!p) return "";
  const iss = p.iss || "";
  const m = iss.match(/realms\/sso-([^/]+)$/);
  return p.tenant_id || p.tenantId || (m?.[1] || "");
}

function resolveEnterpriseId(accessToken: string): string {
  if (CONFIG.enterpriseId) return CONFIG.enterpriseId;
  const p = decodeJwtPayload(accessToken);
  if (!p) return "";
  const roles = p.realm_access?.roles || p.resource_access?.account?.roles;
  if (roles) {
    for (const r of roles) {
      const m = r.match(/group-admin:([A-Za-z0-9-]+)/);
      if (m?.[1]) return m[1];
    }
  }
  return p.enterprise_id || p.enterpriseId || p.ent_id || p.entId || "";
}

function resolveUserId(accessToken: string): string {
  if (CONFIG.userId) return CONFIG.userId;
  const p = decodeJwtPayload(accessToken);
  return p?.user_id || p?.userId || p?.uid || p?.sub || "";
}

function resolveModel(inputModel?: string): string {
  if (CONFIG.defaultModel) return CONFIG.defaultModel;
  return inputModel || "";
}

function generateTraceId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function getOrCreateConversationId(sessionId: string | undefined): string {
  if (!CONFIG.stableConversationId) return generateTraceId();
  if (!sessionId) return generateTraceId();
  let id = sessionConversationIds.get(sessionId);
  if (!id) {
    id = generateTraceId();
    sessionConversationIds.set(sessionId, id);
  }
  return id;
}

function resetConversationId(sessionId: string | undefined): void {
  if (!sessionId) return;
  sessionConversationIds.delete(sessionId);
}

function buildRequestHeaders(
  sessionId: string | undefined,
  modelId?: string,
): Record<string, string> {
  const conversationId = getOrCreateConversationId(sessionId);
  const messageId = generateTraceId();
  const traceId = generateTraceId();
  const spanId = generateTraceId().slice(0, 16);
  const parentSpanId = generateTraceId().slice(0, 16);

  const headers: Record<string, string> = {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
    "X-Request-ID": messageId,
    "X-Conversation-ID": conversationId,
    "X-Conversation-Request-ID": messageId,
    "X-Conversation-Message-ID": messageId,
    "X-Agent-Intent": CONFIG.agentIntent,
    "X-IDE-Type": CONFIG.ideType,
    "X-IDE-Name": CONFIG.ideName,
    "X-IDE-Version": CONFIG.ideVersion,
    "X-Product-Version": CONFIG.appVersion,
    "X-Request-Trace-Id": traceId,
    "X-Env-ID": CONFIG.envId,
    "X-Domain": resolvedDomain,
    "X-Product": CONFIG.product,
    "User-Agent": `${CONFIG.ideName}/${CONFIG.ideVersion} CodeBuddy/${CONFIG.appVersion}`,
    b3: `${traceId}-${spanId}-1-${parentSpanId}`,
    "X-B3-TraceId": traceId,
    "X-B3-ParentSpanId": parentSpanId,
    "X-B3-SpanId": spanId,
    "X-B3-Sampled": "1",
  };

  if (modelId) headers["X-Model-ID"] = modelId;

  return headers;
}

function buildAuthHeaders(accessToken: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
  };
  const tenantId = resolveTenantId(accessToken);
  const enterpriseId = resolveEnterpriseId(accessToken);
  const userId = resolveUserId(accessToken);
  if (tenantId) headers["X-Tenant-Id"] = tenantId;
  if (enterpriseId) headers["X-Enterprise-Id"] = enterpriseId;
  if (userId) headers["X-User-Id"] = userId;
  return headers;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(ms: number, external?: AbortSignal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const onAbort = () => ctrl.abort();
  if (external) {
    if (external.aborted) ctrl.abort();
    else external.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    cancel: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", onAbort);
    },
  };
}

async function requestAuthState(): Promise<{ state: string; url: string }> {
  const params = new URLSearchParams({ platform: CONFIG.platform, ioa: "1" });
  const response = await fetch(
    `${resolvedServerUrl}/v2/plugin/auth/state?${params.toString()}`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-No-Authorization": "true",
        "X-No-User-Id": "true",
        "X-No-Enterprise-Id": "true",
        "X-No-Department-Info": "true",
      },
    },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Auth state request failed: ${response.status} - ${text}`);
  }
  const data = (await response.json()) as AuthStateResponse;
  if (data.code !== 0 || !data.data?.state) {
    throw new Error(`Invalid auth state response: ${JSON.stringify(data)}`);
  }
  const loginUrl =
    data.data.authUrl ||
    `${resolvedServerUrl}/login?platform=${CONFIG.platform}&state=${data.data.state}&ioa=1`;
  return { state: data.data.state, url: loginUrl };
}

async function pollForToken(
  state: string,
  expiresAt: number,
  signal?: AbortSignal,
): Promise<TokenPollResponse["data"] | null> {
  while (Date.now() < expiresAt) {
    if (signal?.aborted) return null;
    await sleep(3000);
    const t = withTimeout(8000, signal);
    try {
      const response = await fetch(
        `${resolvedServerUrl}/v2/plugin/auth/token?state=${state}`,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            "X-No-Authorization": "true",
            "X-No-User-Id": "true",
            "X-No-Enterprise-Id": "true",
            "X-No-Department-Info": "true",
          },
          signal: t.signal,
        },
      );
      if (response.ok) {
        const data = (await response.json()) as TokenPollResponse;
        if (data.code === 0 && data.data?.accessToken) return data.data;
      }
    } catch {
      if (signal?.aborted) return null;
    } finally {
      t.cancel();
    }
  }
  return null;
}

async function refreshAccessToken(
  refreshToken: string,
): Promise<RefreshResponse["data"] | null> {
  const t = withTimeout(5000);
  try {
    const response = await fetch(
      `${resolvedServerUrl}/v2/plugin/auth/token/refresh`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${refreshToken}`,
        },
        signal: t.signal,
      },
    );
    if (!response.ok) {
      const text = await response.text();
      console.error(
        `[codebuddy] token refresh failed: ${response.status} - ${text}`,
      );
      return null;
    }
    const data = (await response.json()) as RefreshResponse;
    if (data.code !== 0) {
      console.error(
        `[codebuddy] token refresh bad code: ${data.code} - ${JSON.stringify(data)}`,
      );
      return null;
    }
    return data.data || null;
  } catch (err) {
    console.error(`[codebuddy] token refresh threw:`, err);
    return null;
  } finally {
    t.cancel();
  }
}

export const CodeBuddyAuthPlugin: Plugin = async (input) => {
  return {
    async config(config) {
      if (!config.provider) config.provider = {};
      if (!config.provider[PROVIDER_ID]) {
        config.provider[PROVIDER_ID] = {
          npm: "@ai-sdk/openai-compatible",
          name: "CodeBuddy",
          options: {
            baseURL: `${resolvedServerUrl}/v2`,
            setCacheKey: true,
          },
          models: {},
        };
      }
      const provider = config.provider[PROVIDER_ID] as Record<string, unknown>;
      const opts = (provider.options || {}) as Record<string, unknown>;
      const configuredBase =
        typeof opts.baseURL === "string" ? opts.baseURL : undefined;
      if (configuredBase) {
        try {
          const u = new URL(configuredBase);
          resolvedServerUrl = `${u.protocol}//${u.host}`;
          if (resolvedServerUrl.includes("codebuddy.ai")) {
            resolvedDomain = "www.codebuddy.ai";
          }
        } catch {}
      }
      if (!provider.models) {
        provider.models = {};
      }
      const models = provider.models as Record<string, unknown>;

      let discovered: RemoteModel[] = [];
      let authAvailable = false;
      try {
        const home = os.homedir();
        const authPath = path.join(
          home,
          ".local",
          "share",
          "opencode",
          "auth.json",
        );
        const raw = fs.readFileSync(authPath, "utf8");
        const all = JSON.parse(raw) as Record<
          string,
          { type: string; access?: string }
        >;
        const auth = all[PROVIDER_ID];
        if (auth?.type === "oauth" && auth.access) {
          authAvailable = true;
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(), DISCOVERY_TIMEOUT_MS);
          const work = fetchRemoteModels(auth.access, ac.signal);
          try {
            discovered = await Promise.race([
              work,
              new Promise<RemoteModel[]>((resolve) =>
                setTimeout(() => resolve([]), DISCOVERY_TIMEOUT_MS),
              ),
            ]);
          } finally {
            clearTimeout(timer);
            ac.abort();
          }
        }
      } catch {
        // auth not available yet, use fallback
      }

      if (!authAvailable) {
        console.log(
          "[codebuddy] no oauth token in ~/.local/share/opencode/auth.json — run `/connect codebuddy` to log in (falling back to auto model)",
        );
      } else if (discovered.length === 0) {
        console.log(
          "[codebuddy] no models discovered from /v3/config (auth may be expired — try `/connect codebuddy` to re-authenticate)",
        );
      }

      if (discovered.length === 0) {
        discovered = [DEFAULT_MODEL];
      }

      for (const m of discovered) {
        if (models[m.id]) continue;
        models[m.id] = remoteModelToConfig(m);
      }
    },
    async event({ event }) {
      if (event.type === "session.compacted") {
        const props = (event as { properties?: { sessionID?: string } })
          .properties;
        resetConversationId(props?.sessionID);
      } else if (event.type === "session.deleted") {
        const props = (event as {
          properties?: { info?: { id?: string } };
        }).properties;
        resetConversationId(props?.info?.id);
      }
    },
    auth: {
      provider: PROVIDER_ID,
      async loader(getAuth, _provider) {
        return {
          apiKey: "cli-proxy",
          baseURL: resolvedServerUrl,
          async fetch(
            url: RequestInfo | URL,
            init?: RequestInit,
          ): Promise<Response> {
            const urlStr = url.toString();
            if (!urlStr.includes("/chat/completions")) {
              return fetch(url, init);
            }

            const currentAuth = await getAuth();
            if (currentAuth.type !== "oauth" || !currentAuth.access) {
              throw new Error(
                "codebuddy: missing oauth access token — run `/connect codebuddy` to log in",
              );
            }
            if (!init?.body) {
              return new Response(
                JSON.stringify({ error: "Missing request body" }),
                {
                  status: 400,
                  headers: { "Content-Type": "application/json" },
                },
              );
            }

            let accessToken = currentAuth.access;

            const doRequest = async (token: string) => {
              const merged = new Headers(init?.headers);
              for (const [k, v] of Object.entries(
                buildAuthHeaders(token),
              )) {
                merged.set(k, v);
              }
              return fetch(
                `${resolvedServerUrl}${CONFIG.chatCompletionsPath}`,
                {
                  method: "POST",
                  headers: merged,
                  body: init?.body,
                  signal: init?.signal,
                },
              );
            };

            let response = await doRequest(accessToken);

            if (
              (response.status === 401 || response.status === 403) &&
              currentAuth.refresh
            ) {
              console.log("[codebuddy] Token expired, attempting refresh...");
              if (!refreshInFlight) {
                refreshInFlight = refreshAccessToken(currentAuth.refresh).finally(
                  () => {
                    refreshInFlight = null;
                  },
                );
              }
              const refreshed = await refreshInFlight;
              if (refreshed?.accessToken) {
                accessToken = refreshed.accessToken;
                const newExpires = refreshed.expiresIn
                  ? Date.now() + refreshed.expiresIn * 1000
                  : Date.now() + 24 * 60 * 60 * 1000;
                const writeBody = {
                  type: "oauth" as const,
                  access: refreshed.accessToken,
                  refresh: refreshed.refreshToken || currentAuth.refresh,
                  expires: newExpires,
                };
                try {
                  await input.client.auth.set({
                    path: { id: PROVIDER_ID },
                    body: writeBody,
                  });
                } catch (err) {
                  console.error(
                    "[codebuddy] failed to persist refreshed token, continuing in-memory:",
                    err,
                  );
                }
                response = await doRequest(accessToken);
              }
            }

            if (!response.ok) {
              const errorText = await response.text();
              console.error(
                `[codebuddy] API error: ${response.status} - ${errorText}`,
              );
              const errorHeaders = new Headers(response.headers);
              errorHeaders.set("Content-Type", "application/json");
              return new Response(errorText, {
                status: response.status,
                headers: errorHeaders,
              });
            }

            return response;
          },
        };
      },
      methods: [
        {
          label: "IOA 登录 (浏览器)",
          type: "oauth",
          async authorize() {
            const authState = await requestAuthState();
            const expiresAt = Date.now() + 10 * 60 * 1000;
            return {
              url: authState.url,
              instructions: "请在浏览器中完成 IOA 登录",
              method: "auto" as const,
              async callback() {
                const tokenData = await pollForToken(
                  authState.state,
                  expiresAt,
                );
                if (!tokenData) return { type: "failed" as const };
                return {
                  type: "success" as const,
                  access: tokenData.accessToken,
                  refresh: tokenData.refreshToken || "",
                  expires: tokenData.expiresIn
                    ? Date.now() + tokenData.expiresIn * 1000
                    : Date.now() + 24 * 60 * 60 * 1000,
                };
              },
            };
          },
        },
      ],
    },
    async "chat.message"(input, _output) {
      getOrCreateConversationId(input.sessionID);
    },
    async "chat.headers"(input, output) {
      if (input.model.providerID !== PROVIDER_ID) return;
      const modelId = resolveModel(input.model.id);
      const headers = buildRequestHeaders(input.sessionID, modelId);
      for (const [k, v] of Object.entries(headers)) {
        output.headers[k] = v;
      }
    },
  } satisfies Hooks;
};

export default {
  id: "codebuddy-plugin",
  server: CodeBuddyAuthPlugin,
};
