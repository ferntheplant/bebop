// Waiting for a Swordfish daemon to become answerable.
//
// Two things that look like readiness are not:
//
//   1. **The control socket file exists.** `makeControlSocket` binds the listener before
//      `initializeDatabase` and `workflow.bootstrap` run, deliberately — the listener is how a
//      second daemon is refused before reconciliation mutates state. So the socket accepts
//      connections for as long as migrations and bootstrap take, and parks them until
//      `runControlServer` is forked. Measured on an idle machine that window is 16-309ms; on a
//      loaded CI runner it is longer. A caller that treats the file as readiness sends its first
//      real request into that window and waits on it.
//
//   2. **A freshly spawned `sf` finished within a short timeout.** Cold-starting `bun` and
//      loading the packed CLI costs ~130ms idle, ~600ms at 4x CPU oversubscription and ~1.4s at
//      8x — and `vp run ready` fans five tasks out at once, so CI reaches those levels. A probe
//      that spawns a process on a one-second budget stops measuring the daemon and starts
//      measuring the scheduler; past the cliff every probe is killed before it connects, so no
//      amount of waiting can succeed. Worse, the killed CLI exits 130 having printed nothing, so
//      the failure reports an empty error and blames a daemon that was healthy the whole time.
//
// Readiness is therefore defined here as the only thing that actually answers the question: the
// daemon accepted a control request and returned a well-formed response to it. The probe runs
// in-process over the socket, so it costs what it measures and cannot be killed mid-flight.
//
// This is a readiness probe, not a substitute for driving the packed CLI. Suites that exist to
// prove the entrypoints work should still invoke `sf` as a process — they just should not do it
// on a stopwatch to decide whether the daemon is up yet.

import { randomUUID } from "node:crypto";
import { connect } from "node:net";

import type { SfControlResponse, SfStatusSnapshot } from "@bebop/contracts";
import {
  currentSfControlVersion,
  decodeSfControlResponseForRequest,
  SfControlRequest as SfControlRequestSchema,
} from "@bebop/contracts";
import { Schema } from "effect";

const maxControlFrameLength = 262_144;

const decodeRequest = Schema.decodeUnknownSync(SfControlRequestSchema);
const encodeRequest = Schema.encodeUnknownSync(SfControlRequestSchema);

function statusRequest() {
  return decodeRequest({
    type: "request",
    controlVersion: currentSfControlVersion,
    correlationId: `probe-${randomUUID()}`,
    command: { type: "status" },
  });
}

/**
 * One control request over the socket, in this process.
 *
 * Resolves with the daemon's response, or rejects describing how far it got — connect refused,
 * accepted but silent, closed early, or a frame that would not decode. Those are exactly the
 * distinctions a caller needs to explain a failure, and exactly the ones a spawned-and-killed
 * CLI erases.
 */
export function requestSwordfishStatus(
  path: string,
  options?: { readonly timeoutMillis?: number },
): Promise<SfControlResponse> {
  const timeoutMillis = options?.timeoutMillis ?? 2_000;
  const request = statusRequest();
  return new Promise((resolve, reject) => {
    const socket = connect({ path });
    let buffer = "";
    let connected = false;
    let settled = false;

    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      outcome();
    };
    const fail = (reason: string) => settle(() => reject(new Error(reason)));

    const timer = setTimeout(
      () => fail(connected ? "the daemon accepted the connection but did not answer" : "the connection never opened"),
      timeoutMillis,
    );

    socket.on("connect", () => {
      connected = true;
      socket.write(`${JSON.stringify(encodeRequest(request))}\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer) > maxControlFrameLength) {
        fail("the daemon response exceeded the control protocol limit");
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const frame = buffer.slice(0, newline);
      settle(() => {
        try {
          resolve(decodeSfControlResponseForRequest(JSON.parse(frame) as unknown, request));
        } catch (cause) {
          reject(new Error(`the daemon returned an undecodable response: ${String(cause)}`));
        }
      });
    });
    socket.on("error", (cause: NodeJS.ErrnoException) => fail(`connect failed (${cause.code ?? cause.message})`));
    socket.on("close", () => fail("the daemon closed the connection before answering"));
  });
}

/**
 * Resolves once the daemon answers a status request, or throws naming every attempt.
 *
 * `isRunning` lets a dead daemon fail immediately instead of burning the whole deadline; pass the
 * child process's liveness. `describeDaemon` is appended to the failure so the caller's log
 * output lands in the same message as the probe history.
 */
export async function waitForSwordfishControl(options: {
  readonly path: string;
  readonly timeoutMillis?: number;
  readonly isRunning?: () => boolean;
  readonly describeDaemon?: () => string;
}): Promise<SfStatusSnapshot> {
  const timeoutMillis = options.timeoutMillis ?? 30_000;
  const deadline = Date.now() + timeoutMillis;
  const startedAt = Date.now();
  const attempts: Array<string> = [];

  for (;;) {
    const attemptedAt = Date.now();
    let failure: string | undefined;
    try {
      const response = await requestSwordfishStatus(options.path, {
        timeoutMillis: Math.max(250, Math.min(2_000, deadline - Date.now())),
      });
      if (response.type === "success") return response.result.snapshot;
      failure = `the daemon answered with ${response.error.code}: ${response.error.message}`;
    } catch (cause) {
      failure = cause instanceof Error ? cause.message : String(cause);
    }
    attempts.push(`  t+${Date.now() - startedAt}ms after ${Date.now() - attemptedAt}ms: ${failure}`);

    if (options.isRunning?.() === false) {
      throw new Error(
        [
          `The Swordfish daemon exited before answering on ${options.path}.`,
          ...attempts.slice(-5),
          options.describeDaemon?.() ?? "",
        ].join("\n"),
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        [
          `The Swordfish daemon did not answer a control request on ${options.path} within ${timeoutMillis}ms.`,
          `Last ${Math.min(5, attempts.length)} of ${attempts.length} probe(s):`,
          ...attempts.slice(-5),
          options.describeDaemon?.() ?? "",
        ].join("\n"),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
