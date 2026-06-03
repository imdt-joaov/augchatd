---
id: adr-0012-out-of-process-tls
type: adr
status: proposed
evidence:
  - source: docker/nginx/nginx.conf.template
    section: "two-server-block proxy (443 browser, 8443 mTLS)"
  - source: src/mtls-trust.ts
    section: "requireMtlsTrust middleware"
  - source: src/identity.ts
    section: "requireIdentity middleware"
links:
  - relation: supports
    target: constraint-security
  - relation: supports
    target: contract-session-create
---

# ADR-0012 — TLS is terminated out-of-process

## Context

Constraint [security](../../constraints/security.md) and contract [session-create](../../behavior/contracts/session-create.md) require the control-plane endpoints (`POST /sessions`, `DELETE /sessions/:id`) to be authenticated by **mTLS**: the client (the integrator's backend) proves identity with a certificate signed by a CA the augchatd deployment trusts.

The runtime we picked in [adr-0007-bun-hono-typescript](0007-bun-hono-typescript.md) is **Bun**. Bun's `Bun.serve` supports `tls: { requestCert, rejectUnauthorized, ca, ... }` at listen time, but Bun **does not expose the peer's certificate to the request handler** at the time of this ADR (see upstream issues oven-sh/bun#12822 and oven-sh/bun#16254). Without per-request access to the cert's Subject DN, augchatd cannot map an incoming session-create call to `{ tenantId, userId }`.

## Decision

augchatd does not terminate TLS. A reverse proxy (the deployment's choice; we ship a sample for **nginx**) sits in front of augchatd and performs the mTLS handshake. After validating the client certificate against its CA bundle, the proxy forwards two headers to augchatd over a private back-channel (loopback, unix socket, or a tightly-firewalled internal network):

```
X-Client-Cert-Verify:  SUCCESS
X-Client-Cert-Subject: CN=alice,OU=engineering,O=acme
```

augchatd consumes these via two middlewares — [`requireMtlsTrust`](../../../../src/mtls-trust.ts) (gates on `Verify == "SUCCESS"`, parses the Subject DN) and [`requireIdentity`](../../../../src/identity.ts) (maps `O` → `tenantId`, `CN` → `userId`, validates the alphabet).

The middlewares are only mounted when **`TRUSTED_PROXY=true`** is set on the augchatd process. This env flag is the operator's explicit declaration that augchatd is reachable only through the proxy — without it, the headers carry no proof and the chain is fail-closed (the routes 404).

## Consequences

**+** Sidesteps the Bun limitation immediately. No patch, no FFI, no socket sniffing.

**+** The boundary is explicit and inspectable: the nginx config is the single, reviewable place where mTLS happens. Operators already deploy nginx in front of services and know how to harden it.

**+** Identity extraction (subject DN parsing) is a small, library-style module that we can test in isolation.

**+** Browser-facing TLS (the `/chat`, `/conversations/*` routes that take a JWT) lands on the same proxy with a regular TLS leg — no separate ingress story.

**−** The operator must deploy and harden the reverse proxy. We accept this; mTLS deployments are operationally complex regardless of where TLS lives.

**−** Header forgery is a single misconfig away (anything that can reach augchatd's port can claim `SUCCESS`). The `TRUSTED_PROXY=true` flag is a declarative guard, not a verification. Operators MUST bind augchatd to loopback / unix socket / private network, never expose port 8080 to the public internet.

**−** This ADR commits us to *any* mTLS-terminating proxy that can forward two headers — we picked nginx for the sample, but Caddy / Envoy / Traefik all work. Tracking the "Bun gains per-request peer-cert access" upstream issue lets us reconsider in-process termination later without rewriting the identity layer.

## Alternatives considered

1. **In-process termination via `Bun.serve` + FFI to read peer cert.** Rejected: fragile, no stable Bun API for this, and a Bun upgrade could break the daemon silently.

2. **Patch Bun.** Out of scope for this project.

3. **Switch runtime to Node + the built-in `https` module** (which exposes `request.socket.getPeerCertificate()`). Rejected: would invalidate [adr-0007-bun-hono-typescript](0007-bun-hono-typescript.md) and the bundled-UI single-binary story (Bun's embedding of static assets is part of the value proposition).

## When this decision could change

When Bun exposes the peer certificate to the request handler with a stable API, we may move TLS termination back in-process and delete the reverse-proxy requirement. The identity-extraction middleware would survive — the source of `mtlsSubject` would just change from a header to a Bun API.
