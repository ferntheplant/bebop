# Swordfish tokens are bounty-scoped, minted at provisioning, and never rotate

Each bounty gets one token, presented at the WebSocket upgrade and valid for the life of the bounty. It is minted when the VM is provisioned rather than when the bounty is created — a bounty with no computer has nothing to authenticate — and bebop stores only its hash, handing the plaintext to the lifecycle provider that puts it on the VM.

Rotation and wall-clock expiry were considered and struck. Expiry would lock out a Swordfish whose connection outlived its token, exactly when a bounty is long-running and least recoverable; rotation needs a re-issue path the threat model does not justify for a credential already scoped to one disposable VM.

## Consequences

The token is derived by HMAC from a deployment key rather than generated randomly, because a random in-memory token can be lost after the provider succeeds but before its hash commits — leaving an idempotently returned VM holding a credential bebop no longer recognises. Derivation keeps plaintext out of Postgres while making provisioning retries stable, at the cost of a deployment key that cannot rotate while bounties are live.
