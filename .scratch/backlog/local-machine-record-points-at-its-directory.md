# The local machine record should say where the machine actually is

The fake lifecycle provider returns SSH at `127.0.0.1:2222` and a preview host of `preview.bebop.invalid`. The
preview host is honest — `.invalid` never resolves — but the SSH endpoint is a plausible-looking address with
nothing listening, and `bounty status` prints it as though attaching were possible.

Accepted as-is for now: locally the operator knows it is nonsense. The developer-experience improvement is to
drop the SSH attachment for a local machine and name the machine root instead — the directory holding the
working copy and artifacts — since that is what someone debugging a local bounty actually needs from
`bounty status`.

Doing it means making the SSH attachment optional in the contract and handling its absence in every consumer,
which is the kind of thing better discovered before a real provider is wired than during.
