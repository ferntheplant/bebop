# What GitHub App permissions are actually needed, and how is the target branch protected?

Type: research
Status: open

## Question

The provisional answer is contents RW, pull_requests RW, checks and statuses read, metadata read, on an
identity separate from the exe.dev push App. The security model depends on the sandbox being unable to update
the protected merge target, which is a claim about GitHub's configuration, not about Bebop's code.

The provisional mitigations, none of them verified against a real repository:

- default, release, and other sensitive branches use GitHub rulesets;
- the exe.dev GitHub App cannot bypass those rules;
- merge targets require pull requests and required checks;
- bebop verifies the exact head SHA before merge, and only bebop merges;
- bounty branches use the recognisable `bounty/*` namespace;
- unexpected branch-head movement invalidates readiness.

Establish:

- the minimum permission set that supports branch creation, push, draft PR lifecycle, check polling, comments,
  and squash merge — and what each one grants beyond what is needed;
- how the VM's push credential is scoped, and whether it can be restricted to `bounty/*` refs; if it cannot,
  what branch protection has to do instead;
- what protected-branch configuration the target repository must carry for
  [Squash-only merges (ADR 0017)](../../../docs/adr/0017-squash-only-merges.md) to hold, and whether that can
  be verified by bebop rather than assumed;
- how check polling behaves against rate limits at the fleet sizes this is meant to reach;
- what the App sees on a repository it has not been installed on, so the failure is a clear refusal rather than
  a confusing one.
