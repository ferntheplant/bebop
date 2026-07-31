# The master runs on exe.dev, with deployment-neutral seams and mandatory off-VM backups

Bebop runs on a dedicated exe.dev VM for MVP convenience — private ingress and integrations come built in — but assumes no locality with the bounties it provisions. It talks to exe.dev over the public provisioning API, accepts outbound Swordfish connections, stores evidence through the blob interface, and authorizes against Postgres rather than exe.dev-local identity. Nightly encrypted restic snapshots of `pg_dump` plus artifacts go to off-VM S3-compatible storage, with failure alerts and monthly restore tests.

Convenience today must not become lock-in tomorrow, and a single VM holding the only copy of every bounty's history is one bad afternoon away from losing all of it.

## Consequences

Move the master to a traditional provider when webhook ingestion, managed Postgres or object storage, host availability, independent capacity, or a reduced exe.dev blast radius becomes worth more than built-in private ingress.
