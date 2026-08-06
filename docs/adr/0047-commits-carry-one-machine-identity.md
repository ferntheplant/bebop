# Commits carry one machine identity

This supersedes [Commits are authored by the acting seat (ADR 0032)](./0032-commits-are-authored-by-the-acting-seat.md).

Every commit a bounty produces is authored by a single machine identity, `bebop`, regardless of which seat acted and regardless of whether the operator steered the work through takeover. The acting seat and the bounty travel in commit-message trailers, where structured provenance belongs and where a reader can find them without asking `git blame` a question it cannot answer.

What ADR 0032 was protecting survives untouched: no human appears as the author of code they did not write. What it added on top — a distinct Git identity per seat — was machinery for a distinction nobody makes. Only ein commits. A per-seat author field encodes a taxonomy the system does not use, and it would have to be created, configured, and kept in step across three identities to express something a trailer expresses better.

The takeover case is the one worth stating outright, because it is what ADR 0032 named as its hardest example. An operator driving ein through the cockpit supplies intent, not code; attributing the commit to them would send the next reader of `git blame` to ask a human about lines they never read. The author stays `bebop` there too, and the trailers record that a takeover occurred.

## Consequences

Tooling that assumes a human author — review assignment, `git shortlog` headcounts, CODEOWNERS notification — sees one machine identity rather than three. That is the accurate answer rather than a problem to work around, and it is now a single identity to create and configure rather than one per seat.

Authorship and the pushing identity are separate questions. Nothing here constrains who pushes: locally that is the operator's ambient credential, and in production it is the exe.dev integration's App identity, per [The local loop runs the production assembly (ADR 0046)](./0046-the-local-loop-runs-the-production-assembly.md). The exe.dev Git integration still must not be configured with `--act-as-user`, for the reason ADR 0032 gave — that flag makes pushes look conventional by attributing cowboy-written work to a human.
