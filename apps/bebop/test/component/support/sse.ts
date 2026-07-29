// Reading `text/event-stream` responses in a test.
//
// The stream never ends on its own — that is what a live subscription is — so the reader
// decides when it has seen enough and then *aborts*. Aborting is not tidiness: the server
// holds an idle connection for `httpIdleTimeout`, and a reader that merely stops reading
// leaves a live connection behind for the next server shutdown to wait on.

import { BountyEventEnvelope } from "@bebop/contracts";
import { Schema } from "effect";

import type { Harness } from "#test/component/support/harness.ts";

export interface SseFrame {
  readonly id: string;
  readonly cursor: number;
  readonly type: string;
}

export async function readSseFrames(
  harness: Harness,
  path: string,
  options: { readonly count: number; readonly lastEventId?: string; readonly timeoutMs?: number },
): Promise<ReadonlyArray<SseFrame>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 3_000);
  const frames: Array<SseFrame> = [];
  try {
    const response = await harness.request(path, {
      signal: controller.signal,
      ...(options.lastEventId === undefined ? {} : { headers: { "last-event-id": options.lastEventId } }),
    });
    if (!response.ok) {
      throw new Error(`SSE request failed with ${response.status}: ${await response.text()}`);
    }
    if (!response.headers.get("content-type")?.startsWith("text/event-stream")) {
      throw new Error(`Expected text/event-stream, got ${response.headers.get("content-type") ?? "no content type"}`);
    }
    if (response.body === null) {
      throw new Error("SSE response had no body");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (frames.length < options.count) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const id = /^id: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (id !== undefined && data !== undefined) {
          const parsed = Schema.decodeUnknownSync(BountyEventEnvelope)(JSON.parse(data) as unknown);
          frames.push({ id, cursor: parsed.cursor, type: parsed.event.type });
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
    await reader.cancel().catch(() => undefined);
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "AbortError") {
      throw error;
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
  if (frames.length < options.count) {
    throw new Error(`Expected ${options.count} SSE frames, received ${frames.length}`);
  }
  return frames;
}
