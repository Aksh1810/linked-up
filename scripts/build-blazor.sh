#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf artifacts/browser .vercel/output/static
if ! command -v dotnet >/dev/null 2>&1; then
  migration_sdk="$PWD/.cache/dotnet"
  mkdir -p "$migration_sdk"
  curl --fail --silent --show-error --location https://dot.net/v1/dotnet-install.sh -o "$migration_sdk/install.sh"
  bash "$migration_sdk/install.sh" --version 10.0.300 --install-dir "$migration_sdk" --no-path
  export DOTNET_ROOT="$migration_sdk"
  export PATH="$migration_sdk:$PATH"
fi
npm --prefix browser ci
npm --prefix browser run build
node scripts/configure-browser.mjs browser/wwwroot/appsettings.json
dotnet publish browser/LinkedUp.Client.csproj -c Release -o artifacts/browser /p:UseAppHost=false
grep -q '"../appsettings.json"' artifacts/browser/wwwroot/_framework/dotnet.js
mkdir -p .vercel/output/static
cp -R artifacts/browser/wwwroot/. .vercel/output/static/
