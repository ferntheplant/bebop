const calls: Array<{ readonly at: number; readonly body: unknown }> = [];

const completionChunk = (id: string, delta: unknown, finishReason: string | null = null) =>
  `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1_000),
    model: "fake-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;

function completion(body: unknown): Response {
  const encoder = new TextEncoder();
  const holdOpen = JSON.stringify(body).includes("hold-open");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const id = `chatcmpl-${Date.now()}`;
      controller.enqueue(encoder.encode(completionChunk(id, { role: "assistant", content: "Started. " })));
      timer = setTimeout(
        () => {
          controller.enqueue(encoder.encode(completionChunk(id, { content: "Finished." })));
          controller.enqueue(encoder.encode(completionChunk(id, {}, "stop")));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
        holdOpen ? 30_000 : 50,
      );
    },
    cancel() {
      if (timer) clearTimeout(timer);
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  idleTimeout: 120,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__calls") return Response.json({ count: calls.length });
    if (url.pathname.endsWith("/models")) {
      return Response.json({
        object: "list",
        data: [{ id: "fake-model", object: "model", created: 0, owned_by: "bebop-prototype" }],
      });
    }

    const body = await request.json().catch(() => null);
    if (url.pathname.endsWith("/chat/completions")) {
      calls.push({ at: Date.now(), body });
      return completion(body);
    }
    return Response.json({ error: `unhandled fake-model path ${url.pathname}` }, { status: 404 });
  },
});

process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${server.port}` })}\n`);
