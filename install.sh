#!/usr/bin/env bash
# =============================================================================
#  PRINTKIOSK — one file, clone to printing.
#
#      git clone https://github.com/SUDHEER052006/printkiosk-pi.git
#      cd printkiosk-pi
#      bash install.sh
#
#  Does every bring-up step a fresh clone needs, in order, and is safe to
#  re-run:
#    1. Node.js 18+            (installs 20.x from NodeSource if missing/old)
#    2. project dependencies   (there are none — verified, not assumed)
#    3. .env                   gitignored, so a clone has none: created here,
#                              UPI ID asked for, ADMIN_TOKEN generated
#    4. printer                detect, install its driver, create the queue
#    5. test page              through the same code path the kiosk uses
#    6. boot service           optional, --service
#    7. start                  hands over to run.sh
#
#  Options
#      --upi you@bank     UPI ID, instead of being asked
#      --name "Lab Name"  payee name shown on the QR
#      --sim              no printer; simulate printing (laptop demo only)
#      --service          install the systemd boot service, then exit
#      --no-start         provision only, do not launch
#      --yes, -y          never prompt; fail instead of asking
#      --port N           serve on this port (default 8080)
# =============================================================================

set -uo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

UPI=""
PAYEE=""
PORT="${PORT:-8080}"
SIM=0
DO_SERVICE=0
DO_START=1
ASSUME_YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --upi)      UPI="${2:-}"; shift 2 ;;
    --name)     PAYEE="${2:-}"; shift 2 ;;
    --port)     PORT="${2:-}"; shift 2 ;;
    --sim)      SIM=1; shift ;;
    --service)  DO_SERVICE=1; shift ;;
    --no-start) DO_START=0; shift ;;
    --yes|-y)   ASSUME_YES=1; shift ;;
    -h|--help)  sed -n '3,27p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1  (try --help)"; exit 1 ;;
  esac
done

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[0;32m%s\033[0m\n' "$*"; }
warn() { printf '    \033[0;33m%s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die()  { printf '\n\033[0;31mERROR:\033[0m %s\n\n' "$*"; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

ask() {
  # ask <prompt> <default> -> echoes the answer
  local prompt="$1" def="${2:-}" reply=""
  if [ "$ASSUME_YES" -eq 1 ] || [ ! -t 0 ]; then printf '%s' "$def"; return; fi
  read -r -p "    $prompt" reply < /dev/tty || reply=""
  printf '%s' "${reply:-$def}"
}

# Writes KEY=VALUE into .env, touching exactly one line.
#
# Subtler than it looks. .env.example documents cloud settings in prose blocks
# that contain lines like "#   ADMIN_TOKEN=<random>   required in cloud mode".
# A naive sed replaces those too, which both duplicates the key and destroys the
# documentation. So: prefer a live `KEY=` line; failing that, uncomment only a
# *simple* `# KEY=` default (at most one space); never touch indented prose.
# Rewrites via awk rather than `sed -i` so no value needs delimiter escaping.
set_env() {
  local key="$1" val="$2" mode="any"
  touch .env
  grep -qE "^${key}=" .env && mode="live"
  awk -v k="$key" -v v="$val" -v mode="$mode" '
    BEGIN { done = 0 }
    !done {
      if (mode == "live" && $0 ~ "^" k "=")        { print k "=" v; done = 1; next }
      if (mode == "any"  && $0 ~ "^#[ \t]?" k "=") { print k "=" v; done = 1; next }
    }
    { print }
    END { if (!done) print k "=" v }
  ' .env > .env.tmp && mv .env.tmp .env
}

get_env() { sed -n -E "s/^${1}=(.*)$/\1/p" .env 2>/dev/null | tail -n1; }

rand_token() {
  if have openssl; then openssl rand -hex 24; return; fi
  if [ -r /dev/urandom ]; then
    head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; return
  fi
  date +%s%N | sha256sum | cut -c1-48
}

printf '\n\033[1m  PRINTKIOSK installer\033[0m\n'
info "$APP_DIR"

case "$(uname -s)" in
  Linux)  OS=linux ;;
  Darwin) OS=mac ;;
  *) die "This installer targets Linux (Raspberry Pi OS / Debian) and macOS.
    On Windows, run:  run.bat" ;;
esac

if have apt-get; then PKG=apt; elif have dnf; then PKG=dnf; elif have brew; then PKG=brew; else PKG=""; fi
install_pkg() {
  case "$PKG" in
    apt)  sudo apt-get install -y "$@" ;;
    dnf)  sudo dnf install -y "$@" ;;
    brew) brew install "$@" ;;
    *)    return 1 ;;
  esac
}

# ------------------------------------------------------------------ 1. Node.js
step "Node.js"

node_major() { node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/'; }

NEED_NODE=0
if ! have node; then
  NEED_NODE=1
  info "not installed"
else
  MAJ="$(node_major)"
  case "$MAJ" in
    ''|*[!0-9]*) NEED_NODE=1; info "version unreadable" ;;
    *) if [ "$MAJ" -lt 18 ]; then NEED_NODE=1; info "v$MAJ is too old (need 18+)"; fi ;;
  esac
fi

if [ "$NEED_NODE" -eq 1 ]; then
  if [ "$PKG" = "apt" ]; then
    info "installing Node.js 20.x from NodeSource"
    have curl || { sudo apt-get update -qq; sudo apt-get install -y curl; }
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - \
      || die "NodeSource setup failed. Install Node 18+ by hand, then re-run."
    sudo apt-get install -y nodejs || die "Could not install Node.js."
  elif [ "$PKG" = "brew" ]; then
    brew install node@20 || die "Could not install Node.js."
  else
    die "Node 18+ is required and I cannot install it on this system.
    Get it from https://nodejs.org/ then re-run this script."
  fi
  hash -r
fi

MAJ="$(node_major)"
[ -n "$MAJ" ] && [ "$MAJ" -ge 18 ] || die "Node 18+ still not available (found: $(node -v 2>&1))."
ok "node $(node -v)"

# ------------------------------------------------------------ 2. dependencies
step "Project dependencies"

# PrintKiosk is deliberately dependency-free. Check rather than trust the claim:
# if someone adds a dependency later, this installs it instead of silently
# shipping a broken clone.
HAS_DEPS="$(node -e "const p=require('./package.json');process.stdout.write(String(Object.keys(p.dependencies||{}).length))" 2>/dev/null || echo 0)"
if [ "${HAS_DEPS:-0}" != "0" ]; then
  info "$HAS_DEPS dependency(ies) declared — running npm install"
  npm install --no-audit --no-fund || die "npm install failed."
  ok "dependencies installed"
else
  ok "none declared (zero-dependency project)"
fi

# -------------------------------------------------------------------- 3. .env
step "Configuration (.env)"

if [ -f .env ]; then
  ok ".env already exists — keeping it, filling only what is missing"
else
  if [ -f .env.example ]; then
    cp .env.example .env
    ok "created .env from .env.example"
  else
    touch .env
    ok "created an empty .env"
  fi
fi

# --- UPI ID: the one value nobody can guess for you. ---
CUR_UPI="$(get_env UPI_VPA)"
case "$CUR_UPI" in
  ''|yourname@ybl|*example*) CUR_UPI="" ;;
esac

if [ -z "$UPI" ] && [ -z "$CUR_UPI" ] && [ "$SIM" -eq 0 ]; then
  info "Students pay to a UPI ID, and it is not in the repo (gitignored)."
  UPI="$(ask 'Your UPI ID (e.g. 9876543210@ybl): ' '')"
fi

UPI="${UPI:-$CUR_UPI}"

if [ -n "$UPI" ]; then
  if printf '%s' "$UPI" | grep -qE '^[A-Za-z0-9._-]+@[A-Za-z][A-Za-z0-9]{1,}$'; then
    set_env UPI_VPA "$UPI"
    ok "UPI_VPA=$UPI"
  else
    die "'$UPI' does not look like a UPI ID (expected something@bank).
    Re-run with:  bash install.sh --upi you@ybl"
  fi
elif [ "$SIM" -eq 1 ]; then
  warn "no UPI ID set — fine for --sim, but required before students use it"
else
  warn "no UPI ID set. Payments will not work until you add one:"
  info "  bash install.sh --upi you@ybl"
fi

[ -n "$PAYEE" ] && { set_env UPI_NAME "$PAYEE"; ok "UPI_NAME=$PAYEE"; }

# --- Staff approval token: without it, /admin can only approve from the kiosk. ---
if [ -z "$(get_env ADMIN_TOKEN)" ]; then
  TOKEN="$(rand_token)"
  set_env ADMIN_TOKEN "$TOKEN"
  ok "generated ADMIN_TOKEN (lets staff approve from their own phone)"
  info "$TOKEN"
  info "Keep this. Staff need it at /admin from any device but the kiosk."
else
  ok "ADMIN_TOKEN already set"
fi

# --- Safe defaults for a real deployment. ---
set_env PAYMENT_MODE "${PAYMENT_MODE:-upi_manual}"
if [ "$SIM" -eq 1 ]; then
  set_env SIM_ENABLED true
  warn "SIM_ENABLED=true — free printing. Turn this off before students use it."
else
  set_env SIM_ENABLED false
  ok "SIM_ENABLED=false (the free-print simulator is off)"
fi

# .env now holds a UPI ID and the staff approval token: owner-only.
chmod 600 .env 2>/dev/null || true

# ----------------------------------------------------------------- 4. printer
step "Printer"

if [ "$SIM" -eq 1 ]; then
  warn "--sim given: skipping the printer. No paper will move."
elif [ "$OS" != "linux" ]; then
  warn "Printer auto-setup is Linux-only. On macOS add it in System Settings,"
  info "then:  node scripts/list-printers.js"
else
  # setup-printer.sh does the real work: detects whatever is attached, reads its
  # make/model, installs the matching driver, creates the queue, pins
  # PRINTER_NAME in .env. --no-test because we run the test page ourselves below.
  if bash scripts/setup-printer.sh --yes --no-test; then
    ok "printer queue ready: $(get_env PRINTER_NAME)"
  else
    warn "Printer setup did not complete."
    info "Diagnose with:  bash scripts/setup-printer.sh --list"
    info "Or run without a printer for now:  bash install.sh --sim"
    if [ "$(ask 'Continue anyway? [y/N] ' 'N')" != "y" ]; then
      die "Stopped. Fix the printer, then re-run this script."
    fi
  fi
fi

# --------------------------------------------------------------- 5. test page
QUEUE="$(get_env PRINTER_NAME)"
if [ "$SIM" -eq 0 ] && [ -n "$QUEUE" ]; then
  step "Test page"
  if node scripts/testprint.js --printer "$QUEUE"; then
    ok "hardware confirmed — the kiosk uses this same printFile()"
  else
    warn "The test page did not print. The queue exists but the hardware path fails."
    info "lpstat -t   and   sudo tail -40 /var/log/cups/error_log"
  fi
fi

# ----------------------------------------------------------------- 6. service
if [ "$DO_SERVICE" -eq 1 ]; then
  step "Boot service"
  bash scripts/install-pi.sh "$QUEUE"
  step "Installed as a service"
  info "sudo systemctl status printkiosk     check it"
  info "sudo journalctl -u printkiosk -f     follow the log"
  exit 0
fi

# ------------------------------------------------------------------- 7. start
step "Ready"
info "config    .env"
[ -n "$QUEUE" ] && info "printer   $QUEUE"
info "port      $PORT"
printf '\n'
info "Re-run anytime:  bash install.sh"
info "Self-test:       npm run selftest    (needs the server running)"

if ! id -nG "$USER" 2>/dev/null | tr ' ' '\n' | grep -qx lpadmin; then
  [ "$SIM" -eq 0 ] && [ "$OS" = "linux" ] && \
    warn "You were added to the 'lpadmin' group — log out and back in (or reboot)
    if printing is refused on a later run."
fi

if [ "$DO_START" -eq 0 ]; then
  step "Not starting (--no-start). When you are ready:"
  info "bash run.sh"
  exit 0
fi

step "Starting PrintKiosk"
if [ "$SIM" -eq 1 ]; then
  exec bash run.sh --port "$PORT" --sim
else
  exec bash run.sh --port "$PORT"
fi
