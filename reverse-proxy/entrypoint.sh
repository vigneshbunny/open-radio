#!/bin/sh
set -eu

TLS_IP="${TLS_IP:-127.0.0.1}"
TLS_HOST="${TLS_HOST:-localhost}"
LISTEN_PORT="${LISTEN_PORT:-8443}"
UPSTREAM_HOST="${UPSTREAM_HOST:-client}"
UPSTREAM_PORT="${UPSTREAM_PORT:-3000}"

mkdir -p /etc/nginx/certs

if [ ! -f /etc/nginx/certs/cert.pem ] || [ ! -f /etc/nginx/certs/key.pem ]; then
  echo "[proxy] generating self-signed cert for IP=${TLS_IP} host=${TLS_HOST}"
  openssl req -x509 -newkey rsa:2048 -nodes \
    -days 365 \
    -keyout /etc/nginx/certs/key.pem \
    -out /etc/nginx/certs/cert.pem \
    -subj "/CN=${TLS_HOST}" \
    -addext "subjectAltName=DNS:localhost,DNS:${TLS_HOST},IP:${TLS_IP}"
fi

# Render nginx.conf from template (envsubst).
export LISTEN_PORT UPSTREAM_HOST UPSTREAM_PORT
envsubst '${LISTEN_PORT} ${UPSTREAM_HOST} ${UPSTREAM_PORT}' \
  < /etc/nginx/nginx.conf.template \
  > /etc/nginx/nginx.conf

echo "[proxy] starting nginx on :${LISTEN_PORT}"
exec nginx -g "daemon off;"

