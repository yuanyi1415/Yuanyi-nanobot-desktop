#!/bin/bash
# sign-app.sh — sign the built nanobot desktop app with the stable local
# code-signing certificate "nanobot-local-codesign".
#
# Why: Electron >= 42 uses the UNNotification API, which silently drops
# notifications for unsigned apps (electron#47817). Ad-hoc signatures worked but
# macOS treats each re-signed bundle as a new app and resets notification
# permission. A stable certificate keeps the identity (wiki.nanobot.desktop)
# across re-builds, so permission granted once stays granted.
#
# The certificate was created once via scripts/create-codesign-cert.sh and lives
# in the login keychain. Run this after every fresh copy/install of the bundle.
#
# Usage: scripts/sign-app.sh [path-to-nanobot.app]
set -euo pipefail

APP="${1:-/Applications/nanobot.app}"
CONTENTS="$APP/Contents"
IDENTITY="nanobot-local-codesign"

echo "signing $APP with $IDENTITY ..."

# Frameworks (main binaries live under Versions/A)
for fw in "$CONTENTS"/Frameworks/*.framework; do
  base="$(basename "$fw" .framework)"
  if [ -f "$fw/Versions/A/$base" ]; then
    codesign --force --sign "$IDENTITY" "$fw/Versions/A/$base"
  fi
done

# Helper apps
for h in "$CONTENTS"/Frameworks/*.app; do
  codesign --force --sign "$IDENTITY" "$h"
done

# Main executable and bundle
codesign --force --sign "$IDENTITY" "$CONTENTS/MacOS/nanobot"
codesign --force --sign "$IDENTITY" "$APP"

echo "done. verify:"
codesign -dv "$APP" 2>&1 | grep -E "Identifier|flags" || true
