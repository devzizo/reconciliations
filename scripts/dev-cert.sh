#!/bin/sh
# Self-signed certificate for testing on a phone over the local network.
# Phones will warn about it; for real use put the app behind a proxy with a proper certificate.
set -e
HOST_IP="${1:-$(hostname -I 2>/dev/null | awk '{print $1}')}"
openssl req -x509 -newkey rsa:2048 -nodes -days 30 \
  -keyout dev-key.pem -out dev-cert.pem \
  -subj "/CN=reconciliations-dev" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1${HOST_IP:+,IP:$HOST_IP}"
echo "Run: TLS_CERT=dev-cert.pem TLS_KEY=dev-key.pem npm start"
