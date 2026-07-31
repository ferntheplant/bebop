# What is the `sf` command surface, in use?

Type: prototype
Status: open

## Question

`sf status/takeover/handback/extend/retry/approve-config/stop` exists and works, but the set was adopted as a
provisional default (`docs/design/SYSTEM.md` §16.3) and has never been used by a human steering a real bounty.

Build the cheapest possible thing to react to — a scripted transcript of a session at the cockpit, or `sf`
against a fabricated status — and settle:

- what `sf status` shows, and whether one screen can carry stage, lease, constraints, gates, and the candidate
  without becoming a wall;
- whether `extend` and `retry` are the right verbs for "give it another life" and "run that stage again", and
  whether a human under pressure would confuse them;
- what a human needs at the moment a bounty enters `needs_attention` — the current answer requires reading a
  status pane and then choosing a command, which may be one step too many;
- whether anything in the set should be a bebop-side command instead, given that `approve-config` already
  exists on both sides;
- what is missing. A command that would obviously be reached for and does not exist is the finding worth
  having.
