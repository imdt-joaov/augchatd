---
id: adr-0015-letsencrypt-http01-standalone
type: adr
status: proposed
evidence:
  - source: docker/letsencrypt-init/Dockerfile
    section: "alpine + certbot image"
  - source: docker/letsencrypt-init/letsencrypt.sh
    section: "issue / renew subcommands; LE PROD only"
  - source: docker-compose.yml
    section: "letsencrypt-init service (profiles: tools); augchatd_letsencrypt named volume"
  - source: scripts/deploy.sh
    section: "--letsencrypt flag; systemd timer install"
links:
  - relation: supports
    target: adr-0014-docker-compose-prod-deployment
  - relation: supports
    target: constraint-security
---

# ADR-0015 — Let's Encrypt server cert via HTTP-01 standalone

## Context

After [ADR-0014](0014-docker-compose-prod-deployment.md), the only path to a server cert was the self-signed bundle produced by `docker/cert-init/gen-certs.sh`. That bundle is fine for local boot and for the **clients-CA** that gates the mTLS leg on port 8443 — but for the browser-facing leg on port 443 it forces every visitor through a "not trusted" warning and every operator through `curl -k`.

Let's Encrypt issues real, browser-trusted certs via the ACME protocol. Two challenge types fit this stack:

- **HTTP-01**: the ACME server hits `http://<domain>/.well-known/acme-challenge/...` over port 80. Two sub-flavors: **webroot** (challenge files served by an already-running web server) or **standalone** (certbot binds port 80 itself for the validation window).
- **DNS-01**: the ACME server checks a `_acme-challenge.<domain>` TXT record. Required for wildcards; not needed for a single FQDN.

The deploy script already opens port 80 in UFW, and the compose nginx never publishes 80 to the host. So nothing else is competing for the port — standalone mode is unblocked.

## Decision

A new compose service, **`letsencrypt-init`**, sits alongside the existing `cert-init` and **overwrites only `server.{crt,key}`** in `docker/certs/`. Everything else `cert-init` produces (`ca.crt`, `clients-ca.crt`, `client-sample.{crt,key}`) is untouched — LE does not issue CAs for verifying mTLS clients, so the port-8443 trust root stays local.

Concrete shape:

- **Image**: `alpine:3.20` + `apk add certbot`. No DNS plugin (we use HTTP-01).
- **Mode**: `certbot certonly --standalone`. Webroot was rejected: it would require an extra port-80 server block in nginx purely for the validation window plus an unrelated HTTP→HTTPS redirect, and a shared bind-mount the operator now has to remember. Standalone keeps the change isolated to a single new service.
- **Endpoint**: **Let's Encrypt PRODUCTION only**. No `--staging` mode and no flag to switch. The single code path is easier to reason about; staging certs would land in the same on-disk paths as prod ones, and an accidental left-over staging cert would silently serve a "Fake LE Intermediate" issuer to real browsers. The downside (rate-limit risk during operator mistakes) is mitigated by the `issue` subcommand's idempotency check: it skips the ACME call entirely when the current `server.crt` is already a Let's Encrypt cert for the requested domain with > 30 days left.
- **Service posture**: `profiles: ["tools"]` so it never auto-starts with `docker compose up`. The compose declares `ports: ["80:80"]`, but `docker compose run` only publishes those ports when called with `--service-ports` — preventing an accidental `up` from holding port 80.
- **Persistence**: `/etc/letsencrypt` lives in a named volume `augchatd_letsencrypt`. The ACME account key and the `renewal/augchatd.conf` config persist between runs and reinstalls of the working tree.
- **Renewal**: a systemd `oneshot` service + weekly `timer` on the host, installed by `scripts/deploy.sh` when `--letsencrypt <email>` is passed. The service runs `docker compose run --rm --service-ports letsencrypt-init renew` and then `nginx -s reload`. `Persistent=true` on the timer covers the case where the VPS was off during the scheduled window. No webhook/email notification — operators read `journalctl -u augchatd-letsencrypt-renew.service`.

The nginx config is **not** modified. nginx still listens only on 443 and 8443; there is no port-80 server block and **no HTTP→HTTPS redirect**. `http://<domain>` returns connection refused. Acceptable because the augchatd browser leg is loaded by integrators as an iframe with a hardcoded `https://` URL, and the mTLS leg is server-to-server — no organic browser traffic types `http://` for augchatd.

If `letsencrypt-init issue` fails (DNS not pointed yet, port 80 blocked by something else, rate-limit hit), the stack is **not** left broken: `cert-init` has already laid down a working self-signed `server.{crt,key}`, so nginx serves that until the operator fixes the issue and reruns the deploy script.

## Consequences

**+** Real, browser-trusted cert with no extra moving parts: no DNS plugin, no extra port-80 server block in nginx, no shared bind-mount across services.

**+** Concerns stay separated. `cert-init` keeps producing the immutable local bundle (CA + clients-CA + sample client + fallback server); `letsencrypt-init` is an optional outer layer that only touches `server.{crt,key}`. A user who never opts in pays nothing.

**+** A failed ACME exchange does not take the stack down. The self-signed fallback is still on disk; nginx keeps serving.

**+** The two service identities (cert-init vs letsencrypt-init) make the on-disk state predictable: an operator looking at `docker/certs/server.crt`'s issuer immediately knows which path produced it.

**−** Nothing answers on `http://<domain>` — clients must use `https://`. We accept this; see Context.

**−** Port 80 must be reachable from the public internet during issuance and renewals. A firewall change or an unrelated process holding port 80 breaks renewal. Surface area is small (renewal hits port 80 for seconds, weekly) but the failure mode exists.

**−** Issuance hits the LE PROD endpoint directly. A bad operator-side test can consume the per-domain rate limit (50 certs/week). Mitigation: the `issue` subcommand is idempotent — reruns with a still-valid LE cert are no-ops; only `--force` skips that check. A staging mode would also mitigate but was deliberately excluded (single code path).

**−** Renewal is wired through systemd on the host, not docker — so the deploy script gains a host-side mutation it must keep idempotent. The implementation uses `cmp` to avoid `daemon-reload` when the unit content has not changed.

## Alternatives considered

1. **Webroot HTTP-01** — rejected. Requires a port-80 server block in nginx with a `/.well-known/acme-challenge/` location and a shared bind-mount between certbot and nginx. More files to keep in sync; effectively forces a redundant HTTP→HTTPS redirect.

2. **DNS-01** — rejected. Needs a per-provider certbot plugin (`python3-certbot-dns-cloudflare` etc.) plus stored API credentials. Useful only if wildcards are required, which this stack does not.

3. **Caddy or Traefik with built-in ACME** — rejected. Replacing nginx invalidates the proxy design from ADR-0014 (two distinct server blocks, the `requireMtlsTrust` header contract, the `00-require-certs.sh` entrypoint). The boundary that ADR-0014 protects is exactly the one this ADR builds on.

4. **Stay on self-signed forever** — rejected. UX cost in production is unacceptable (browser warnings, mandatory `-k` in tooling, third-party HTTP clients that won't trust an unknown CA at all).

5. **Optional staging mode** — rejected (operator's explicit ask). The single code path is easier to reason about; a staging cert sitting in the same paths as prod is a foot-gun.

6. **A separate `cert-init --letsencrypt` flag instead of a new service** — rejected. The runtime profile (alpine + openssl vs alpine + certbot + persistent ACME state) is different enough that bundling them grows `cert-init`'s image and conceptual scope.

## When this decision could change

- If wildcard certs become a requirement (sub-tenants on `<x>.augchatd.example.com`), a sibling DNS-01 service makes more sense than retrofitting the standalone one.
- If LE rate-limits become a recurring problem during operator iteration, an opt-in `--staging` path could be added — but only with a hard refusal to overwrite a current prod cert in `server.crt`, to keep the "what's on disk reflects what's in browsers" invariant.
- If the augchatd image ever bundles its own ACME client (e.g. as an embedded `cert-magic`-style library), this whole service folds back into the daemon — but only after [ADR-0012](0012-out-of-process-tls.md) is reconsidered.
