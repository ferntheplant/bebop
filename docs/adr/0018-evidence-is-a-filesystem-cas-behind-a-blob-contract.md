# Evidence is a filesystem CAS behind a backend-neutral blob contract

Evidence blobs are stored as raw SHA-256 content-addressed files on the master's persistent volume, behind a blob
interface that names no backend. A single-node MinIO was rejected: it adds an S3 API, a process, and an
operational surface to get object storage semantics that one machine cannot actually provide.

## Consequences

The interface is what keeps this reversible — moving to real object storage later is an adapter, not a migration
of every caller.

Uploads publish blobs durably **before** committing the manifest and its references, so a manifest never points
at content that is not there. `bundleId` is the durable idempotency key: offer the manifest, upload only the
missing blobs, then finalize.
