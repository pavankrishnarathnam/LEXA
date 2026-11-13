#!/usr/bin/env bash
# One-time VPS bootstrap for LEXA (Ubuntu 22.04/24.04, Debian 12; e.g. Hostinger KVM VPS).
# Run as root (or with sudo) from the repository checkout:  sudo infrastructure/scripts/install-vps.sh lexa.example.com you@example.com
set -euo pipefail

DOMAIN="${1:?usage: install-vps.sh <domain> <letsencrypt-email>}"
EMAIL="${2:?usage: install-vps.sh <domain> <letsencrypt-email>}"
APP_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
DEPLOY_USER="${DEPLOY_USER:-${SUDO_USER:-root}}"

log() { printf '\033[1;35m[lexa]\033[0m %s\n' "$*"; }

log "Installing base packages"
apt-get update -y
apt-get install -y ca-certificates curl gnupg ufw fail2ban openssl python3 python3-cryptography

if ! command -v docker >/dev/null; then
  log "Installing Docker Engine + compose plugin"
  install -m 0755 -d /etc/apt/keyrings
  # shellcheck disable=SC1091
  . /etc/os-release
  curl -fsSL "https://download.docker.com/linux/${ID}/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker
if [ "$DEPLOY_USER" != "root" ]; then usermod -aG docker "$DEPLOY_USER"; fi

log "Configuring firewall (SSH, HTTP, HTTPS only)"
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
systemctl enable --now fail2ban

cd "$APP_DIR"
if [ ! -f .env ]; then
  log "Creating .env with generated secrets"
  cp .env.example .env
  set_kv() { sed -i "s|^$1=.*|$1=$2|" .env; }
  set_kv LEXA_DOMAIN "$DOMAIN"
  set_kv PUBLIC_URL "https://$DOMAIN"
  set_kv API_URL "https://$DOMAIN"
  set_kv CORS_ORIGINS "https://$DOMAIN"
  set_kv LETSENCRYPT_EMAIL "$EMAIL"
  set_kv JWT_SECRET "$(openssl rand -hex 32)"
  set_kv ENCRYPTION_KEY "$(python3 -c 'from cryptography.fernet import Fernet;print(Fernet.generate_key().decode())')"
  set_kv POSTGRES_PASSWORD "$(openssl rand -hex 24)"
  set_kv REDIS_PASSWORD "$(openssl rand -hex 24)"
  chmod 600 .env
  log "Edit .env to add ANTHROPIC_API_KEY (and optional OPENAI_API_KEY / OAuth clients)."
else
  log ".env already exists — leaving it untouched"
fi
mkdir -p backups && chmod 700 backups

log "Installing scheduled jobs (nightly verified backup, daily nginx reload for renewed certificates)"
cat > /etc/cron.d/lexa <<CRON
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
15 3 * * * root cd $APP_DIR && infrastructure/scripts/backup.sh >> /var/log/lexa-backup.log 2>&1
40 4 * * * root cd $APP_DIR && docker compose exec -T nginx nginx -s reload >/dev/null 2>&1
CRON
chmod 644 /etc/cron.d/lexa

log "Done. Next steps:"
echo "  1. Point DNS: A record  $DOMAIN -> $(curl -fsS https://api.ipify.org || echo '<this VPS IPv4>')"
echo "  2. Add ANTHROPIC_API_KEY to $APP_DIR/.env"
echo "  3. infrastructure/scripts/init-letsencrypt.sh      (issues the HTTPS certificate)"
echo "  4. infrastructure/scripts/deploy.sh <version>      (or let GitHub Actions deploy)"
