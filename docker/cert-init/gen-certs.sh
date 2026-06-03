#!/bin/sh
# gen-certs.sh — idempotent self-signed cert bundle for augchatd's nginx.
#
# Usage:  gen-certs.sh <domain> [--force]
#
# Writes the following into /out (bind-mounted from ./docker/certs/):
#   ca.crt, ca.key                — local CA (10y). Reused as clients-CA.
#   server.crt, server.key        — nginx server cert for <domain>.
#                                   SAN: DNS:<domain>, DNS:localhost, IP:127.0.0.1.
#   clients-ca.crt                — copy of ca.crt; nginx uses it for
#                                   ssl_client_certificate on the mTLS leg.
#   client-sample.crt, .key       — test client; Subject /O=demo/CN=tester
#                                   (parsed by src/mtls-trust.ts, mapped by
#                                   src/identity.ts → tenantId=demo, userId=tester).
#
# Idempotency: a per-artifact check skips regeneration unless the file
# is missing, expires in < 30 days, or (for server.crt) its SAN does not
# include the requested <domain>. `--force` regenerates everything.

set -eu
umask 077

usage() {
    echo "Usage: gen-certs.sh <domain> [--force]" >&2
    exit 64
}

[ $# -ge 1 ] || usage
DOMAIN="$1"
shift
FORCE=0
if [ $# -gt 0 ]; then
    case "$1" in
      --force) FORCE=1; shift ;;
      *) usage ;;
    esac
fi
[ $# -eq 0 ] || usage

OUT=/out
cd "$OUT"

note() { echo "cert-init: $*"; }

valid_30d() { openssl x509 -in "$1" -noout -checkend 2592000 >/dev/null 2>&1; }

server_san_ok() {
    openssl x509 -in server.crt -noout -ext subjectAltName 2>/dev/null \
        | grep -q "DNS:$DOMAIN"
}

# 1. CA — generate only when missing or --force.
if [ "$FORCE" = "1" ] || [ ! -s ca.key ] || [ ! -s ca.crt ]; then
    note "generating local CA"
    openssl req -x509 -newkey rsa:4096 -nodes \
        -keyout ca.key -out ca.crt \
        -days 3650 \
        -subj "/CN=augchatd-local-CA/O=augchatd-local" \
        >/dev/null 2>&1
else
    note "ok: ca.crt + ca.key present"
fi

# 2. clients-ca.crt — straight copy of the CA.
if [ "$FORCE" = "1" ] || [ ! -s clients-ca.crt ]; then
    note "writing clients-ca.crt"
    cp ca.crt clients-ca.crt
else
    note "ok: clients-ca.crt present"
fi

# 3. Server cert — regen on missing, near-expiry, SAN mismatch, or --force.
need_server=0
if [ "$FORCE" = "1" ]; then need_server=1; fi
if [ ! -s server.crt ] || [ ! -s server.key ]; then need_server=1; fi
if [ "$need_server" = "0" ] && ! valid_30d server.crt; then
    note "server.crt expires within 30 days — regenerating"
    need_server=1
fi
if [ "$need_server" = "0" ] && ! server_san_ok; then
    note "server.crt SAN does not include DNS:$DOMAIN — regenerating"
    need_server=1
fi

if [ "$need_server" = "1" ]; then
    note "generating server cert for $DOMAIN"
    openssl req -new -newkey rsa:2048 -nodes \
        -keyout server.key -out server.csr \
        -subj "/CN=$DOMAIN/O=augchatd-local" \
        >/dev/null 2>&1

    cat >server.ext <<EOF
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:$DOMAIN, DNS:localhost, IP:127.0.0.1
EOF

    openssl x509 -req -in server.csr \
        -CA ca.crt -CAkey ca.key -CAcreateserial \
        -out server.crt \
        -days 825 -sha256 \
        -extfile server.ext \
        >/dev/null 2>&1

    rm -f server.csr server.ext
else
    note "ok: server.crt valid for $DOMAIN"
fi

# 4. Sample client cert — for `curl --cert/--key` against the mTLS leg.
#    Subject /O=demo/CN=tester → RFC2253 form "CN=tester,O=demo"
#    (src/mtls-trust.ts), then src/identity.ts maps O→tenantId, CN→userId.
need_client=0
if [ "$FORCE" = "1" ]; then need_client=1; fi
if [ ! -s client-sample.crt ] || [ ! -s client-sample.key ]; then need_client=1; fi
if [ "$need_client" = "0" ] && ! valid_30d client-sample.crt; then
    note "client-sample.crt expires within 30 days — regenerating"
    need_client=1
fi

if [ "$need_client" = "1" ]; then
    note "generating sample client cert (O=demo, CN=tester)"
    openssl req -new -newkey rsa:2048 -nodes \
        -keyout client-sample.key -out client-sample.csr \
        -subj "/O=demo/CN=tester" \
        >/dev/null 2>&1

    cat >client.ext <<EOF
basicConstraints=CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = clientAuth
EOF

    openssl x509 -req -in client-sample.csr \
        -CA ca.crt -CAkey ca.key -CAcreateserial \
        -out client-sample.crt \
        -days 825 -sha256 \
        -extfile client.ext \
        >/dev/null 2>&1

    rm -f client-sample.csr client.ext
else
    note "ok: client-sample.crt valid"
fi

# Lock down permissions: production-grade keys 600 (only read by nginx/CA
# operations inside the container as root, so the bind mount's host owner
# does not matter). client-sample.key is intentionally 644: it's a
# zero-value test cert that the host operator needs to read via curl when
# exercising the mTLS leg (see README "Production-ish boot"). Losing 600
# on a real client cert is a leak; on this one it's a UX win.
chmod 600 ca.key server.key 2>/dev/null || true
chmod 644 ca.crt server.crt clients-ca.crt client-sample.crt client-sample.key 2>/dev/null || true

echo
note "artifacts:"
ls -1 ca.crt ca.key clients-ca.crt server.crt server.key client-sample.crt client-sample.key
echo
note "server cert fingerprint:"
openssl x509 -in server.crt -noout -fingerprint -sha256
