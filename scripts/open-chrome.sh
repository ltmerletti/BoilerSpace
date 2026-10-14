#!/bin/sh
# Opens Chrome for Testing with BoilerSpace loaded, using its own profile in .chrome-profile/.
# Regular Chrome ignores --load-extension, so this uses the Playwright-installed Chrome for Testing.
# Launched through `open` so the window does not close when the terminal that started it exits.
set -e

root="$(cd "$(dirname "$0")/.." && pwd)"
app="${CHROME_APP:-$(ls -d "$HOME"/Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/"Google Chrome for Testing.app" 2>/dev/null | sort -V | tail -1)}"

if [ ! -d "$app" ]; then
  echo "Chrome for Testing not found. Set CHROME_APP to the .app bundle." >&2
  exit 1
fi

mkdir -p "$root/.chrome-profile"
open -n -a "$app" --args \
  --user-data-dir="$root/.chrome-profile" \
  --load-extension="$root/extension" \
  --no-first-run \
  --no-default-browser-check \
  "https://purdue.brightspace.com/d2l/home"
echo "Opened Chrome for Testing with BoilerSpace (profile: $root/.chrome-profile)"
