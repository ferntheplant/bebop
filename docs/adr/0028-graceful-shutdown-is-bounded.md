# Graceful shutdown is bounded on both processes

Bebop bounds `server.stop()` with `shutdownTimeout`, and Swordfish closes its scope in a detached fiber and abandons finalizers exceeding `SWORDFISH_SHUTDOWN_TIMEOUT`.

A graceful `server.stop()` can wait forever: a WebSocket whose close handshake is in flight when the server stops accepting reproduces it every time, and that would hang the blue/green drain on every deploy. On the Swordfish side, a stuck socket close must not outlive the supervisor's grace period.

## Consequences

`httpIdleTimeout` defaults to Bun's maximum of 255 seconds rather than being disabled, for the related reason: an unbounded idle connection is a resource a half-dead client can hold forever, and the event stream is resumable by construction — a dropped subscriber reconnects with `Last-Event-ID` and misses nothing.
