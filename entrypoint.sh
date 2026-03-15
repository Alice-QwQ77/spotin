#!/bin/sh
set -eu

log() {
  echo "[entrypoint] $*"
}

WIREPROXY_ENABLED="${WIREPROXY_ENABLED:-1}"
WIREPROXY_MODE="${WIREPROXY_MODE:-socks5}"
WIREPROXY_LISTEN_HOST="${WIREPROXY_LISTEN_HOST:-127.0.0.1}"
WIREPROXY_LISTEN_PORT="${WIREPROXY_LISTEN_PORT:-1080}"
WIREPROXY_INFO_HOST="${WIREPROXY_INFO_HOST:-127.0.0.1}"
WIREPROXY_INFO_PORT="${WIREPROXY_INFO_PORT:-9080}"
WIREPROXY_CONFIG_PATH="${WIREPROXY_CONFIG_PATH:-/data/wireproxy.conf}"
WIREPROXY_CONFIG="${WIREPROXY_CONFIG:-}"

WIREGUARD_CONFIG="${WIREGUARD_CONFIG:-}"
WIREGUARD_PRIVATE_KEY="${WIREGUARD_PRIVATE_KEY:-}"
WIREGUARD_ADDRESS="${WIREGUARD_ADDRESS:-}"
WIREGUARD_DNS="${WIREGUARD_DNS:-}"
WIREGUARD_PUBLIC_KEY="${WIREGUARD_PUBLIC_KEY:-}"
WIREGUARD_PRESHARED_KEY="${WIREGUARD_PRESHARED_KEY:-}"
WIREGUARD_ENDPOINT="${WIREGUARD_ENDPOINT:-}"
WIREGUARD_ALLOWED_IPS="${WIREGUARD_ALLOWED_IPS:-0.0.0.0/0}"
WIREGUARD_PERSISTENT_KEEPALIVE="${WIREGUARD_PERSISTENT_KEEPALIVE:-}"
WIREGUARD_CONFIG_PATH="${WIREGUARD_CONFIG_PATH:-/data/wireguard.conf}"

WGCF_AUTO="${WGCF_AUTO:-0}"
WGCF_DIR="${WGCF_DIR:-/data/wgcf}"

if [ "$WIREPROXY_ENABLED" != "1" ]; then
  log "WIREPROXY_ENABLED=0, skipping wireproxy startup."
  exec "$@"
fi

if [ "$WIREPROXY_MODE" != "socks5" ] && [ "$WIREPROXY_MODE" != "http" ]; then
  log "Unsupported WIREPROXY_MODE: $WIREPROXY_MODE (use socks5 or http)"
  exit 1
fi

mkdir -p "$(dirname "$WIREPROXY_CONFIG_PATH")"

write_proxy_section() {
  if [ "$WIREPROXY_MODE" = "socks5" ]; then
    cat <<EOF
[Socks5]
BindAddress = ${WIREPROXY_LISTEN_HOST}:${WIREPROXY_LISTEN_PORT}
EOF
  else
    cat <<EOF
[http]
BindAddress = ${WIREPROXY_LISTEN_HOST}:${WIREPROXY_LISTEN_PORT}
EOF
  fi
}

write_wireproxy_from_wgconfig() {
  wg_path="$1"
  cat <<EOF > "$WIREPROXY_CONFIG_PATH"
WGConfig = ${wg_path}

$(write_proxy_section)
EOF
}

write_wireproxy_from_fields() {
  cat <<EOF > "$WIREPROXY_CONFIG_PATH"
[Interface]
Address = ${WIREGUARD_ADDRESS}
PrivateKey = ${WIREGUARD_PRIVATE_KEY}
EOF
  if [ -n "$WIREGUARD_DNS" ]; then
    echo "DNS = ${WIREGUARD_DNS}" >> "$WIREPROXY_CONFIG_PATH"
  fi
  cat <<EOF >> "$WIREPROXY_CONFIG_PATH"

[Peer]
PublicKey = ${WIREGUARD_PUBLIC_KEY}
Endpoint = ${WIREGUARD_ENDPOINT}
AllowedIPs = ${WIREGUARD_ALLOWED_IPS}
EOF
  if [ -n "$WIREGUARD_PRESHARED_KEY" ]; then
    echo "PresharedKey = ${WIREGUARD_PRESHARED_KEY}" >> "$WIREPROXY_CONFIG_PATH"
  fi
  if [ -n "$WIREGUARD_PERSISTENT_KEEPALIVE" ]; then
    echo "PersistentKeepalive = ${WIREGUARD_PERSISTENT_KEEPALIVE}" >> "$WIREPROXY_CONFIG_PATH"
  fi
  echo "" >> "$WIREPROXY_CONFIG_PATH"
  write_proxy_section >> "$WIREPROXY_CONFIG_PATH"
}

config_source="none"

if [ -n "$WIREPROXY_CONFIG" ]; then
  log "Using wireproxy config from WIREPROXY_CONFIG."
  echo "$WIREPROXY_CONFIG" > "$WIREPROXY_CONFIG_PATH"
  config_source="wireproxy_config_env"
elif [ -f "$WIREPROXY_CONFIG_PATH" ]; then
  log "Using existing wireproxy config at $WIREPROXY_CONFIG_PATH."
  config_source="wireproxy_config_file"
elif [ -n "$WIREGUARD_CONFIG" ]; then
  log "Using WireGuard config from WIREGUARD_CONFIG."
  mkdir -p "$(dirname "$WIREGUARD_CONFIG_PATH")"
  echo "$WIREGUARD_CONFIG" > "$WIREGUARD_CONFIG_PATH"
  write_wireproxy_from_wgconfig "$WIREGUARD_CONFIG_PATH"
  config_source="wireguard_config_env"
elif [ -f "$WIREGUARD_CONFIG_PATH" ]; then
  log "Using existing WireGuard config at $WIREGUARD_CONFIG_PATH."
  write_wireproxy_from_wgconfig "$WIREGUARD_CONFIG_PATH"
  config_source="wireguard_config_file"
elif [ -n "$WIREGUARD_PRIVATE_KEY" ] && [ -n "$WIREGUARD_ADDRESS" ] && [ -n "$WIREGUARD_PUBLIC_KEY" ] && [ -n "$WIREGUARD_ENDPOINT" ]; then
  log "Using WireGuard fields to generate wireproxy config."
  write_wireproxy_from_fields
  config_source="wireguard_fields"
elif [ "$WGCF_AUTO" = "1" ]; then
  log "WGCF_AUTO=1, generating WARP WireGuard config with wgcf."
  mkdir -p "$WGCF_DIR"
  cd "$WGCF_DIR"
  if [ ! -f "wgcf-account.toml" ]; then
    wgcf register --accept-tos
  fi
  wgcf generate
  if [ ! -f "wgcf-profile.conf" ]; then
    log "wgcf-profile.conf not found after wgcf generate."
    exit 1
  fi
  write_wireproxy_from_wgconfig "$WGCF_DIR/wgcf-profile.conf"
  config_source="wgcf"
else
  log "No wireproxy/WireGuard config provided."
  log "Set WIREPROXY_CONFIG or WIREGUARD_CONFIG or WireGuard fields, or enable WGCF_AUTO=1."
  exit 1
fi

log "Config source: $config_source"
log "Validating wireproxy config."
wireproxy -c "$WIREPROXY_CONFIG_PATH" -n

if [ "$WIREPROXY_MODE" = "socks5" ]; then
  PROXY_URL="socks5h://${WIREPROXY_LISTEN_HOST}:${WIREPROXY_LISTEN_PORT}"
  PLAYWRIGHT_PROXY_SERVER="socks5://${WIREPROXY_LISTEN_HOST}:${WIREPROXY_LISTEN_PORT}"
else
  PROXY_URL="http://${WIREPROXY_LISTEN_HOST}:${WIREPROXY_LISTEN_PORT}"
  PLAYWRIGHT_PROXY_SERVER="$PROXY_URL"
fi

export PROXY_URL
export PLAYWRIGHT_PROXY_SERVER
export HTTP_PROXY="$PROXY_URL"
export HTTPS_PROXY="$PROXY_URL"
export ALL_PROXY="$PROXY_URL"
export NO_PROXY="127.0.0.1,localhost"

log "Starting wireproxy on ${WIREPROXY_LISTEN_HOST}:${WIREPROXY_LISTEN_PORT}."
wireproxy -c "$WIREPROXY_CONFIG_PATH" -i "${WIREPROXY_INFO_HOST}:${WIREPROXY_INFO_PORT}" &
WIREPROXY_PID=$!
log "wireproxy pid=$WIREPROXY_PID, info endpoint at ${WIREPROXY_INFO_HOST}:${WIREPROXY_INFO_PORT}."

if [ "${WIREPROXY_DIAGNOSTICS:-1}" = "1" ]; then
  log "Running proxy diagnostics."
  python /app/scripts/proxy_diagnostics.py || true
fi

exec "$@"
