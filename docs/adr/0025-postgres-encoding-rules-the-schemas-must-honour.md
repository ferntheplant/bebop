# Postgres encoding rules the schemas must honour

Three encoding behaviours found by the [persistence prototype](../../prototypes/persistence/README.md) are designed around rather than worked around at each call site. They look like defects in our code and are not.

- **`sql.json` mis-encodes a JavaScript array.** The driver writes it as a Postgres array literal, which Postgres rejects for a `jsonb` column with `invalid input syntax for type json`. Objects survive, which is what makes it easy to ship — `primary_context` and the preview list are arrays and nothing else would have noticed. Every `jsonb` write therefore goes through `jsonbParameter` with an explicit `::jsonb` cast.
- **`jsonb` does not preserve key order.** An event fingerprint recomputed from a payload read back out of `jsonb` would differ from the one computed when it arrived, so every replay would look like a conflict. Fingerprints are computed once when the message is decoded and stored in their own column, never recomputed on read.
- **`bigint` decodes as a JavaScript string.** Values are exact, but any schema reading a sequence number, cursor, or acknowledgement offset must accept the string encoding rather than `Schema.Number`.

## Consequences

Each of these fails in production data rather than in a type check, and each has an obvious-looking simplification that reintroduces it.
