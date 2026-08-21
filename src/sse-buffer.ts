const FLUSH_RE = /[。！？.!?；;，,：:]$/;

function hasFlushTrigger(s: string): boolean {
  return s.includes("\n") || FLUSH_RE.test(s.trimEnd());
}

function flushBuf(controller: TransformStreamDefaultController<Uint8Array>, field: "reasoning_content" | "content", buf: string): void {
  if (!buf) return;
  const payload = { id:"buffered", object:"chat.completion.chunk", created: Date.now(), choices:[{ index:0, delta:{ [field]: buf }, finish_reason:null }] };
  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n`));
}

export function createSSEBufferedStream(
  body: ReadableStream<Uint8Array>,
  opts: { threshold:number; maxDelayMs:number },
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const threshold = opts.threshold;
  const maxDelay = opts.maxDelayMs;
  let leftoverChunks: string[] = [];
  let leftover = "";
  let reasoningBuf = "";
  let contentBuf = "";
  let reasoningTimer: ReturnType<typeof setTimeout> | null = null;
  let contentTimer: ReturnType<typeof setTimeout> | null = null;

  const clearReasoningTimer = () => { if (reasoningTimer) { clearTimeout(reasoningTimer); reasoningTimer = null; } };
  const clearContentTimer = () => { if (contentTimer) { clearTimeout(contentTimer); contentTimer = null; } };

  const scheduleReasoningFlush = (ctrl: TransformStreamDefaultController<Uint8Array>) => {
    if (reasoningTimer || !reasoningBuf) return;
    reasoningTimer = setTimeout(() => {
      try { flushBuf(ctrl, "reasoning_content", reasoningBuf); } catch {}
      reasoningBuf = "";
      reasoningTimer = null;
    }, maxDelay);
  };
  const scheduleContentFlush = (ctrl: TransformStreamDefaultController<Uint8Array>) => {
    if (contentTimer || !contentBuf) return;
    contentTimer = setTimeout(() => {
      try { flushBuf(ctrl, "content", contentBuf); } catch {}
      contentBuf = "";
      contentTimer = null;
    }, maxDelay);
  };

  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      leftover += decoder.decode(chunk, { stream:true });
      const lines = leftover.split("\n");
      leftover = lines.pop() ?? "";
      for (const rawLine of lines) {
        const line = rawLine;
        if (!line.startsWith("data: ")) {
          if (reasoningBuf) { flushBuf(controller, "reasoning_content", reasoningBuf); reasoningBuf=""; clearReasoningTimer(); }
          if (contentBuf) { flushBuf(controller, "content", contentBuf); contentBuf=""; clearContentTimer(); }
          controller.enqueue(encoder.encode(line + "\n"));
          continue;
        }
        const payloadStr = line.slice(6);
        if (payloadStr.trim() === "[DONE]") {
          if (reasoningBuf) { flushBuf(controller, "reasoning_content", reasoningBuf); reasoningBuf=""; clearReasoningTimer(); }
          if (contentBuf) { flushBuf(controller, "content", contentBuf); contentBuf=""; clearContentTimer(); }
          controller.enqueue(encoder.encode(line + "\n"));
          continue;
        }
        let payload: Record<string,unknown>;
        try { payload = JSON.parse(payloadStr) as Record<string,unknown>; } catch {
          if (reasoningBuf) { flushBuf(controller, "reasoning_content", reasoningBuf); reasoningBuf=""; clearReasoningTimer(); }
          if (contentBuf) { flushBuf(controller, "content", contentBuf); contentBuf=""; clearContentTimer(); }
          controller.enqueue(encoder.encode(line + "\n"));
          continue;
        }
        const choices = (payload as any).choices as Array<any> | undefined;
        const first = choices?.[0];
        const delta = first?.delta as any;
        const finishReason = first?.finish_reason ?? first?.finishReason;
        const hasReasoning = typeof delta?.reasoning_content === "string" && delta.reasoning_content.length > 0;
        const hasReasoningAlt = typeof delta?.reasoning === "string" && delta.reasoning.length > 0;
        const hasContent = typeof delta?.content === "string" && delta.content.length > 0;
        const hasToolCalls = Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0;

        if ((hasReasoning || hasReasoningAlt) && !hasContent && !hasToolCalls && !finishReason) {
          const chunk = (delta?.reasoning_content ?? delta?.reasoning) as string;
          if (contentBuf) { flushBuf(controller, "content", contentBuf); contentBuf=""; clearContentTimer(); }
          reasoningBuf += chunk;
          if (reasoningBuf.length >= threshold || hasFlushTrigger(reasoningBuf)) {
            const out = { ...(payload as object), choices:[{ ...first, delta:{ reasoning_content: reasoningBuf } }] };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(out)}\n`));
            reasoningBuf=""; clearReasoningTimer();
          } else {
            scheduleReasoningFlush(controller);
          }
          continue;
        }
        if (hasContent && !hasReasoning && !hasReasoningAlt && !hasToolCalls && !finishReason) {
          if (reasoningBuf) { flushBuf(controller, "reasoning_content", reasoningBuf); reasoningBuf=""; clearReasoningTimer(); }
          contentBuf += delta.content as string;
          if (contentBuf.length >= threshold || hasFlushTrigger(contentBuf)) {
            const out = { ...(payload as object), choices:[{ ...first, delta:{ content: contentBuf } }] };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(out)}\n`));
            contentBuf=""; clearContentTimer();
          } else {
            scheduleContentFlush(controller);
          }
          continue;
        }
        if (reasoningBuf) { flushBuf(controller, "reasoning_content", reasoningBuf); reasoningBuf=""; clearReasoningTimer(); }
        if (contentBuf) { flushBuf(controller, "content", contentBuf); contentBuf=""; clearContentTimer(); }
        controller.enqueue(encoder.encode(line + "\n"));
      }
    },
    flush(controller) {
      clearReasoningTimer(); clearContentTimer();
      if (reasoningBuf) flushBuf(controller, "reasoning_content", reasoningBuf);
      if (contentBuf) flushBuf(controller, "content", contentBuf);
      if (leftover) controller.enqueue(encoder.encode(leftover));
    },
  }));
}