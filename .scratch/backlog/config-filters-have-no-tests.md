# Bebop's cross-field config filters have no tests

`BebopConfigSchema` carries two `Schema.makeFilter` checks that reject a configuration at startup, and neither
is covered in `apps/bebop/test/component/config.test.ts`:

- the stale timeout must exceed the heartbeat interval;
- local machine mode is all-or-nothing — a `localHarnessRoot` without a `localSwordfishEntrypoint` is refused,
  because a root without an entrypoint would start no daemon and say nothing about why.

The second one now carries more weight than when it was written: the reconnect bounds the local provider hands
the daemon are derived from those same two durations, so the first filter is also what guarantees the minimum
delay stays under the maximum. That relationship is load-bearing and asserted nowhere.

A repro is cheap — decode a config with each filter's precondition broken and assert the message names the
missing or offending key, which is the whole point of refusing at startup rather than later.

Noticed while reviewing the change that made the local provider start the daemon.
