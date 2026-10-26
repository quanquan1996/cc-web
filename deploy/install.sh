#!/usr/bin/env bash
# CC-Web one-shot installer for Amazon Linux 2023 / RHEL-likes (dnf/yum) and
# Ubuntu/Debian (apt). Idempotent: safe to re-run after `git pull` to update.
#
#   git clone <repo> cc-web && cd cc-web && sudo ./deploy/install.sh
#
# Overridable via environment:
#   INSTALL_DIR=/opt/cc-web  SERVICE_USER=ccweb  NODE_MAJOR=22
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  exec sudo -E bash "$0" "$@"
fi

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="${INSTALL_DIR:-/opt/cc-web}"
SERVICE_USER="${SERVICE_USER:-ccweb}"
SERVICE_HOME="/home/${SERVICE_USER}"
NODE_MAJOR="${NODE_MAJOR:-22}"
ENV_DIR="/etc/cc-web"
ENV_FILE="${ENV_DIR}/env"
UNIT_DIR="/etc/systemd/system"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*"; }

# --------------------------------------------------------------- packages --
if command -v dnf >/dev/null 2>&1; then PM=dnf
elif command -v yum >/dev/null 2>&1; then PM=yum
elif command -v apt-get >/dev/null 2>&1; then PM=apt
else echo "Unsupported distro: need dnf, yum or apt-get" >&2; exit 1
fi

pkg_install() {
  case "$PM" in
    apt) DEBIAN_FRONTEND=noninteractive apt-get install -y -q "$@" ;;
    *)   "$PM" install -y -q "$@" ;;
  esac
}

log "Installing base packages ($PM)"
case "$PM" in
  apt)
    apt-get update -q
    pkg_install ca-certificates curl rsync openssl git build-essential python3 acl
    ;;
  *)
    # curl-minimal on AL2023 conflicts with curl; only install if missing.
    command -v curl >/dev/null 2>&1 || pkg_install curl
    pkg_install rsync openssl git gcc-c++ make python3 acl tar
    ;;
esac

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

if ! command -v node >/dev/null 2>&1 || [[ "$(node_major)" -lt 20 ]]; then
  log "Installing Node.js ${NODE_MAJOR}.x (NodeSource)"
  if [[ "$PM" == apt ]]; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  else
    curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  fi
  pkg_install nodejs
else
  log "Node.js $(node -v) already installed"
fi

# ------------------------------------------------------------ system user --
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  log "Creating system user ${SERVICE_USER}"
  # Real home + shell so the user can run `claude` once to log in.
  useradd --system --create-home --home-dir "$SERVICE_HOME" --shell /bin/bash "$SERVICE_USER"
else
  log "User ${SERVICE_USER} exists"
fi

# ------------------------------------------------------------------ code --
if [[ "$SRC_DIR" != "$INSTALL_DIR" ]]; then
  log "Syncing ${SRC_DIR} -> ${INSTALL_DIR}"
  mkdir -p "$INSTALL_DIR"
  # Runtime state (apps/, data/, .env, node_modules) is never overwritten or deleted.
  rsync -a --delete \
    --exclude '/node_modules/' --exclude '/packages/*/node_modules/' \
    --exclude '/.env' --exclude '/apps/' --exclude '/data/' --exclude '/workspace/' \
    "${SRC_DIR}/" "${INSTALL_DIR}/"
else
  log "Using repository directory in place: ${INSTALL_DIR}"
fi
mkdir -p "${INSTALL_DIR}/apps" "${INSTALL_DIR}/data"
[[ -f "${INSTALL_DIR}/apps/README.md" ]] || cp -f "${SRC_DIR}/apps/README.md" "${INSTALL_DIR}/apps/README.md" 2>/dev/null || true
chown -R "${SERVICE_USER}:${SERVICE_USER}" "$INSTALL_DIR"
chmod 750 "${INSTALL_DIR}/data"

log "Installing npm dependencies"
as_user() { runuser -u "$SERVICE_USER" -- env HOME="$SERVICE_HOME" PATH="$PATH" bash -c "$1"; }
if [[ -f "${INSTALL_DIR}/package-lock.json" ]]; then
  as_user "cd '${INSTALL_DIR}' && npm ci --omit=dev --no-audit --no-fund"
else
  warn "package-lock.json not found, falling back to npm install"
  as_user "cd '${INSTALL_DIR}' && npm install --omit=dev --no-audit --no-fund"
fi

# ---------------------------------------------------------------- env file --
rand_hex() { openssl rand -hex 32 2>/dev/null || node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))'; }

detect_claude() {
  if [[ -x "${SERVICE_HOME}/.local/bin/claude" ]]; then echo "${SERVICE_HOME}/.local/bin/claude"
  elif command -v claude >/dev/null 2>&1; then command -v claude
  else echo claude
  fi
}

mkdir -p "$ENV_DIR"
chmod 700 "$ENV_DIR"
if [[ ! -f "$ENV_FILE" ]]; then
  log "Writing ${ENV_FILE} with fresh random secrets"
  umask 077
  cat > "$ENV_FILE" <<EOF
# CC-Web production config (see .env.example for documentation of every key).
PORT_CORE=8787
PORT_APPS=8788
APPS_SERVICE_URL=http://127.0.0.1:8788

ADMIN_USER=admin
# Generate: cd ${INSTALL_DIR} && npm run hash-pass -- 'your-password'
ADMIN_PASS_HASH=
JWT_SECRET=$(rand_hex)
SESSION_TTL_HOURS=12
COOKIE_SECURE=true

LOGIN_RATE_MAX=5
LOGIN_RATE_WINDOW_MIN=15
TRUST_PROXY=true

# Paste this exact value into CloudFront as origin custom header X-Origin-Secret.
ORIGIN_SECRET=$(rand_hex)

ALLOWED_ROOTS=/home/ec2-user/projects
CLAUDE_BIN=$(detect_claude)
CLAUDE_EXTRA_ARGS=--permission-mode acceptEdits
MAX_CONCURRENT_RUNS=2

APPS_DIR=${INSTALL_DIR}/apps
APPS_DYNAMIC_ENABLED=false
APPS_SANDBOX=true

DATA_DIR=${INSTALL_DIR}/data
LOG_LEVEL=info
EOF
else
  log "${ENV_FILE} exists; keeping it (only filling empty secrets)"
  for key in JWT_SECRET ORIGIN_SECRET; do
    if ! grep -qE "^${key}=.+" "$ENV_FILE"; then
      if grep -qE "^${key}=" "$ENV_FILE"; then
        sed -i "s|^${key}=.*$|${key}=$(rand_hex)|" "$ENV_FILE"
      else
        echo "${key}=$(rand_hex)" >> "$ENV_FILE"
      fi
      log "Generated ${key}"
    fi
  done
fi
chown root:root "$ENV_FILE"
chmod 600 "$ENV_FILE"

# ----------------------------------------------------------- systemd units --
log "Installing systemd units"
APPS_DIR_VALUE="$(grep -E '^APPS_DIR=' "$ENV_FILE" | tail -n1 | cut -d= -f2- | tr -d "'\"")"
APPS_DIR_VALUE="${APPS_DIR_VALUE:-${INSTALL_DIR}/apps}"
for unit in cc-web-core.service cc-web-apps.service; do
  sed -e "s#/opt/cc-web/apps#${APPS_DIR_VALUE}#g" \
      -e "s#/opt/cc-web#${INSTALL_DIR}#g" \
      -e "s#^User=ccweb#User=${SERVICE_USER}#" \
      -e "s#^Group=ccweb#Group=${SERVICE_USER}#" \
      -e "s#/home/ccweb#${SERVICE_HOME}#g" \
      "${SRC_DIR}/deploy/${unit}" > "${UNIT_DIR}/${unit}"
  # ProtectHome=true would hide an install living under /home.
  if [[ "$INSTALL_DIR" == /home/* || "$APPS_DIR_VALUE" == /home/* ]]; then
    sed -i 's#^ProtectHome=true#ProtectHome=false#' "${UNIT_DIR}/${unit}"
  fi
  chmod 644 "${UNIT_DIR}/${unit}"
done
systemctl daemon-reload
systemctl enable cc-web-core.service cc-web-apps.service >/dev/null
log "Units enabled (not started)"

# ------------------------------------------------------------- next steps --
PORT_CORE_VALUE="$(grep -E '^PORT_CORE=' "$ENV_FILE" | cut -d= -f2-)"
cat <<EOF

$(printf '\033[1;32m')CC-Web installed to ${INSTALL_DIR}$(printf '\033[0m')

Next steps:

 1. Install and log in to Claude Code AS ${SERVICE_USER} (credentials live in ${SERVICE_HOME}/.claude):
      sudo -u ${SERVICE_USER} -i bash -c 'curl -fsSL https://claude.ai/install.sh | bash'
        (or: sudo npm install -g @anthropic-ai/claude-code)
      sudo -u ${SERVICE_USER} -i claude        # complete the login once, then /exit
      sudo -u ${SERVICE_USER} -i claude --help # verify -p / --output-format / --session-id / --resume

 2. Set the admin password hash:
      cd ${INSTALL_DIR} && sudo -u ${SERVICE_USER} npm run hash-pass -- 'a-long-password'
      sudo nano ${ENV_FILE}     # ADMIN_PASS_HASH='\$2b\$12\$...'

 3. Set ALLOWED_ROOTS in ${ENV_FILE} and give ${SERVICE_USER} access, e.g.:
      sudo mkdir -p /home/ec2-user/projects
      sudo setfacl -m u:${SERVICE_USER}:x /home/ec2-user
      sudo setfacl -R -m u:${SERVICE_USER}:rwX,d:u:${SERVICE_USER}:rwX /home/ec2-user/projects
    Also check CLAUDE_BIN (currently: $(grep -E '^CLAUDE_BIN=' "$ENV_FILE" | cut -d= -f2-)).

 4. Start both services:
      sudo systemctl restart cc-web-core cc-web-apps
      sudo systemctl status cc-web-core cc-web-apps --no-pager
      curl -s http://127.0.0.1:${PORT_CORE_VALUE:-8787}/healthz

 5. CloudFront: follow ${INSTALL_DIR}/deploy/cloudfront.md. Origin custom header value:
      sudo grep ^ORIGIN_SECRET= ${ENV_FILE}
    Restrict the security group for port ${PORT_CORE_VALUE:-8787} to the managed prefix list
    com.amazonaws.global.cloudfront.origin-facing (never 0.0.0.0/0).

Logs: journalctl -u cc-web-core -f   |   journalctl -u cc-web-apps -f
Audit log: ${INSTALL_DIR}/data/audit.log
EOF
