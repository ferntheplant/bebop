---
type: grilling
status: open
---

# What proves QA ran against the candidate, in a clean environment?

Resolving this updates [QA](../../../docs/capabilities/10-qa.md).

## Question

faye is supposed to verify acceptance criteria against the exact candidate SHA in a clean environment, with
Swordfish-provisioned previews only and SHA, ports, and PIDs in the manifest
([QA](../../../docs/capabilities/10-qa.md), provisional). Playwright in-image via the Playwright MCP was the
provisional browser stack, chosen when there was an image; on a laptop that assumption needs rechecking.

**Unblocked by the move to local-first.** This ticket previously waited on the exe.dev HTTP Proxy, because that
was how faye's model was going to arrive. Locally faye uses the operator's own credential, so what proves a QA
result is evidence no longer depends on how the model is served.

Settle:

- what makes a QA result _evidence_ rather than an assertion — the manifest fields are a proposal, not a proof;
- how a preview is provisioned and reached, and whether faye can be prevented from reaching ein's dev server by
  mistake, which would silently QA the wrong thing;
- whether Playwright MCP survives contact with a real app, and what the fallback is if the browser stack cannot
  see what a human would see;
- what a QA scenario looks like when the acceptance criterion is not visual;
- how faye reports "I could not run this" distinctly from "this failed" — an attempt that collapsed and a
  scenario that genuinely failed are different values under
  [Cowboys accept or reject, and a rejection carries notes (ADR 0050)](../../../docs/adr/0050-cowboys-accept-or-reject-and-a-rejection-carries-notes.md),
  and faye needs a way to say the first one about a single scenario rather than the whole attempt.
