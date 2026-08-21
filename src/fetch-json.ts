// src/fetch-json.ts 关键结构
function withTimeout(ms: number, external?: AbortSignal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const onAbort = () => ctrl.abort();
  if (external) {
    if (external.aborted) ctrl.abort();
    else external.addEventListener("abort", onAbort, { once: true });
  }
  return { signal: ctrl.signal, cancel: () => { clearTimeout(timer); external?.removeEventListener("abort", onAbort); } };
}
export async function fetchJson<T>(url: string, opts: { method?: string; headers?: Record<string,string>; body?: string; timeoutMs: number; signal?: AbortSignal }) {
  const t = withTimeout(opts.timeoutMs, opts.signal);
  if (t.signal.aborted) return { ok: false as const, text: "timeout or abort" };
  try {
    const res = await Promise.race([
      fetch(url, { method: opts.method, headers: opts.headers, body: opts.body, signal: t.signal }),
      new Promise<never>((_, reject) => t.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
    ]);
    if (!res.ok) {
      const text = (await res.text()).slice(0, 500);
      return { ok: false as const, status: res.status, text };
    }
    const data = await res.json() as T;
    return { ok: true as const, data };
  } catch {
    return { ok: false as const, text: "timeout or abort" };
  } finally { t.cancel(); }
}