# Commits are authored by the acting seat, never by the user

> Superseded by [Commits carry one machine identity (ADR 0047)](./0047-commits-carry-one-machine-identity.md).

Commits carry the acting seat as author (`ein (bebop)`) and are pushed by the exe.dev App. The user's Git
identity is never used, including on a bounty the user steered heavily through takeover.

Provenance has to stay honest: a human who never wrote the code should not appear in `git blame` as though they
did. The alternative — attributing to the operator so history looks conventional — makes every future
archaeology of agent-written code lie about who to ask.

## Consequences

Tooling that assumes a human author (review assignment, `git shortlog` headcounts, CODEOWNERS notification) sees
a machine identity, which is the accurate answer rather than a problem to work around.
