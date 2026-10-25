#!/usr/bin/env bash
# Start the artwork service (API + workers) for local development on Omarchy.
set -euo pipefail

cd "$(dirname "$0")/.."

: "${ARTWORK_SERVICE_TOKEN:?Set ARTWORK_SERVICE_TOKEN to a secret of at least 16 characters}"
export ARTWORK_DATA_DIR="${ARTWORK_DATA_DIR:-$HOME/.local/share/metal-craft-artwork/dev}"
export ARTWORK_PORT="${ARTWORK_PORT:-8766}"

uv sync --frozen
exec uv run --frozen python -m artwork_service serve
