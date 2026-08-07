# A local Swordfish outlives the worker that started it

The local lifecycle provider starts each bounty's Swordfish daemon as a **detached** process under a
bounty-scoped root, records it, and leaves it running. A provision that finds a live recorded daemon
reattaches — it returns the same VM record and touches nothing. Only `destroy` stops one, by signalling and then
escalating to a kill. A record whose machine is gone is stale and gets replaced.

What is recorded is a **machine record** — the `vmId`, the pid, and the kernel's start time for that process —
and not a pid alone. A pid alone is a slot the operating system reuses, so after a crash it can name a process
that has nothing to do with the bounty: a provision would adopt a stranger as the bounty's machine and a destroy
would signal and then kill it. The start time is what makes the record an identity, and it is the local shape of
what exe.dev gives us for free — there a `vmId` names the machine and `describe` asks the API whether it is
still that machine, here the record names it and the operating system answers the same question. Corroborating
over the control socket instead, by having the daemon assert its own `vmId`, would additionally catch a daemon
that is alive but wedged; it was rejected for now because it would make bebop speak Swordfish's control protocol,
which it does not, for a failure that has not happened.

The alternative is an ordinary child that dies with the worker, which is far simpler and has no orphans. It was
rejected because it makes local behaviour diverge from production in the one place the divergence matters:
[Bebop owns authority, Swordfish owns the loop (ADR 0002)](./0002-bebop-owns-authority-swordfish-owns-the-loop.md)
says the loop keeps running while bebop is unreachable, and a VM does not reboot because bebop restarted. A
daemon tied to the worker's lifetime cannot be disconnected from bebop and still working, so the reconnect
backoff and the disconnected state `sf status` reports would be unreachable locally — the states would exist in
the code and never occur on the developer's machine, which is the shape of divergence
[The local loop runs the production assembly (ADR 0046)](./0046-the-local-loop-runs-the-production-assembly.md)
exists to prevent. Replacing a running daemon on every provision was rejected for the same reason: a worker
restart would cut every bounty's loop.

## Consequences

The machine credential is no longer written to disk. It goes from derivation into the environment of the process
the provider starts, which is the injection
[Swordfish tokens are bounty-scoped, minted at provisioning, and never rotate (ADR 0014)](./0014-bounty-scoped-swordfish-tokens-minted-at-provisioning.md)
describes, so the one-shot bootstrap artifact that previously carried it is gone. Nothing outside bebop can
start a bounty's daemon, including its own test harness: `test/local-system/` creates bounties and asserts on
the daemons the provider starts, and restarts one by requeuing provisioning through `POST
/api/bounties/:id/recover` rather than by spawning anything.

An undestroyed bounty keeps running after every bebop process has exited. That is the point, and it is also the
cost: orphans are possible, so the machine record and the bounty root are the operator's handle on them, and a
stop that a daemon ignores is escalated rather than waited on forever.

The machine also inherits the operator's ambient `git` and `gh` credentials, by name rather than wholesale. An
allowlist is what keeps that from becoming a second credential path: passing everything except bebop's own
variables would hand Swordfish `BEBOP_DATABASE_URL` and `BEBOP_SWORDFISH_CREDENTIAL_KEY` as soon as someone
added a variable the deny-list had not heard of, and Swordfish reaching bebop's state anywhere but through the
wire protocol is precisely the seam
[The local loop runs the production assembly (ADR 0046)](./0046-the-local-loop-runs-the-production-assembly.md)
says local mode cannot enforce and must not violate.

Because provisioning is the only way a machine comes to exist, provisioning is also what clones the working
copy — a fresh clone in a bounty-scoped root, never the operator's checkout, which
[Verification runs in a clean-room worktree (ADR 0015)](./0015-verification-runs-in-a-clean-room-worktree.md)
and the clean-tree precondition both depend on. The clone origin is a configurable base so a suite can clone
from a bare repository on disk and stay offline; an operator's default is GitHub over their ambient credentials.
