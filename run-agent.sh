#!/usr/bin/env bash
# Starts the print station agent: takes jobs from the cloud and prints them here.
#
#   bash run-agent.sh                                  # reads CLOUD_URL + AGENT_TOKEN from .env
#   bash run-agent.sh https://your-app.onrender.com TOKEN
#   bash run-agent.sh https://your-app.onrender.com TOKEN Canon_MF240
set -euo pipefail
cd "$(dirname "$0")"

command -v node >/dev/null 2>&1 || { echo "Node 18+ is required. Install it, then run this again."; exit 1; }

ARGS=()
[[ "${1:-}" != "" ]] && ARGS+=(--server "$1")
[[ "${2:-}" != "" ]] && ARGS+=(--token "$2")
[[ "${3:-}" != "" ]] && ARGS+=(--printer "$3")

echo "Available print queues on this machine:"
node scripts/list-printers.js 2>/dev/null || true
echo

exec node agent.js "${ARGS[@]}"
