# Migrations are a static record, not a directory

Both bebop and Swordfish load migrations with `Migrator.fromRecord`, which keeps the schema inside the packed bundle. `Migrator.fromFileSystem` loads by dynamic import from a directory and does not survive `vp pack`; `fromGlob` is statically analysable and would also work, but a record needs no build-time glob step at all.

## Consequences

Adding a migration means editing the record, not dropping a file in a directory — the one step a contributor coming from a conventional migration tool will miss. `fromFileSystem` remains fine in tests, which never run packed.
