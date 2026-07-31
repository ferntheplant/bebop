# API first, with a thin CLI over generated contracts

The bebop HTTP API is the product interface. Effect Schema definitions generate the OpenAPI document and the client, and the `bebop` CLI is a thin caller of that generated client — it has no behaviour the API lacks and reads Postgres directly nowhere. The same rule binds `sf`: it calls only Swordfish's local control socket and never touches SQLite.

Both CLIs are the first client of an interface that GUIs, Linear, and future automation will also cross. Any behaviour that lives only in a CLI is behaviour the next client has to reimplement, so the CLI is deliberately kept shallow and the depth stays behind the API.

## Consequences

SSE events ship in the MVP even though the CLI barely needs them, because a client that must poll cannot be added later without changing the interface. `GET /api/health` is the single unauthenticated route, so container health checks need no credential baked into an image.
