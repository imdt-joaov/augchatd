#!/bin/sh
# Refuse to boot nginx if any of the certs the augchatd config references
# is missing. Hard-failing here is the gate that satisfies requirement #3
# (proxy only starts if a cert is available) and — combined with the
# compose healthcheck — requirement #4 (augchatd only starts if the proxy
# starts successfully).

set -e

CERT_DIR=/etc/ssl/augchatd
for f in server.crt server.key clients-ca.crt; do
  if [ ! -s "$CERT_DIR/$f" ]; then
    echo "nginx: required cert missing at $CERT_DIR/$f" >&2
    echo "Run: docker compose run --rm cert-init <domain>" >&2
    exit 1
  fi
done
