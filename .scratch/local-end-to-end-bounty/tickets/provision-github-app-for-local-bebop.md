---
type: task
status: open
---

# Create bebop's GitHub App, install it, and protect the local target

## Question

Nothing about bebop's GitHub identity can be judged without an App that exists, an installation on a real
repository, and a ruleset that reads back as enforced.
[The local loop runs the production assembly (ADR 0046)](../../../docs/adr/0046-the-local-loop-runs-the-production-assembly.md)
settles that bebop uses a real App installation locally rather than a PAT, so that the credential-acquisition
path shipped to production is the one exercised on a laptop. This ticket exists to unblock the ones that follow,
not to decide anything.

The machine's own GitHub access needs no work here — it is the operator's ambient Git and `gh` credentials,
which is the shape exe.dev's repository-scoped integration provides.

Done when:

- a GitHub App exists for local bebop, with its private key and installation id stored where bebop's
  configuration will read them from — record _where_, since
  [The master runs on exe.dev (ADR 0019)](../../../docs/adr/0019-the-master-runs-on-exe-dev-with-mandatory-off-vm-backups.md)
  makes the same question a deployment concern later;
- it is installed on the repository the local loop will target, and that repository is one GitHub will protect:
  public, or on a plan that enforces rulesets on private repositories
  ([The merge target must enforce rulesets (ADR 0034)](../../../docs/adr/0034-the-merge-target-must-enforce-rulesets.md));
- a ruleset on the default branch is configured with `bypass_actors` empty, and a direct push to that branch is
  refused — including one from the operator, which is the intended behaviour and worth confirming by hand
  before it is discovered mid-bounty;
- the resulting facts — App id, installation id, key location, target repository, plan — are recorded in the
  answer.

Which permissions the App is granted is deliberately not settled here: start from the least that lets the
installation be created, and let
[What GitHub App permissions does bebop actually need?](./github-app-permissions-and-ruleset-readback.md)
establish the real set against the live installation.
