---
type: grilling
status: open
blocked-by: [exe-dev-http-proxy-for-opencode-go]
---

# What proves QA ran against the candidate, in a clean environment?

Resolving this updates [QA](../../../docs/capabilities/10-qa.md).

## Question

faye is supposed to verify acceptance criteria against the exact candidate SHA in a clean environment, with
Swordfish-provisioned previews only and SHA, ports, and PIDs in the manifest
([QA](../../../docs/capabilities/10-qa.md), provisional). Playwright in-image via the Playwright MCP is the provisional browser stack.

Settle:

- what makes a QA result _evidence_ rather than an assertion — the manifest fields are a proposal, not a proof;
- how a preview is provisioned and reached, and whether faye can be prevented from reaching ein's dev server by
  mistake, which would silently QA the wrong thing;
- whether Playwright MCP survives contact with a real app, and what the fallback is if the browser stack cannot
  see what a human would see;
- what a QA scenario looks like when the acceptance criterion is not visual;
- how faye reports "I could not run this" distinctly from "this failed" — the same distinction [finding severities](./finding-severities-and-where-they-surface.md) needs
  for jet.
