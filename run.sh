#!/usr/bin/env bash
# =============================================================================
#  PRINTKIOSK — one command to run everything
#
#    bash run.sh                      real printing on the default printer
#    bash run.sh --printer "Canon_MF240"
#    bash run.sh --upi you@okhdfcbank
#    bash run.sh --install            also install Node + CUPS if missing
#    bash run.sh --service            install as a boot service and exit
#    bash run.sh --sim                no printer; simulate (opt-in)
#
#  Prints for real by default. If no printer is found it stops and tells you
#  how to add one, rather than quietly simulating and looking like it worked.
# =============================================================================

set -uo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

PORT="${PORT:-8080}"
PRINTER=""
UPI="${UPI_VPA:-}"
DO_INSTALL=0
DO_SERVICE=0
MODE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --printer) PRINTER="${2:-}"; shift 2 ;;
    --upi)     UPI="${2:-}"; shift 2 ;;
    --port)    PORT="${2:-}"; shift 2 ;;
    --install) DO_INSTALL=1; shift ;;
    --service) DO_SERVICE=1; DO_INSTALL=1; shift ;;
    --sim)     MODE="mock"; shift ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

say()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '    \033[0;32m%s\033[0m\n' "$*"; }
warn() { printf '    \033[0;33m%s\033[0m\n' "$*"; }
die()  { printf '\n\033[0;31mERROR:\033[0m %s\n\n' "$*"; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------- dependencies
say "Checking dependencies"

if have apt-get; then PKG="apt-get"; elif have dnf; then PKG="dnf"; elif have brew; then PKG="brew"; else PKG=""; fi

install_pkg() {
  case "$PKG" in
    apt-get) sudo apt-get install -y "$@" ;;
    dnf)     sudo dnf install -y "$@" ;;
    brew)    brew install "$@" ;;
    *)       return 1 ;;
  esac
}

if ! have node; then
  if [ "$DO_INSTALL" -eq 1 ] && [ "$PKG" = "apt-get" ]; then
    say "Installing Node.js 20"
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - \
      && sudo apt-get install -y nodejs
  else
    die "Node.js is not installed. Re-run with --install, or:
      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
      sudo apt-get install -y nodejs"
  fi
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" -ge 18 ] || die "Node 18+ required, found $(node --version)."
ok "node $(node --version)"

# This project has no npm dependencies on purpose; nothing to install.
ok "npm packages: none required"

# ------------------------------------------------------------------- printing
if [ "$MODE" = "mock" ]; then
  warn "Simulation requested — no paper will move."
else
  say "Checking the printer"

  # --- CUPS present? ---
  if ! have lp; then
    if [ "$DO_INSTALL" -eq 1 ] && [ -n "$PKG" ]; then
      say "Installing CUPS"
      [ "$PKG" = "apt-get" ] && sudo apt-get update -qq
      install_pkg cups cups-filters || die "Could not install CUPS."
      sudo usermod -aG lpadmin "$USER" 2>/dev/null || true
      sudo systemctl enable --now cups 2>/dev/null || true
      hash -r
    elif [ "$(uname -s)" = "Darwin" ]; then
      : # macOS ships CUPS
    else
      die "CUPS is not installed, so nothing can print.

    Install it:        bash run.sh --install
    Or by hand:        sudo apt install -y cups cups-filters
                       sudo usermod -aG lpadmin \$USER   (then log out and back in)

    To run without a printer anyway:   bash run.sh --sim"
    fi
  fi

  # --- is the daemon actually up? ---
  if have systemctl && ! systemctl is-active --quiet cups 2>/dev/null; then
    warn "The CUPS service is not running — starting it"
    sudo systemctl start cups 2>/dev/null || true
    sleep 1
  fi

  # --- pick a queue ---
  if [ -z "$PRINTER" ]; then
    PRINTER="$(lpstat -d 2>/dev/null | sed -n 's/.*: *//p')"
  fi
  if [ -z "$PRINTER" ]; then
    PRINTER="$(lpstat -a 2>/dev/null | head -n1 | awk '{print $1}')"
    [ -n "$PRINTER" ] && warn "No default queue set; using the first one found."
  fi

  if [ -z "$PRINTER" ]; then
    die "CUPS is running but no printer is set up.

    Add one:   open http://localhost:631  ->  Administration  ->  Add Printer
               (plug the printer in and switch it on first)
    Then:      lpoptions -d YOUR_QUEUE_NAME
    Check:     lpstat -a

    To run without a printer anyway:   bash run.sh --sim"
  fi

  # --- is that queue accepting jobs? ---
  if lpstat -a "$PRINTER" 2>/dev/null | grep -q 'not accepting'; then
    warn "Queue '$PRINTER' is not accepting jobs. Trying to enable it."
    sudo cupsenable "$PRINTER" 2>/dev/null || true
    sudo accept "$PRINTER" 2>/dev/null || true
  fi

  export PRINTER_DRIVER=cups
  ok "cups is running"
  ok "printer: $PRINTER"
  ok "queues:  $(lpstat -a 2>/dev/null | awk '{print $1}' | paste -sd, - 2>/dev/null)"
fi

[ -n "$UPI" ] && ok "upi: $UPI"

# -------------------------------------------------------------------- service
if [ "$DO_SERVICE" -eq 1 ]; then
  say "Installing boot service"
  bash "$APP_DIR/scripts/install-pi.sh" "$PRINTER"
  exit 0
fi

# ---------------------------------------------------------------------- start
export PORT
[ -n "$PRINTER" ] && export PRINTER_NAME="$PRINTER"
[ -n "$UPI" ] && export UPI_VPA="$UPI" && export PAYMENT_MODE="${PAYMENT_MODE:-upi_manual}"
[ "$MODE" = "mock" ] && export PRINTER_DRIVER=mock

# Free the port if a previous run is still holding it.
if have lsof && lsof -ti:"$PORT" >/dev/null 2>&1; then
  warn "Port $PORT is busy — stopping the old instance"
  lsof -ti:"$PORT" | xargs -r kill 2>/dev/null || true
  sleep 1
fi

say "Starting PrintKiosk on port $PORT"
node server.js &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT INT TERM

# ------------------------------------------------------------------ readiness
printf '    waiting for the agent'
for _ in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    printf '\n'
    ok "agent is up"
    break
  fi
  kill -0 "$SERVER_PID" 2>/dev/null || { printf '\n'; die "The agent exited during startup — see the output above."; }
  printf '.'
  sleep 0.5
done

curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 || die "Agent did not come up within 20s."

# ------------------------------------------------------------------ open a tab
DASH="http://localhost:$PORT/admin"
say "Opening the dashboard"
if   have xdg-open;      then xdg-open "$DASH" >/dev/null 2>&1 &
elif have open;          then open "$DASH" >/dev/null 2>&1 &
elif have powershell.exe; then powershell.exe -NoProfile -Command "Start-Process '$DASH'" >/dev/null 2>&1 &
elif have cmd.exe;       then cmd.exe /c start "" "$DASH" >/dev/null 2>&1 &
elif have explorer.exe;  then explorer.exe "$DASH" >/dev/null 2>&1 &
else warn "No browser opener found — open $DASH yourself."
fi

printf '\n    Kiosk screen : http://localhost:%s/\n' "$PORT"
printf '    Upload page  : http://localhost:%s/upload\n' "$PORT"
printf '    Dashboard    : http://localhost:%s/admin\n' "$PORT"

if [ "$MODE" != "mock" ]; then
  printf '\n    Printer not behaving? In another terminal:\n'
  printf '      node scripts/testprint.js --printer "%s"\n' "$PRINTER"
fi

printf '\n    \033[1mPress Ctrl+C to stop.\033[0m\n\n'
wait "$SERVER_PID"
