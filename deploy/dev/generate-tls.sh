#!/usr/bin/env bash
set -euo pipefail
DEST="${1:-.dev/tls}"
mkdir -p "$DEST"
chmod 700 "$DEST"
if [[ -f "$DEST/server.crt" || -f "$DEST/ca.key" ]]; then echo "Refusing to overwrite existing certificates in $DEST" >&2; exit 1; fi
umask 077
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$DEST/ca.key" 2>/dev/null
openssl req -x509 -new -sha256 -key "$DEST/ca.key" -days 7 -out "$DEST/ca.crt" -subj '/CN=Farhelm local development CA' -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign'
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$DEST/server.key" 2>/dev/null
openssl req -new -key "$DEST/server.key" -out "$DEST/server.csr" -subj '/CN=localhost'
cat > "$DEST/extensions.cnf" <<'EXT'
subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
EXT
openssl x509 -req -in "$DEST/server.csr" -CA "$DEST/ca.crt" -CAkey "$DEST/ca.key" -CAcreateserial -out "$DEST/server.crt" -days 7 -sha256 -extfile "$DEST/extensions.cnf" 2>/dev/null
printf 'Development CA generated in %s. Trust ca.crt explicitly; never disable TLS verification.\n' "$DEST"
