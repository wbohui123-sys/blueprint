#!/usr/bin/env bash
# Local source gate. The pre-commit path checks the staged diff; pre-push runs the full suite.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$#" == 1 && "$1" == --staged ]]; then
  git diff --cached --check
elif [[ "$#" == 0 ]]; then
  node app/scripts/orchestration-check.mjs --full
else
  echo "Usage: scripts/preflight.sh [--staged]" >&2
  exit 2
fi
