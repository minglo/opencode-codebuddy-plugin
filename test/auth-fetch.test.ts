import { describe, it, expect, vi } from "vitest";
import { createAuthFetch } from "../src/auth-fetch.js";
import { RefreshLock } from "../src/auth-flow.js";
import type { AuthFetchDeps } from "../src/auth-fetch.js";

function makeDeps(overrides: Partial<AuthFetchDeps> = {}): AuthFetchDeps {
  return {
    getAuth: async () => ({ type: "api", key: "k" }),
    client: { auth: { set: async () => {} } },
    server: { url: "https://x", domain: "d" },
    buildAuthHeaders: () => ({}),
    resolveIdentity: () => ({ tenantId: "", enterpriseId: "", userId: "" }),
    decodeJwtPayload: () => null,
    createSSEBufferedStream: (body) => body,
    refreshLock: new RefreshLock(),
    cfg: { sse: { enabled: false, threshold: 24, maxDelayMs: 40 } },
    effectiveAuth: (stored) => (stored ?? null) as any,
    pickAuthMode: () => "api",
    refreshAccessToken: async () => null,
    chatCompletionsPath: "/v2/chat/completions",
    ...overrides,
  };
}

describe("auth-fetch", () => {
  it("非 chat/completions 透传", async () => {
    const fetch = createAuthFetch({ getAuth: async()=>({type:"api",key:"k"}), client:{}, server:{url:"https://x",domain:"d"}, buildAuth:()=>({}), sse:()=>null } as any);
    const orig = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("ok"));
    await fetch("https://x/other", { method:"GET" } as any);
    expect(globalThis.fetch).toHaveBeenCalled();
    globalThis.fetch=orig;
  });
  it("!body 400", async () => {
    const af = createAuthFetch(makeDeps({ getAuth: async () => ({ type: "api", key: "k" }) }));
    const res = await af("https://x/v2/chat/completions", { method: "POST" } as any);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing request body" });
  });
  it("!ok 透传并保留 Content-Type: application/json", async () => {
    (globalThis as any).fetch = async () => new Response("bad", { status: 500, headers: { "Content-Type": "text/plain" } });
    const af = createAuthFetch(makeDeps());
    const res = await af("https://x/v2/chat/completions", { method:"POST", body: JSON.stringify({stream:true}) } as any);
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });
  it("effectiveAuth null 抛 /connect 指引（区分 api/oauth）", async () => {
    const afApi = createAuthFetch(makeDeps({ getAuth: async () => null, effectiveAuth: () => null, pickAuthMode: () => "api" } as any));
    await expect(afApi("https://x/v2/chat/completions", { method:"POST", body: JSON.stringify({stream:true}) } as any)).rejects.toThrow(/missing API key/);
    const afOauth = createAuthFetch(makeDeps({ getAuth: async () => null, effectiveAuth: () => null, pickAuthMode: () => "oauth" } as any));
    await expect(afOauth("https://x/v2/chat/completions", { method:"POST", body: JSON.stringify({stream:true}) } as any)).rejects.toThrow(/\/connect/);
  });
  it("signal 透传至 doRequest", async () => {
    const spy = async (u: any, init: any) => { expect(init.signal).toBeDefined(); return new Response("ok", { status: 200 }); };
    (globalThis as any).fetch = spy;
    const af = createAuthFetch(makeDeps());
    const ac = new AbortController();
    await af("https://x/v2/chat/completions", { method:"POST", body: JSON.stringify({stream:true}), signal: ac.signal } as any);
  });
  it("SSE 包装保留原头：content-type text/event-stream 存活", async () => {
    (globalThis as any).fetch = async () => new Response(new ReadableStream({ start(c){ c.close(); } }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    const af = createAuthFetch(makeDeps({ cfg: { sse: { enabled: true, threshold: 24, maxDelayMs: 40 } } } as any));
    const res = await af("https://x/v2/chat/completions", { method:"POST", body: JSON.stringify({stream:true}) } as any);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
  });
  it("请求路径用 chatCompletionsPath 而非硬拼 /v2/chat/completions", async () => {
    const spy = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    (globalThis as any).fetch = spy;
    const af = createAuthFetch(makeDeps({ chatCompletionsPath: "/custom/path" } as any));
    await af("https://x/v2/chat/completions", { method:"POST", body: JSON.stringify({stream:true}) } as any);
    expect(spy.mock.calls[0][0]).toBe("https://x/custom/path");
  });
  it("RefreshLock key 用 PROVIDER_ID（codebuddy）单例", async () => {
    let calls = 0;
    const lock = new RefreshLock();
    (globalThis as any).fetch = async () => new Response("unauth", { status: 401 });
    const af = createAuthFetch(makeDeps({
      getAuth: async () => ({ type:"oauth", access:"a", refresh:"r", expires: 0 }),
      refreshLock: lock,
      refreshAccessToken: async () => { calls++; return { accessToken:"new", refreshToken:"r2", expiresIn:3600 }; },
    } as any));
    await Promise.all([
      af("https://x/v2/chat/completions", { method:"POST", body: JSON.stringify({stream:true}) } as any).catch(()=>{}),
      af("https://x/v2/chat/completions", { method:"POST", body: JSON.stringify({stream:true}) } as any).catch(()=>{}),
    ]);
    expect(calls).toBe(1);
  });
});