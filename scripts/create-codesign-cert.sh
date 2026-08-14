#!/bin/bash
# create-codesign-cert.sh — create the local code-signing certificate used to
# sign the nanobot desktop app. Run once per machine; the certificate lives in
# the login keychain and keeps the app identity stable across re-builds so that
# macOS notification permission survives re-signing.
set -euo pipefail

CONFIG="/tmp/nanobot-codesign-openssl.cnf"
KEY="/tmp/nanobot-codesign.key"
CRT="/tmp/nanobot-codesign.crt"
P12="/tmp/nanobot-codesign.p12"
PASS="${NANOBOT_CERT_PASS:-nanobot123}"

cat > "$CONFIG" << 'EOF'
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = nanobot-local-codesign
[v3]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
EOF

openssl req -x509 -newkey rsa:2048 -keyout "$KEY" -out "$CRT" -days 3650 -nodes -config "$CONFIG"
openssl pkcs12 -export -out "$P12" -inkey "$KEY" -in "$CRT" -password "pass:$PASS"
security import "$P12" -k ~/Library/Keychains/login.keychain-db -P "$PASS" -T /usr/bin/codesign

echo "done. identity:"
security find-identity -p codesigning 2>/dev/null | grep -i nanobot || true
