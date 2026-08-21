import { describe, it, expect } from "vitest";
import { createSSEBufferedStream } from "../src/sse-buffer.js";

function sseDelta(delta: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ id:"test", object:"chat.completion.chunk", created: Date.now(), choices:[{ index:0, delta, finish_reason:null }] })}\n`;
}
function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); }
  });
}
async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const dec = new TextDecoder();
  let out = "";
  const reader = stream.getReader();
  while (true) { const { done, value } = await reader.read(); if (done) break; out += dec.decode(value, { stream:true }); }
  return out;
}

describe("sse-buffer threshold", () => {
  it("reasoning 碎片合并至 threshold 才 flush", async () => {
    const stream = makeStream([sseDelta({ reasoning_content:"a" }), sseDelta({ reasoning_content:"b" })]);
    const buffered = createSSEBufferedStream(stream, { threshold: 10, maxDelayMs: 1000 });
    const out = await collect(buffered);
    // 2 字符未达阈值，应在 flush 时合并为单条 reasoning_content:"ab"
    expect(out).toContain('"reasoning_content":"ab"');
    expect((out.match(/reasoning_content/g) || []).length).toBe(1);
  });
  it("换行触发 includes(\"\\n\") 立即 flush（多行代码块不滞留）", async () => {
    const stream = makeStream([sseDelta({ reasoning_content:"line1\n" })]);
    const buffered = createSSEBufferedStream(stream, { threshold: 100, maxDelayMs: 1000 });
    const out = await collect(buffered);
    expect(out).toContain('"reasoning_content":"line1\\n"');
  });
  it("标点触发（。！？.!?；;，,：: + trimEnd）", async () => {
    const stream = makeStream([sseDelta({ reasoning_content:"你好。" })]);
    const buffered = createSSEBufferedStream(stream, { threshold: 100, maxDelayMs: 1000 });
    const out = await collect(buffered);
    expect(out).toContain('"reasoning_content":"你好。"');
  });
  it("尾空格 trimEnd 后仍触发标点", async () => {
    const stream = makeStream([sseDelta({ reasoning_content:"hi.   " })]);
    const buffered = createSSEBufferedStream(stream, { threshold: 100, maxDelayMs: 1000 });
    const out = await collect(buffered);
    expect(out).toContain('"reasoning_content"');
  });
});

describe("sse-buffer maxDelay 双侧定时", () => {
  it("reasoning 侧 maxDelay 定时冲出（新增行为）", async () => {
    const stream = makeStream([sseDelta({ reasoning_content:"x" })]);
    const buffered = createSSEBufferedStream(stream, { threshold: 100, maxDelayMs: 15 });
    const outP = collect(buffered);
    await new Promise(r => setTimeout(r, 40));
    const out = await outP;
    expect(out).toContain('"reasoning_content":"x"');
  });
  it("content 侧 maxDelay 定时冲出（原 contentTimer 从未生效，现为新增）", async () => {
    const stream = makeStream([sseDelta({ content:"y" })]);
    const buffered = createSSEBufferedStream(stream, { threshold: 100, maxDelayMs: 15 });
    const outP = collect(buffered);
    await new Promise(r => setTimeout(r, 40));
    const out = await outP;
    expect(out).toContain('"content":"y"');
  });
  it("timer 回调在流已 close 后不抛（try/catch）", async () => {
    const stream = makeStream([sseDelta({ reasoning_content:"z" })]);
    const buffered = createSSEBufferedStream(stream, { threshold: 100, maxDelayMs: 10 });
    // 立即消费并关闭，timer 后续 enqueue 应被 catch
    const out = await collect(buffered);
    expect(out).toContain("z");
    await new Promise(r => setTimeout(r, 30)); // timer 触发但不抛
  });
});

describe("sse-buffer format & leftover", () => {
  it("14 处模板统一为完整格式（含 id/object/created）", async () => {
    const stream = makeStream([sseDelta({ reasoning_content:"a" }), sseDelta({ content:"b" }), "data: [DONE]\n"]);
    const buffered = createSSEBufferedStream(stream, { threshold: 1, maxDelayMs: 1000 });
    const out = await collect(buffered);
    // 完整格式含 buffered id
    expect(out).toContain('"object":"chat.completion.chunk"');
    expect(out).toContain("[DONE]");
  });
  it("leftover 数组收集（O(n²) 修复）", async () => {
    // 跨包 UTF-8：1-2 字符/包场景
    const enc = new TextEncoder();
    const part1 = enc.encode(sseDelta({ content:"你" }).slice(0, 10));
    const part2 = enc.encode(sseDelta({ content:"你" }).slice(10));
    const stream = new ReadableStream<Uint8Array>({ start(c){ c.enqueue(part1); c.enqueue(part2); c.close(); } });
    const buffered = createSSEBufferedStream(stream, { threshold: 1, maxDelayMs: 1000 });
    const out = await collect(buffered);
    expect(out).toContain("你");
  });
  it("非 data 行与 [DONE] 前冲剩余 buffer", async () => {
    const stream = makeStream([sseDelta({ reasoning_content:"pre" }), ": comment\n", "data: [DONE]\n"]);
    const buffered = createSSEBufferedStream(stream, { threshold: 100, maxDelayMs: 1000 });
    const out = await collect(buffered);
    expect(out).toContain('"reasoning_content":"pre"');
    expect(out).toContain("[DONE]");
  });
});