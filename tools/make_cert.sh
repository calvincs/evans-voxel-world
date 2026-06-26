#!/usr/bin/env bash
# Generate a self-signed certificate so voice chat (microphone) works for other
# devices on your LAN, which browsers only allow over HTTPS.
#
# After running this, start the game with HTTPS:
#   EVANS_SSL_CERT=certs/cert.pem EVANS_SSL_KEY=certs/key.pem ./run.sh
#
# Then open  https://<your-lan-ip>:8765  on each device and accept the
# one-time "not secure" warning (it's your own cert).
set -e
cd "$(dirname "$0")/.."
mkdir -p certs

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
SAN="DNS:localhost,IP:127.0.0.1"
[ -n "$IP" ] && SAN="$SAN,IP:$IP"

openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout certs/key.pem -out certs/cert.pem \
  -subj "/CN=EvansGame" -addext "subjectAltName=$SAN"

echo ""
echo "  Created certs/cert.pem and certs/key.pem"
echo "  (valid for: $SAN)"
echo ""
echo "  Start with voice support:"
echo "    EVANS_SSL_CERT=certs/cert.pem EVANS_SSL_KEY=certs/key.pem ./run.sh"
echo "  Then open  https://${IP:-<lan-ip>}:8765  and accept the cert warning."
