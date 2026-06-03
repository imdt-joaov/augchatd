#!/usr/bin/env bash
# deploy.sh — install dependencies, configure the firewall, generate
# secrets, and boot the augchatd stack on an Ubuntu/Debian VPS.
#
# Assumes:
#   - The augchatd repo is already on the VPS (git clone / scp / rsync).
#   - DNS for <domain> already points at this VPS (or you'll do that next).
#
# Usage:
#   sudo ./scripts/deploy.sh <domain>
#   sudo ./scripts/deploy.sh <domain> --letsencrypt <email>
#
# Without --letsencrypt: nginx serves the self-signed bundle from cert-init.
# With --letsencrypt:    the bundle's server.{crt,key} are then overwritten
#                        by a Let's Encrypt PROD cert (no staging mode —
#                        see adr-0015), and a systemd timer is installed
#                        to renew weekly.
#
# Idempotent: every step checks current state before changing anything.
# Safe to re-run after a partial failure, or to update the domain.

set -euo pipefail

# Re-exec under sudo if the caller forgot. -E preserves env so $HOME/$USER
# stay coherent for any logging that happens before we lose them.
[ "$EUID" -eq 0 ] || exec sudo -E "$0" "$@"

usage() {
    echo "Usage:" >&2
    echo "  sudo ./scripts/deploy.sh <domain>" >&2
    echo "  sudo ./scripts/deploy.sh <domain> --letsencrypt <email>" >&2
    exit 64
}

[ $# -ge 1 ] || usage
DOMAIN="$1"; shift
LETSENCRYPT_EMAIL=""
while [ $# -gt 0 ]; do
    case "$1" in
        --letsencrypt)
            [ $# -ge 2 ] || usage
            LETSENCRYPT_EMAIL="$2"
            shift 2
            ;;
        *) usage ;;
    esac
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

step() { echo; echo "==> $*"; }

# ---------------------------------------------------------------------------
# [1] apt prerequisites
# ---------------------------------------------------------------------------
step "Installing apt prerequisites (ca-certificates, curl, gnupg, openssl, ufw, jq)"
DEBIAN_FRONTEND=noninteractive apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    ca-certificates curl gnupg openssl ufw jq

# ---------------------------------------------------------------------------
# [2] Docker Engine + Compose plugin via the official docker.com apt repo.
#     Skip everything if `docker compose version` already responds.
# ---------------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
    step "Installing Docker Engine + Compose plugin"
    . /etc/os-release
    case "$ID" in
        ubuntu|debian) ;;
        *) echo "Unsupported OS: $ID. This script supports Ubuntu/Debian only." >&2
           exit 1 ;;
    esac
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL "https://download.docker.com/linux/$ID/gpg" \
        -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID ${VERSION_CODENAME} stable" \
        > /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
        docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
    step "Docker already installed: $(docker --version)"
fi

# ---------------------------------------------------------------------------
# [3] Enable docker at boot so `restart: unless-stopped` actually restores
#     the stack after a host reboot.
# ---------------------------------------------------------------------------
step "Enabling docker daemon at boot"
systemctl enable --now docker

# ---------------------------------------------------------------------------
# [4] UFW: deny incoming by default, allow only the ports the stack needs.
#     22 = SSH, 80 = HTTP (used briefly by letsencrypt-init standalone for
#     ACME HTTP-01), 443 = browser TLS, 8443 = mTLS control plane.
# ---------------------------------------------------------------------------
step "Configuring UFW (22, 80, 443, 8443)"
ufw --force enable >/dev/null
ufw default deny incoming  >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp   comment 'ssh'                         >/dev/null
ufw allow 80/tcp   comment 'http (letsencrypt http-01)'  >/dev/null
ufw allow 443/tcp  comment 'augchatd browser TLS'        >/dev/null
ufw allow 8443/tcp comment 'augchatd mTLS control plane' >/dev/null

# ---------------------------------------------------------------------------
# [5] .env — generate JWT secret on first run; PRESERVE it on reruns
#     (regenerating would invalidate every open JWT session — irreversible).
#     Only AUGCHATD_DOMAIN is updated to match the argument.
# ---------------------------------------------------------------------------
ENV_FILE="$REPO_ROOT/.env"
if [ -s "$ENV_FILE" ] && grep -q '^AUGCHATD_JWT_SECRET=' "$ENV_FILE"; then
    step ".env present — preserving AUGCHATD_JWT_SECRET; syncing AUGCHATD_DOMAIN"
    if grep -q '^AUGCHATD_DOMAIN=' "$ENV_FILE"; then
        sed -i "s|^AUGCHATD_DOMAIN=.*|AUGCHATD_DOMAIN=$DOMAIN|" "$ENV_FILE"
    else
        echo "AUGCHATD_DOMAIN=$DOMAIN" >> "$ENV_FILE"
    fi
else
    step "Generating .env with a fresh JWT secret"
    JWT_SECRET=$(openssl rand -hex 32)
    cat > "$ENV_FILE" <<EOF
AUGCHATD_JWT_SECRET=$JWT_SECRET
AUGCHATD_DOMAIN=$DOMAIN
EOF
    chmod 600 "$ENV_FILE"
fi

# ---------------------------------------------------------------------------
# [6] Self-signed cert bundle (always — cert-init produces the CA,
#     clients-CA, sample client, AND a fallback self-signed server cert).
#     When --letsencrypt is on, step 7.5 overwrites only server.{crt,key}.
# ---------------------------------------------------------------------------
step "Generating self-signed SSL bundle for $DOMAIN"
docker compose run --rm cert-init "$DOMAIN"

# ---------------------------------------------------------------------------
# [7] Build + boot the stack.
# ---------------------------------------------------------------------------
step "Building and starting the stack"
docker compose up -d --build

# ---------------------------------------------------------------------------
# [7.5] Let's Encrypt: issue/refresh the cert AND install the systemd
#       renewal timer. Only when --letsencrypt was passed.
# ---------------------------------------------------------------------------
install_systemd_renewal() {
    local svc_path=/etc/systemd/system/augchatd-letsencrypt-renew.service
    local timer_path=/etc/systemd/system/augchatd-letsencrypt-renew.timer
    local tmp_svc tmp_timer changed=0
    tmp_svc=$(mktemp); tmp_timer=$(mktemp)
    # shellcheck disable=SC2064
    trap "rm -f '$tmp_svc' '$tmp_timer'" RETURN

    cat > "$tmp_svc" <<EOF
[Unit]
Description=augchatd Let's Encrypt cert renewal
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
WorkingDirectory=$REPO_ROOT
ExecStart=/usr/bin/docker compose run --rm --service-ports letsencrypt-init renew
ExecStartPost=/usr/bin/docker compose exec -T nginx nginx -s reload
EOF

    cat > "$tmp_timer" <<'EOF'
[Unit]
Description=Weekly augchatd Let's Encrypt renewal

[Timer]
OnCalendar=Sun 03:00
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
EOF

    if ! cmp -s "$tmp_svc" "$svc_path"; then
        install -m 0644 "$tmp_svc" "$svc_path"
        changed=1
    fi
    if ! cmp -s "$tmp_timer" "$timer_path"; then
        install -m 0644 "$tmp_timer" "$timer_path"
        changed=1
    fi
    if [ "$changed" = "1" ]; then
        systemctl daemon-reload
    fi
    systemctl enable --now augchatd-letsencrypt-renew.timer
}

if [ -n "$LETSENCRYPT_EMAIL" ]; then
    step "Issuing/refreshing Let's Encrypt cert for $DOMAIN ($LETSENCRYPT_EMAIL)"
    docker compose run --rm --service-ports letsencrypt-init \
        issue "$DOMAIN" "$LETSENCRYPT_EMAIL"
    docker compose exec -T nginx nginx -s reload

    step "Installing systemd timer for weekly cert renewal"
    install_systemd_renewal
fi

# ---------------------------------------------------------------------------
# [8] Wait for nginx healthy, then smoke-test through it.
# ---------------------------------------------------------------------------
step "Waiting for nginx healthy (up to 60s)"
state=""
for _ in $(seq 1 60); do
    state=$(docker compose ps --format json nginx 2>/dev/null \
            | jq -r 'if type=="array" then .[0].Health else .Health end // empty' \
            2>/dev/null || true)
    [ "$state" = "healthy" ] && break
    sleep 1
done
if [ "$state" != "healthy" ]; then
    echo "nginx did not become healthy in 60s. Inspect: docker compose logs nginx" >&2
    exit 1
fi

if [ -n "$LETSENCRYPT_EMAIL" ]; then
    step "Smoke test: GET https://$DOMAIN/healthz (browser-trusted cert expected)"
    smoke_url="https://$DOMAIN/healthz"
    smoke_args=""
else
    step "Smoke test: GET https://localhost/healthz (self-signed)"
    smoke_url="https://localhost/healthz"
    smoke_args="-k"
fi
# shellcheck disable=SC2086
body=$(curl -sS $smoke_args "$smoke_url" || true)
echo "  response: $body"
echo "$body" | grep -q '"mode":"prod"' || {
    echo "Unexpected /healthz response — investigate via 'docker compose logs augchatd'." >&2
    exit 1
}

step "Done. Stack:"
docker compose ps
