---
type: task
status: open
blocked-by: [operator-credential-retrieval-and-enforcement]
---

# What does the cockpit tell an operator to do once `sf takeover` demands a credential?

## Question

[The cockpit](../../../docs/capabilities/03-the-cockpit.md) promises that "while Swordfish controls the active
seat, the line says to run `sf takeover` from a shell." Once
[operator authentication is enforced](./operator-credential-retrieval-and-enforcement.md), that instruction
leads to a prompt the operator cannot satisfy from inside the VM: the credential comes from an authenticated
Bebop client, and by [The VM is the sandbox (ADR 0012)](../../../docs/adr/0012-the-vm-is-the-sandbox.md) no
Bebop API token lives in the VM. The primary UX path becomes a dead end at exactly the moment someone needs it —
they have SSHed in to take control of something that is going wrong.

Decide what the cockpit says instead. The options are not equivalent:

- **Name the retrieval command in the status line or the landing shell.** Cheapest. Costs status-line width,
  which capability 03 treats as scarce, and the retrieval command has to run somewhere that is not the VM — so
  the copy has to make that location explicit or it just moves the confusion.
- **Print it once on SSH landing** rather than continuously. The landing shell already prints a fresh
  `sf status` snapshot during deterministic stages, so there is an established place for one-time orientation.
- **Have `sf` say it on refusal.** The `unauthorized` error is the exact moment the operator needs to know, and
  it costs no persistent screen space. Requires the refusal message to carry actionable copy rather than a bare
  code.

These compose; the question is which combination is worth the space.

Related: the same dead end applies to any documentation or error text that tells an operator to run a mutating
`sf` command, not only the tmux status line.
