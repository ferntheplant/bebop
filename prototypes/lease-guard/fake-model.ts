// Deterministic OpenAI-compatible endpoint. Records every inbound request so the
// spike can assert that a denied prompt produced *no* model turn at all.

const calls: Array<{ at: number; path: string; body: unknown }> = [];

function sse(chunks: Array<string>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const id = `chatcmpl-${Date.now()}`;
      for (const text of chunks) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: "fake-model",
              choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
            })}\n\n`,
          ),
        );
      }
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: "fake-model",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          })}\n\n`,
        ),
      );
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}

const server = Bun.serve({
  port: Number(process.env.FAKE_MODEL_PORT ?? 0),
  hostname: "127.0.0.1",
  idleTimeout: 120,
  async fetch(request) {
    const url = new URL(request.url);

    // Out-of-band control plane for the driver; never counted as a model call.
    if (url.pathname === "/__calls") {
      return Response.json({ count: calls.length, calls });
    }
    if (url.pathname === "/__reset") {
      calls.length = 0;
      return Response.json({ ok: true });
    }

    let body: unknown = null;
    try {
      body = await request.json();
    } catch {
      body = null;
    }

    if (url.pathname.endsWith("/models")) {
      return Response.json({
        object: "list",
        data: [{ id: "fake-model", object: "model", created: 0, owned_by: "bebop-spike" }],
      });
    }

    if (url.pathname.endsWith("/chat/completions")) {
      calls.push({ at: Date.now(), path: url.pathname, body });
      return sse(["Acknowledged. ", "No real model was contacted."]);
    }

    calls.push({ at: Date.now(), path: url.pathname, body });
    return Response.json({ error: `unhandled fake-model path ${url.pathname}` }, { status: 404 });
  },
});

process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${server.port}` })}\n`);
