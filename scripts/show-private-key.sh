#!/usr/bin/env bash
# Prints private.pem so you can paste it into GitHub → Secrets → PRIVATE_KEY.
# Never commit this file's output or paste it into issues/PRs.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEY="$ROOT/private.pem"

if [[ ! -f "$KEY" ]]; then
  echo "error: $KEY not found"
  echo "Generate with OpenSSL 3+:"
  echo "  openssl genpkey -algorithm ed25519 -out private.pem"
  exit 1
fi

echo "────────────────────────────────────────────────────────"
echo " Copy EVERYTHING below into GitHub secret: PRIVATE_KEY"
echo " Repo → Settings → Secrets and variables → Actions"
echo "────────────────────────────────────────────────────────"
echo
cat "$KEY"
echo
echo "────────────────────────────────────────────────────────"
