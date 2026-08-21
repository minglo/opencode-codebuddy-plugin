// src/auth-fetch.ts
import type { AuthState } from "./auth-state.js";
export type AuthFetchDeps = {
  getAuth: () => Promise<unknown>;
  client: { auth: { set: (args: unknown) => Promise<void> } };
  server: { url: string; domain: string };
  buildAuthHeaders: (auth: AuthState, identity: { tenantId:string; enterpriseId:string; userId:string }) => Record<string,string>;
  resolveIdentity: (payload: unknown, cfg: unknown) => { tenantId:string; enterpriseId:string; userId:string };
  decodeJwtPayload: (token:string) => unknown;
  createSSEBufferedStream: (body: ReadableStream<Uint8Array>, opts: { threshold:number; maxDelayMs:number }) => ReadableStream<Uint8Array>;
  refreshLock: { run: <T>(key:string, fn:()=>Promise<T>)=>Promise<T> };
  cfg: { sse: { enabled:boolean; threshold:number; maxDelayMs:number } };
  fetchImpl?: typeof fetch;
  effectiveAuth: (stored: unknown) => AuthState | null;
  pickAuthMode: (stored: unknown) => "api"|"oauth";
  refreshAccessToken: (refresh:string, serverUrl:string) => Promise<{ accessToken:string; refreshToken?:string; expiresIn?:number } | null>;
  chatCompletionsPath: string;  // CHAT_COMPLETIONS_PATH 单一来源，禁止硬拼 "/v2/chat/completions"
};
export function createAuthFetch(deps: AuthFetchDeps) {
  const { getAuth, client, server, buildAuthHeaders, resolveIdentity, decodeJwtPayload, createSSEBufferedStream, refreshLock, cfg, fetchImpl, chatCompletionsPath } = deps;
  const doFetch = () => fetchImpl ?? globalThis.fetch;
  return async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = url.toString();
    if (!urlStr.includes("/chat/completions")) return doFetch()(url, init);
    const stored = await getAuth();
    const auth = deps.effectiveAuth(stored);
    if (!auth) {
      const mode = deps.pickAuthMode(stored);
      throw new Error(mode === "api" ? "codebuddy: missing API key — set CODEBUDDY_API_KEY env or run `/connect codebuddy`" : "codebuddy: missing oauth access token — run `/connect codebuddy` to log in");
    }
    if (!init?.body) return new Response(JSON.stringify({ error: "Missing request body" }), { status: 400, headers: { "Content-Type": "application/json" } });
    const doRequest = async (a: AuthState) => {
      const headers = new Headers(init.headers as HeadersInit);
      const identity = a.type === "oauth" ? resolveIdentity(decodeJwtPayload(a.access), cfg) : { tenantId:"", enterpriseId:"", userId:"" };
      for (const [k,v] of Object.entries(buildAuthHeaders(a, identity as any))) headers.set(k, v);
      let body: BodyInit | null | undefined = init.body as BodyInit;
      try {
        const raw = typeof body === "string" ? body as string : new TextDecoder().decode(body as ArrayBuffer);
        const parsed = JSON.parse(raw);
        if (parsed.stream === true && !parsed.stream_options) { parsed.stream_options = { include_usage: true }; body = JSON.stringify(parsed); }
      } catch {}
      return doFetch()(`${server.url}${chatCompletionsPath}`, { method: "POST", headers, body: body as BodyInit, signal: init.signal });
    };
    let response = await doRequest(auth);
    let activeAuth: AuthState = auth;
    if (activeAuth.type === "oauth" && (response.status === 401 || response.status === 403) && activeAuth.refresh) {
      // 预刷新（A4）与 401/403 兜底：needsRefresh 触发或 401/403 才刷新；RefreshLock 按 PROVIDER_ID 单例
      const oauthAuth = activeAuth;
      const refreshed = await refreshLock.run("codebuddy", () => deps.refreshAccessToken(oauthAuth.refresh, server.url));
      if (refreshed?.accessToken) {
        const newExpires = refreshed.expiresIn ? Date.now() + refreshed.expiresIn * 1000 : Date.now() + 24*60*60*1000;
        const next: AuthState = { type: "oauth", access: refreshed.accessToken, refresh: refreshed.refreshToken || activeAuth.refresh, expires: newExpires };
        const writeBody = { type: "oauth" as const, access: next.access, refresh: next.refresh, expires: next.expires };
        try { await client.auth.set({ path: { id: "codebuddy" }, body: writeBody }); } catch { /* in-memory 续用 + error 日志（log.ts） */ }
        activeAuth = next;
        response = await doRequest(activeAuth);
      }
    }
    if (!response.ok) {
      const text = await response.text();
      const h = new Headers(response.headers);
      h.set("Content-Type", "application/json");
      return new Response(text, { status: response.status, headers: h });
    }
    if (cfg.sse.enabled && response.body && response.headers.get("content-type")?.includes("text/event-stream")) {
      const buffered = createSSEBufferedStream(response.body as ReadableStream<Uint8Array>, { threshold: cfg.sse.threshold, maxDelayMs: cfg.sse.maxDelayMs });
      return new Response(buffered as unknown as BodyInit, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    return response;
  };
}