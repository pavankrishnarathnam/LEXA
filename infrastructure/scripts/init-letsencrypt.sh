#!/usr/bin/env bash
# Issues the first Let's Encrypt certificate for $LEXA_DOMAIN using the HTTP-01 webroot challenge.
# Nginx needs a certificate to start, so a temporary self-signed one is created first.
#   STAGING=1 infrastructure/scripts/init-letsencrypt.sh   # test against the staging CA first
set -euo pipefail
cd "$(dirname "$0")/../.."
# shellcheck disable=SC1091
set -a; . ./.env; set +a
: "${LEXA_DOMAIN:?LEXA_DOMAIN missing in .env}" "${LETSENCRYPT_EMAIL:?LETSENCRYPT_EMAIL missing in .env}"
DC="docker compose"
LIVE="/etc/letsencrypt/live/$LEXA_DOMAIN"

echo "[lexa] Checking DNS for $LEXA_DOMAIN"
getent hosts "$LEXA_DOMAIN" || { echo "DNS for $LEXA_DOMAIN does not resolve yet. Create the A record first."; exit 1; }

if ! $DC run --rm --entrypoint sh certbot -c "test -f $LIVE/fullchain.pem"; then
  echo "[lexa] Creating temporary self-signed certificate"
  $DC run --rm --entrypoint sh certbot -c "mkdir -p $LIVE && openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
    -keyout $LIVE/privkey.pem -out $LIVE/fullchain.pem -subj /CN=localhost"
  TEMP_CERT=1
fi

echo "[lexa] Starting nginx"
$DC up -d nginx

if [ "${TEMP_CERT:-0}" = "1" ]; then
  $DC run --rm --entrypoint sh certbot -c "rm -rf /etc/letsencrypt/live/$LEXA_DOMAIN /etc/letsencrypt/archive/$LEXA_DOMAIN /etc/letsencrypt/renewal/$LEXA_DOMAIN.conf"
fi

STAGING_ARG=""
[ "${STAGING:-0}" = "1" ] && STAGING_ARG="--staging"
echo "[lexa] Requesting certificate"
$DC run --rm --entrypoint certbot certbot certonly --webroot -w /var/www/certbot $STAGING_ARG \
  --email "$LETSENCRYPT_EMAIL" --agree-tos --no-eff-email -d "$LEXA_DOMAIN" --rsa-key-size 4096 --non-interactive

$DC exec nginx nginx -s reload
$DC --profile tls up -d certbot
echo "[lexa] HTTPS ready: https://$LEXA_DOMAIN"
