#!/bin/sh
# letsencrypt.sh — issue / renew the augchatd nginx server cert from
# Let's Encrypt via HTTP-01 standalone. Always targets the LE PRODUCTION
# endpoint (no --staging). Writes the resulting fullchain.pem and
# privkey.pem into /out/server.crt and /out/server.key — the same paths
# nginx already serves. The CA + clients-CA + sample client cert in the
# bundle stay where cert-init left them (LE does not issue those).
#
# Subcommands:
#   issue <domain> <email> [--force]
#   renew [--dry-run]
#
# The cert-name `augchatd` is the on-disk identifier certbot stores under
# /etc/letsencrypt/{live,renewal,archive}/augchatd/ — kept constant so
# `renew` always picks the right one.

set -eu
umask 077

CERT_NAME=augchatd
LIVE_DIR="/etc/letsencrypt/live/$CERT_NAME"
OUT=/out
cd "$OUT"

note() { echo "letsencrypt-init: $*"; }

usage() {
    echo "Usage:" >&2
    echo "  letsencrypt.sh issue <domain> <email> [--force]" >&2
    echo "  letsencrypt.sh renew [--dry-run]" >&2
    exit 64
}

# Copies the live fullchain + privkey into /out, fixing perms. Called
# after both `issue` and `renew` (no-op on renew when nothing rotated).
publish_cert() {
    [ -s "$LIVE_DIR/fullchain.pem" ] || {
        note "WARN: $LIVE_DIR/fullchain.pem missing; not publishing"
        return 0
    }
    cp "$LIVE_DIR/fullchain.pem" "$OUT/server.crt"
    cp "$LIVE_DIR/privkey.pem"   "$OUT/server.key"
    chmod 644 "$OUT/server.crt"
    chmod 600 "$OUT/server.key"
}

# Idempotency check for `issue`: is the current server.crt already a
# Let's Encrypt cert for <domain> with > 30 days left?
already_valid_for() {
    domain="$1"
    [ -s "$OUT/server.crt" ] || return 1
    openssl x509 -in "$OUT/server.crt" -noout -checkend 2592000 >/dev/null 2>&1 || return 1
    openssl x509 -in "$OUT/server.crt" -noout -issuer 2>/dev/null \
        | grep -q "Let's Encrypt" || return 1
    openssl x509 -in "$OUT/server.crt" -noout -ext subjectAltName 2>/dev/null \
        | grep -q "DNS:$domain" || return 1
    return 0
}

cmd="${1-}"
[ -n "$cmd" ] || usage
shift

case "$cmd" in
    issue)
        [ $# -ge 2 ] || usage
        DOMAIN="$1"; shift
        EMAIL="$1"; shift
        FORCE=0
        if [ $# -gt 0 ]; then
            case "$1" in
                --force) FORCE=1; shift ;;
                *) usage ;;
            esac
        fi
        [ $# -eq 0 ] || usage

        if [ "$FORCE" = "0" ] && already_valid_for "$DOMAIN"; then
            note "ok: server.crt is LE-issued for $DOMAIN; >30 days remaining"
            publish_cert   # ensures perms even if file already present
            exit 0
        fi

        note "requesting cert from Let's Encrypt PROD for $DOMAIN"
        certbot certonly --standalone \
            --non-interactive --agree-tos -m "$EMAIL" \
            --cert-name "$CERT_NAME" \
            -d "$DOMAIN"

        publish_cert
        note "issued; fingerprint:"
        openssl x509 -in "$OUT/server.crt" -noout -fingerprint -sha256
        openssl x509 -in "$OUT/server.crt" -noout -issuer
        ;;

    renew)
        DRY=""
        if [ $# -gt 0 ]; then
            case "$1" in
                --dry-run) DRY="--dry-run"; shift ;;
                *) usage ;;
            esac
        fi
        [ $# -eq 0 ] || usage

        note "running certbot renew --cert-name $CERT_NAME${DRY:+ $DRY}"
        # shellcheck disable=SC2086
        certbot renew --cert-name "$CERT_NAME" $DRY

        if [ -z "$DRY" ]; then
            publish_cert
        fi
        ;;

    *)
        usage
        ;;
esac
