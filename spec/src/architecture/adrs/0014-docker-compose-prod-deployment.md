---
id: adr-0014-docker-compose-prod-deployment
type: adr
status: proposed
evidence:
  - source: Dockerfile
    section: "multi-stage Bun build (ui-builder + deps + runtime)"
  - source: docker-compose.yml
    section: "augchatd + nginx + cert-init services"
  - source: docker/nginx/Dockerfile
    section: "nginx image with cert-required entrypoint"
  - source: docker/nginx/nginx.conf.template
    section: "two-server-block proxy: 443 browser TLS + 8443 mTLS"
  - source: docker/cert-init/gen-certs.sh
    section: "idempotent self-signed cert bundle"
links:
  - relation: supports
    target: adr-0012-out-of-process-tls
  - relation: supports
    target: constraint-security
---

# ADR-0014 — Production deployment is a docker-compose stack

## Context

Before this ADR, the only documented production path was a sample nginx config plus a yet-to-be-published `augchatd/augchatd` image referenced from `README.md`. That left every operator reassembling four moving pieces by hand: nginx config rendered with the right `server_name`, a server cert + private key, a clients-CA for the mTLS leg, and a JWT secret. The most common foot-guns — accidentally exposing `:8080` to the public, starting nginx without certs, booting augchatd without `TRUSTED_PROXY` — were enforced only by documentation.

[ADR-0012](0012-out-of-process-tls.md) is the constraint this ADR builds on: augchatd cannot terminate TLS itself, so any deploy must couple augchatd with a TLS-terminating proxy and never expose augchatd's HTTP port. The compose-level wiring is the smallest mechanism that turns those words into a repeatable boot.

## Decision

augchatd ships a `docker-compose.yml` at the repo root with three services:

1. **`augchatd`** — built from a multi-stage Bun `Dockerfile` (UI build + runtime). Runs in mode `prod` with `TRUSTED_PROXY=true`. **No ports are published** to the host; the only reachable network endpoint is via the `augchatd_net` bridge, where nginx terminates TLS in front of it. `AUGCHATD_JWT_SECRET` is required from the environment (and validated by [`src/env.ts`](../../../../src/env.ts) as ≥ 32 chars + not a known placeholder).

2. **`nginx`** — built from `docker/nginx/`. Two-server-block shape: 443 terminates browser TLS and forwards to augchatd with the mTLS headers stripped; 8443 terminates mTLS and forwards `X-Client-Cert-Verify` + `X-Client-Cert-Subject` to `/sessions` only. `server_name` parameterized by `AUGCHATD_DOMAIN` (rendered by the official image's `envsubst` template support); `proxy_pass` targets the docker service `augchatd:8080`; a `resolver 127.0.0.11` directive plus an upstream held in a `$augchatd_upstream` variable defers DNS for `augchatd` to *request* time rather than nginx boot. The variable indirection is load-bearing: because `depends_on: condition: service_healthy` blocks augchatd's startup until nginx is healthy, augchatd's hostname does not yet exist in docker's embedded DNS when nginx parses its config. A literal `proxy_pass http://augchatd:8080` deadlocks at boot ("host not found in upstream"). Mounts `./docker/certs` read-only at `/etc/ssl/augchatd`. The image's `00-require-certs.sh` entrypoint hook aborts with a non-zero exit if any of `server.crt`, `server.key`, `clients-ca.crt` is missing or empty.

3. **`cert-init`** — built from `docker/cert-init/` (`alpine:3.20` + `openssl` + `gen-certs.sh`). Gated by `profiles: ["tools"]` so it never auto-starts with `docker compose up`. Invocation:

       docker compose run --rm cert-init <domain> [--force]

   Writes the full self-signed bundle (CA, server cert with SAN for `<domain>` + `localhost` + `127.0.0.1`, clients-CA, sample client cert with `/O=demo/CN=tester`) into the same `./docker/certs` directory the nginx service mounts. Idempotent per artifact: each file is regenerated only when missing, expiring within 30 days, or — for the server cert — when its SAN does not include the requested domain. `--force` regenerates everything.

The dependency chain is encoded once in compose:

```yaml
depends_on:
  nginx:
    condition: service_healthy
```

This single line satisfies two of the user-facing requirements together: nginx is healthy iff its process is running with a valid config (`nginx -t && pidof nginx`), which is only possible if the cert files were present at boot. Hence "proxy starts only if a cert is available" and "augchatd starts only if the proxy starts successfully" reduce to one mechanism.

This ADR is **prod-only**: the compose stack does not boot `AUGCHATD_MODE=demo`, does not mount `local/demo_session.json`, and does not expose `/demo/*`. Demo via Docker continues to work via the standalone `docker run` documented in `README.md`. Publishing the augchatd image to a registry is **out of scope** for this iteration.

## Consequences

**+** Zero host-side dependencies. No `openssl` on the operator's machine; the cert-init service brings its own. No nginx install; no per-OS config-path negotiation.

**+** The TLS termination boundary stays exactly where [ADR-0012](0012-out-of-process-tls.md) put it. nginx alone holds the server key; augchatd cannot reach the public network even by accident — the compose file does not list a `ports:` block on it.

**+** The dependency chain is declarative and reviewable in `docker-compose.yml`. There is no shell script wrapping `docker run` calls that has to reimplement healthcheck polling.

**−** Operators who want Let's Encrypt (real, browser-trusted certs) cannot use `cert-init` as-is. They have to either extend it with an ACME mode or replace it with `certbot` orchestration. We accept this — Let's Encrypt requires port 80 reachability and a real DNS record, which is deployment-specific and would muddy this iteration.

**−** The nginx healthcheck verifies the nginx process, not that augchatd is reachable through it. We chose this deliberately: a "GET /healthz through TLS" healthcheck would create a circular dependency (nginx healthy ⇒ augchatd up ⇒ … which depends on nginx healthy). The cost is that a misrouted upstream is invisible to compose's startup gate; operators verify end-to-end with `curl -k https://localhost/healthz` after `up` completes.

**−** The compose stack is one more surface to keep in sync with the spec. When `src/env.ts` gains a new required env var, `docker-compose.yml` must learn about it; when `src/mtls-trust.ts` changes the header contract, `nginx.conf.template` must mirror it. The existing `/code-changed` routine in `CLAUDE.md` is the mechanism for that.

## Alternatives considered

1. **Two raw `Dockerfile`s plus a shell wrapper** (no compose). Rejected: the dependency chain (nginx healthy → augchatd starts) would have to be reimplemented with sleep+poll loops, and the "only this network can reach 8080" guarantee would devolve into an `--network` flag operators could forget.

2. **Let's Encrypt as the default cert mechanism.** Rejected for this iteration: requires a publicly resolvable DNS record and port 80 reachable from the ACME server, which is fundamentally a deployment-environment decision. Pinning the default to self-signed keeps the bring-up offline; an `--letsencrypt` mode on the same `cert-init` script is a clean future extension.

3. **A bind-mounted `gen-certs.sh` script run directly on the host.** Rejected per the user's explicit ask: the script should run as an ephemeral compose service so the host doesn't need `openssl` installed.

4. **Compose stack also boots demo mode.** Rejected per the user's explicit ask. Demo's `local/demo_session.json` mount and `AUGCHATD_MODE=demo` env are different enough from prod that mixing them via env-overrides would muddy the "compose is the prod path" contract.

## When this decision could change

- When [ADR-0012](0012-out-of-process-tls.md) is itself revisited (Bun gains per-request peer-cert access), the nginx service may become optional, and the compose stack would collapse to a single service. The `cert-init` mechanism still makes sense as a self-signed-bundle generator until Let's Encrypt becomes the default.
- When an official `augchatd/augchatd` image is published, the `build:` stanzas would migrate to `image:` pulls and the multi-stage Dockerfile would still drive the CI build.
