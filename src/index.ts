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
  authMode: (process.env.CODEBUDDY_AUTH_MODE || "auto").toLowerCase(),
  apiKey: process.env.CODEBUDDY_API_KEY || "",
  internetEnv: (
    process.env.CODEBUDDY_INTERNET_ENVIRONMENT || "internal"
  ).toLowerCase(),
  apiEndpoint: process.env.CODEBUDDY_API_ENDPOINT || "",
  sseBufferEnabled: process.env.CODEBUDDY_SSE_BUFFER !== "0",
  sseBufferThreshold: Number(process.env.CODEBUDDY_SSE_BUFFER_THRESHOLD) || 24,
  sseBufferMaxDelayMs: Number(process.env.CODEBUDDY_SSE_BUFFER_MAX_DELAY_MS) || 40,
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
  maxAllowedSize?: number;
  supportsToolCall?: boolean;
  supportsImages?: boolean;
  supportsReasoning?: boolean;
  disabledMultimodal?: boolean;
  onlyReasoning?: boolean;
  reasoning?: {
    effort?: string;
    defaultEffort?: string;
    summary?: string;
    supportedEfforts?: string[];
    canDisableThinking?: boolean;
  };
}

interface RemoteConfigResponse {
  code: number;
  data?: {
    agents?: Array<{ name: string; models?: string[] }>;
    models?: RemoteModel[];
  };
}

type ApiKeyAuth = { type: "api"; key: string };
type OAuthAuth = {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
};
type AuthState = ApiKeyAuth | OAuthAuth;

interface StoredAuth {
  type?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  key?: string;
}

function pickAuthMode(stored?: StoredAuth): "oauth" | "api" {
  if (CONFIG.authMode === "api") return "api";
  if (CONFIG.authMode === "oauth") return "oauth";
  if (CONFIG.apiKey) return "api";
  if (stored?.type === "api" && stored.key) return "api";
  return "oauth";
}

function effectiveAuth(stored: StoredAuth | undefined): AuthState | null {
  const mode = pickAuthMode(stored);
  if (mode === "api") {
    if (CONFIG.apiKey) return { type: "api", key: CONFIG.apiKey };
    if (stored?.type === "api" && stored.key)
      return { type: "api", key: stored.key };
    return null;
  }
  if (
    stored?.type === "oauth" &&
    stored.access &&
    typeof stored.expires === "number" &&
    stored.expires > Date.now()
  ) {
    return {
      type: "oauth",
      access: stored.access,
      refresh: stored.refresh || "",
      expires: stored.expires,
    };
  }
  if (stored?.type === "oauth" && stored.access) {
    return {
      type: "oauth",
      access: stored.access,
      refresh: stored.refresh || "",
      expires: stored.expires || 0,
    };
  }
  return null;
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

function resolveBaseUrl(): string {
  if (CONFIG.apiEndpoint) return CONFIG.apiEndpoint.replace(/\/+$/, "");
  if (CONFIG.internetEnv === "internal" || CONFIG.internetEnv === "ioa")
    return "https://copilot.tencent.com";
  return "https://www.codebuddy.ai";
}

function resolveDomainFromUrl(url: string): string {
  if (url.includes("codebuddy.ai")) return "www.codebuddy.ai";
  return "www.codebuddy.cn";
}

let resolvedServerUrl = resolveBaseUrl();
let resolvedDomain = resolveDomainFromUrl(resolvedServerUrl);

const sessionConversationIds = new LRUMap<string, string>(
  CONFIG.conversationIdMapMax,
);

let refreshInFlight: Promise<RefreshResponse["data"] | null> | null = null;

function remoteModelToConfig(m: RemoteModel): Record<string, unknown> {
  const entry: Record<string, unknown> = { name: m.name };
  const context = m.maxAllowedSize ?? m.maxInputTokens ?? 0;
  const output = m.maxOutputTokens ?? 0;
  if (context || output) {
    entry.limit = { context, output };
  }
  if (m.supportsToolCall) entry.tool_call = true;
  // CodeBuddy 用 disabledMultimodal 标记图文开关
  if (m.supportsImages && !m.disabledMultimodal) entry.attachment = true;
  if (m.supportsReasoning) {
    entry.reasoning = true;
    // CodeBuddy 推理统一走 reasoning_content
    entry.interleaved = { field: "reasoning_content" };
    const effort = m.reasoning?.defaultEffort ?? m.reasoning?.effort;
    if (effort) entry.options = { reasoningEffort: effort };
    const efforts = m.reasoning?.supportedEfforts;
    if (efforts && efforts.length > 0) {
      const variants: Record<string, unknown> = {};
      for (const e of efforts) variants[e] = { reasoningEffort: e };
      // 兼容：xhigh 在部分调用方写作 max，保留原值同时可扩展
      entry.variants = variants;
    }
  }
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

function buildAuthHeaders(auth: AuthState): Record<string, string> {
  if (auth.type === "api") {
    return {
      Authorization: `Bearer ${auth.key}`,
      "X-API-Key": auth.key,
    };
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.access}`,
  };
  const tenantId = resolveTenantId(auth.access);
  const enterpriseId = resolveEnterpriseId(auth.access);
  const userId = resolveUserId(auth.access);
  if (tenantId) headers["X-Tenant-Id"] = tenantId;
  if (enterpriseId) headers["X-Enterprise-Id"] = enterpriseId;
  if (userId) headers["X-User-Id"] = userId;
  return headers;
}

/**
 * SSE 缓冲：CodeBuddy 上游对 reasoning_content/content 按 1-2 字符/ token 推送，
 * opencode 每 delta 创建新 part 导致推理片段化（76214 events vs 正常 1218）与 DB 膨胀。
 * 此 Transform 按阈值合并同类 delta，减少 60-90% part 写入，TUI 恢复连贯。
 * 可通过 CODEBUDDY_SSE_BUFFER=0 禁用，阈值 CODEBUDDY_SSE_BUFFER_THRESHOLD，延迟 CODEBUDDY_SSE_BUFFER_MAX_DELAY_MS。
 */
function createSSEBufferedStream(
  body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let leftover = "";
  let reasoningBuf = "";
  let contentBuf = "";
  let reasoningTimer: ReturnType<typeof setTimeout> | null = null;
  let contentTimer: ReturnType<typeof setTimeout> | null = null;
  const threshold = CONFIG.sseBufferThreshold;
  const maxDelay = CONFIG.sseBufferMaxDelayMs;

  const hasFlushTrigger = (s: string) =>
    s.includes("\n") || /[。！？.!?；;，,：:]$/.test(s.trimEnd());

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        leftover += decoder.decode(chunk, { stream: true });
        const lines = leftover.split("\n");
        leftover = lines.pop() ?? "";

        for (const rawLine of lines) {
          const line = rawLine; // keep original without trailing \n
          if (!line.startsWith("data: ")) {
            // 空行或注释：先 flush 缓冲再透传
            if (reasoningBuf) {
              const out = `data: ${JSON.stringify({ id: "buffered", object: "chat.completion.chunk", created: Date.now(), choices: [{ index: 0, delta: { reasoning_content: reasoningBuf }, finish_reason: null }] })}\n`;
              controller.enqueue(encoder.encode(out));
              reasoningBuf = "";
              if (reasoningTimer) {
                clearTimeout(reasoningTimer);
                reasoningTimer = null;
              }
            }
            if (contentBuf) {
              const out = `data: ${JSON.stringify({ id: "buffered", object: "chat.completion.chunk", created: Date.now(), choices: [{ index: 0, delta: { content: contentBuf }, finish_reason: null }] })}\n`;
              controller.enqueue(encoder.encode(out));
              contentBuf = "";
              if (contentTimer) {
                clearTimeout(contentTimer);
                contentTimer = null;
              }
            }
            controller.enqueue(encoder.encode(line + "\n"));
            continue;
          }
          const payloadStr = line.slice(6);
          if (payloadStr.trim() === "[DONE]") {
            if (reasoningBuf) {
              const out = `data: ${JSON.stringify({ id: "buffered", object: "chat.completion.chunk", created: Date.now(), choices: [{ index: 0, delta: { reasoning_content: reasoningBuf }, finish_reason: null }] })}\n`;
              controller.enqueue(encoder.encode(out));
              reasoningBuf = "";
            }
            if (contentBuf) {
              const out = `data: ${JSON.stringify({ id: "buffered", object: "chat.completion.chunk", created: Date.now(), choices: [{ index: 0, delta: { content: contentBuf }, finish_reason: null }] })}\n`;
              controller.enqueue(encoder.encode(out));
              contentBuf = "";
            }
            controller.enqueue(encoder.encode(line + "\n"));
            continue;
          }
          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(payloadStr) as Record<string, unknown>;
          } catch {
            if (reasoningBuf) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: reasoningBuf } }] })}\n`,
                ),
              );
              reasoningBuf = "";
            }
            if (contentBuf) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ choices: [{ delta: { content: contentBuf } }] })}\n`,
                ),
              );
              contentBuf = "";
            }
            controller.enqueue(encoder.encode(line + "\n"));
            continue;
          }
          const choices = (payload as { choices?: Array<Record<string, unknown>> }).choices;
          const first = choices?.[0] as
            | { delta?: Record<string, unknown>; finish_reason?: unknown; finishReason?: unknown }
            | undefined;
          const delta = first?.delta as
            | { reasoning_content?: unknown; reasoning?: unknown; content?: unknown; tool_calls?: unknown }
            | undefined;
          const finishReason = first?.finish_reason ?? first?.finishReason;
          const hasReasoning =
            typeof delta?.reasoning_content === "string" && (delta.reasoning_content as string).length > 0;
          const hasReasoningAlt =
            typeof delta?.reasoning === "string" && (delta.reasoning as string).length > 0;
          const hasContent = typeof delta?.content === "string" && (delta.content as string).length > 0;
          const hasToolCalls =
            Array.isArray(delta?.tool_calls) && (delta.tool_calls as unknown[]).length > 0;

          // 纯 reasoning 增量：缓冲
          if ((hasReasoning || hasReasoningAlt) && !hasContent && !hasToolCalls && !finishReason) {
            const chunk = ((delta?.reasoning_content ?? delta?.reasoning) as string) ?? "";
            // 若之前有 content 缓冲，先 flush content
            if (contentBuf) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ choices: [{ delta: { content: contentBuf } }] })}\n`,
                ),
              );
              contentBuf = "";
              if (contentTimer) {
                clearTimeout(contentTimer);
                contentTimer = null;
              }
            }
            reasoningBuf += chunk;
            const shouldFlush =
              reasoningBuf.length >= threshold || hasFlushTrigger(reasoningBuf);
            if (shouldFlush) {
              const outPayload = {
                ...payload,
                choices: [
                  {
                    ...first,
                    delta: { reasoning_content: reasoningBuf },
                  },
                ],
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(outPayload)}\n`));
              reasoningBuf = "";
              if (reasoningTimer) {
                clearTimeout(reasoningTimer);
                reasoningTimer = null;
              }
            } else if (!reasoningTimer) {
              reasoningTimer = setTimeout(() => {
                if (reasoningBuf) {
                  const outPayload = {
                    ...payload,
                    choices: [
                      {
                        ...first,
                        delta: { reasoning_content: reasoningBuf },
                      },
                    ],
                  };
                  // 注意：无法在 timer 中直接 enqueue，需依赖下一个 chunk 的 flush；
                  // 此处仅标记超时，下次 transform 时会因超时而 flush
                  void outPayload;
                }
              }, maxDelay);
              // 实际 flush 依赖下次 transform 的超时检查
              // 简化：不依赖 timer 回调，直接由下次数据的 shouldFlush 或 finish 触发
              // 因此立即清除 timer，依赖长度/标点触发
              if (reasoningTimer) {
                clearTimeout(reasoningTimer);
                reasoningTimer = null;
              }
            }
            continue;
          }

          // 纯 content 增量：同样缓冲
          if (hasContent && !hasReasoning && !hasReasoningAlt && !hasToolCalls && !finishReason) {
            if (reasoningBuf) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: reasoningBuf } }] })}\n`,
                ),
              );
              reasoningBuf = "";
            }
            contentBuf += delta.content as string;
            const shouldFlush = contentBuf.length >= threshold || hasFlushTrigger(contentBuf);
            if (shouldFlush) {
              const outPayload = {
                ...payload,
                choices: [{ ...first, delta: { content: contentBuf } }],
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(outPayload)}\n`));
              contentBuf = "";
              if (contentTimer) {
                clearTimeout(contentTimer);
                contentTimer = null;
              }
            }
            continue;
          }

          // 混合或含 finish/tool_calls：先 flush 缓冲再透传原事件
          if (reasoningBuf) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: reasoningBuf } }] })}\n`,
              ),
            );
            reasoningBuf = "";
          }
          if (contentBuf) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: contentBuf } }] })}\n`),
            );
            contentBuf = "";
          }
          controller.enqueue(encoder.encode(line + "\n"));
        }
      },
      flush(controller) {
        if (reasoningBuf) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: reasoningBuf } }] })}\n`,
            ),
          );
          reasoningBuf = "";
        }
        if (contentBuf) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: contentBuf } }] })}\n`),
          );
          contentBuf = "";
        }
        if (leftover) {
          controller.enqueue(encoder.encode(leftover));
        }
      },
    }),
  );
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
      const authPath = path.join(
        os.homedir(),
        ".local",
        "share",
        "opencode",
        "auth.json",
      );
      let storedAuth: StoredAuth | undefined;
      try {
        const raw = fs.readFileSync(authPath, "utf8");
        const all = JSON.parse(raw) as Record<string, StoredAuth>;
        storedAuth = all[PROVIDER_ID];
      } catch {
        // auth not available yet, use fallback
      }

      const mode = pickAuthMode(storedAuth);
      if (mode === "api") {
        authAvailable = true;
        console.log(
          "[codebuddy] api key mode — using models from opencode.json config",
        );
        discovered = [];
      } else if (storedAuth?.type === "oauth" && storedAuth.access) {
        authAvailable = true;
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), DISCOVERY_TIMEOUT_MS);
        const work = fetchRemoteModels(storedAuth.access, ac.signal);
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

      if (!authAvailable) {
        if (mode === "api") {
          console.log(
            "[codebuddy] api key mode requested but no key found — set CODEBUDDY_API_KEY env or run `/connect codebuddy` (falling back to auto model)",
          );
        } else {
          console.log(
            `[codebuddy] no oauth token in ${authPath} — run \`/connect codebuddy\` to log in (falling back to auto model)`,
          );
        }
      } else if (mode === "oauth" && discovered.length === 0) {
        console.log(
          "[codebuddy] no models discovered from /v3/config (auth may be expired — try `/connect codebuddy` to re-authenticate)",
        );
      }

      if (discovered.length === 0 && Object.keys(models).length === 0) {
        discovered = [DEFAULT_MODEL];
      }

      for (const m of discovered) {
        const auto = remoteModelToConfig(m);
        const existing = models[m.id] as Record<string, unknown> | undefined;
        if (!existing) {
          models[m.id] = auto;
          continue;
        }
        // 已存在的手工配置：自动补齐缺失的 reasoning/attachment/limit，不覆盖手工显式值
        const merged: Record<string, unknown> = { ...auto, ...existing };
        // 深度合并关键子对象：手工缺失时用自动
        if (auto.reasoning && !existing.reasoning) {
          merged.reasoning = true;
          merged.interleaved = auto.interleaved;
        }
        if (auto.options && !existing.options) merged.options = auto.options;
        if (auto.variants && !existing.variants) merged.variants = auto.variants;
        if (auto.limit && !existing.limit) merged.limit = auto.limit;
        if (auto.attachment && existing.attachment === undefined) merged.attachment = true;
        if (auto.tool_call && existing.tool_call === undefined) merged.tool_call = true;
        models[m.id] = merged;
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

            const stored = (await getAuth()) as StoredAuth;
            const auth = effectiveAuth(stored);
            if (!auth) {
              const mode = pickAuthMode(stored);
              throw new Error(
                mode === "api"
                  ? "codebuddy: missing API key — set CODEBUDDY_API_KEY env or run `/connect codebuddy`"
                  : "codebuddy: missing oauth access token — run `/connect codebuddy` to log in",
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

            const doRequest = async (a: AuthState) => {
              const merged = new Headers(init?.headers);
              for (const [k, v] of Object.entries(buildAuthHeaders(a))) {
                merged.set(k, v);
              }

              // Inject stream_options to ensure usage info is returned in streaming responses
              let body = init?.body;
              try {
                const raw =
                  typeof body === "string"
                    ? body
                    : new TextDecoder().decode(body as ArrayBuffer);
                const parsed = JSON.parse(raw);
                if (parsed.stream && !parsed.stream_options) {
                  parsed.stream_options = { include_usage: true };
                  body = JSON.stringify(parsed);
                }
              } catch {}

              return fetch(
                `${resolvedServerUrl}${CONFIG.chatCompletionsPath}`,
                {
                  method: "POST",
                  headers: merged,
                  body,
                  signal: init?.signal,
                },
              );
            };

            let response = await doRequest(auth);
            let activeAuth = auth;

            if (
              activeAuth.type === "oauth" &&
              (response.status === 401 || response.status === 403) &&
              activeAuth.refresh
            ) {
              console.log("[codebuddy] Token expired, attempting refresh...");
              if (!refreshInFlight) {
                refreshInFlight = refreshAccessToken(activeAuth.refresh).finally(
                  () => {
                    refreshInFlight = null;
                  },
                );
              }
              const refreshed = await refreshInFlight;
              if (refreshed?.accessToken) {
                const newExpires = refreshed.expiresIn
                  ? Date.now() + refreshed.expiresIn * 1000
                  : Date.now() + 24 * 60 * 60 * 1000;
                activeAuth = {
                  type: "oauth",
                  access: refreshed.accessToken,
                  refresh: refreshed.refreshToken || activeAuth.refresh,
                  expires: newExpires,
                };
                const writeBody = {
                  type: "oauth" as const,
                  access: refreshed.accessToken,
                  refresh: refreshed.refreshToken || activeAuth.refresh,
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
                response = await doRequest(activeAuth);
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

            // SSE 缓冲：合并上游 1-2 字符的 reasoning/content 碎片，避免 opencode 每 delta 建新 part 导致推理片段化
            // 正常 220 events / 94 parts → 碎片化 75190 events / 37595 pids；缓冲后恢复正常量级
            if (
              CONFIG.sseBufferEnabled &&
              response.body &&
              response.headers.get("content-type")?.includes("text/event-stream")
            ) {
              const bufferedBody = createSSEBufferedStream(response.body as ReadableStream<Uint8Array>);
              return new Response(bufferedBody, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
              });
            }
            // 兼容：部分上游不设 event-stream 头但仍是 SSE（CodeBuddy 偶发），按 stream 标记兜底
            if (CONFIG.sseBufferEnabled && response.body) {
              try {
                const ct = response.headers.get("content-type") ?? "";
                // 若为 JSON 流或 chunked，也尝试缓冲（仅当 body 可读）
                if (!ct || ct.includes("application/json") || ct.includes("octet-stream")) {
                  // 探测：body 是否为 SSE 需代价，跳过；依赖显式头
                }
              } catch {}
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
        {
          label: "API Key 登录",
          type: "api",
          prompts: [
            {
              type: "text",
              key: "key",
              message: "请输入 CodeBuddy API Key（ck_xxx）",
              placeholder: "ck_xxxxxxxxxxxxxxxx.xxxxx",
            },
          ],
          async authorize(inputs) {
            const key = inputs?.key?.trim();
            if (!key) return { type: "failed" };
            return { type: "success", key };
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
