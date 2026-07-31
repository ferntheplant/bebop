# What proves QA ran against the candidate, in a clean environment?

Type: grilling
Status: open
Blocked by: 02

## Question

faye is supposed to verify acceptance criteria against the exact candidate SHA in a clean environment, with
Swordfish-provisioned previews only and SHA, ports, and PIDs in the manifest (`docs/design/SYSTEM.md` §12.7,
provisional). Playwright in-image via the Playwright MCP is the provisional browser stack.

Settle:

- what makes a QA result _evidence_ rather than an assertion — the manifest fields are a proposal, not a proof;
- how a preview is provisioned and reached, and whether faye can be prevented from reaching ein's dev server by
  mistake, which would silently QA the wrong thing;
- whether Playwright MCP survives contact with a real app, and what the fallback is if the browser stack cannot
  see what a human would see;
- what a QA scenario looks like when the acceptance criterion is not visual;
- how faye reports "I could not run this" distinctly from "this failed" — the same distinction ticket 10 needs
  for jet.
