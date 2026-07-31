# Effect on Bun for every process

Bebop, Swordfish, both CLIs, and the OpenCode plugin are one TypeScript codebase on the Effect 4 beta line running on Bun. Effect Schema defines every contract, services carry time, IDs, process execution, and external clients, and typed errors carry domain failures while defects stay crashes handled by process supervision.

Rust or Zig would cut Swordfish's memory, startup time, and binary size, but OpenCode, language servers, repository builds, dev services, and Playwright dominate the 2c/4GB bounty profile — and a second language would introduce generated cross-language contracts plus a second concurrency and recovery model before the workflow is even proven.

## Consequences

The whole stack is pinned together on the Effect 4 beta line — see [Imports and runtime](../gotchas.md#imports-and-runtime) for what that forbids.

Reconsider a Rust-only Swordfish only on measurement: when it materially causes OOMs or stalls, sustains roughly 150–200 MB P95 working set after straightforward tuning, or when reclaiming its measured overhead would improve bounty throughput by about 10%.
