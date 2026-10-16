#!/usr/bin/env bash
# =============================================================================
#  PRINTKIOSK — provision the Pi as a CLOUD print station.
#
#    bash scripts/install-pi-cloud.sh --server https://your-app.onrender.com \
#                                     --token <AGENT_TOKEN> \
#                                     --printer "Your_Queue"
#
#    bash scripts/install-pi-cloud.sh        # reads CLOUD_URL / AGENT_TOKEN / PRINTER_NAME from .env
#
#  THE FLOW THIS BUILDS
#  --------------------
#      phone (any network) ──https──► RENDER ◄──https── Pi: agent.js ──► CUPS ──► printer
#                                   upload            outbound only
#                                   approve
#                                   kiosk screen
#
#  Upload and approval happen on Render. The student types the code on this
#  Pi's touchscreen — which is showing Render's own kiosk page — and Render
#  hands the job to agent.js here, which puts it on paper.
#
#  HOW THIS DIFFERS FROM install-pi.sh
#  -----------------------------------
#  install-pi.sh builds the LOCAL kiosk: server.js runs on the Pi, Chromium
#  opens http://localhost:8080, and the Pi is the whole system. Useful with no
#  internet, wrong for a Render deployment — Render would never be involved,
#  and the two would each hold their own unrelated order list.
#
#  This script instead:
#    - runs agent.js, not server.js (nothing listens on a port here)
#    - points Chromium at the Render URL
#    - verifies the token and that the server really is in cloud mode BEFORE
#      installing anything, because a station that cannot authenticate is a
#      kiosk that takes money and never prints
#    - keeps the agent token in a 0600 EnvironmentFile, not inline in the unit
#      (unit files are world-readable, so an inline token leaks to any local user)
#    - disables the local printkiosk.service if it is installed, so the two
#      cannot both run and confuse you about which order list is real
# =============================================================================

set -uo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

SERVER=""
TOKEN=""
PRINTER=""
NO_BROWSER=0

while [ $# -gt 0 ]; do
  case "$1" in
    --server)     SERVER="${2:-}"; shift 2 ;;
    --token)      TOKEN="${2:-}"; shift 2 ;;
    --printer)    PRINTER="${2:-}"; shift 2 ;;
    --no-browser) NO_BROWSER=1; shift ;;
    -h|--help)    sed -n '3,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1  (try --help)"; exit 1 ;;
  esac
done

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[0;32m%s\033[0m\n' "$*"; }
warn() { printf '    \033[0;33m%s\033[0m\n' "$*"; }
bad()  { printf '    \033[0;31m%s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die()  { printf '\n\033[0;31mERROR:\033[0m %s\n\n' "$*"; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

get_env() { sed -n -E "s/^${1}=(.*)$/\1/p" .env 2>/dev/null | tail -n1; }

KIOSK_USER="${SUDO_USER:-$USER}"

printf '\n\033[1m  PRINTKIOSK — cloud print station\033[0m\n'
info "$APP_DIR"
info "user: $KIOSK_USER"

[ "$(uname -s)" = "Linux" ] || die "This script targets Raspberry Pi OS / Debian."

# ------------------------------------------------------------------ 1. inputs
step "Settings"

[ -z "$SERVER" ]  && SERVER="$(get_env CLOUD_URL)"
[ -z "$SERVER" ]  && SERVER="$(get_env SERVER_URL)"
[ -z "$TOKEN" ]   && TOKEN="$(get_env AGENT_TOKEN)"
[ -z "$PRINTER" ] && PRINTER="$(get_env PRINTER_NAME)"

SERVER="${SERVER%/}"

if [ -z "$SERVER" ]; then
  die "No server URL. Pass it, or put CLOUD_URL in .env:
    bash scripts/install-pi-cloud.sh --server https://your-app.onrender.com --token <AGENT_TOKEN>"
fi
case "$SERVER" in
  https://*|http://*) ;;
  *) die "'$SERVER' is not a URL. It must start with https://" ;;
esac
case "$SERVER" in
  http://*) warn "http:// is unencrypted — student documents cross the network in clear. Use https." ;;
esac
[ -z "$TOKEN" ] && die "No AGENT_TOKEN. Copy it from Render -> your service -> Environment."

ok "server  $SERVER"
ok "token   ${TOKEN:0:6}...  (${#TOKEN} chars)"

# --------------------------------------------------------------- 2. the queue
step "Printer queue"

have lp || die "CUPS is not installed. Run: bash scripts/setup-printer.sh"

if [ -z "$PRINTER" ]; then
  PRINTER="$(lpstat -d 2>/dev/null | sed -n 's/.*: *//p')"
fi
[ -z "$PRINTER" ] && die "No print queue on this Pi. Make one that actually prints first:
    bash scripts/fix-printing.sh"

lpstat -p "$PRINTER" >/dev/null 2>&1 || die "Queue '$PRINTER' does not exist here.
    Queues present: $(lpstat -a 2>/dev/null | awk '{print $1}' | tr '\n' ' ')
    Fix with:  bash scripts/fix-printing.sh"

STATE="$(lpstat -p "$PRINTER" 2>/dev/null | head -n1)"
case "$STATE" in
  *disabled*)
    warn "queue '$PRINTER' is disabled — re-enabling"
    sudo cupsenable "$PRINTER" 2>/dev/null || true
    sudo cupsaccept "$PRINTER" 2>/dev/null || true
    ;;
esac
ok "queue   $PRINTER"
info "$(lpstat -p "$PRINTER" 2>/dev/null | head -n1)"

# The agent must resolve the cups driver, not fall back to mock. A station that
# simulates printing reports every job as a success and no paper ever moves.
DRV="$(PRINTER_NAME="$PRINTER" PRINTER_DRIVER=cups node -e "
import('./src/printer.js').then(async (m) => {
  const i = await m.driverInfo();
  console.log(i.driver + '|' + (i.activePrinter || '') + '|' + i.simulated);
}).catch((e) => { console.log('ERR|' + e.message + '|true'); });
" 2>/dev/null)"
case "$DRV" in
  cups\|*) ok "driver  cups -> $(printf '%s' "$DRV" | cut -d'|' -f2)" ;;
  *) die "The agent would not use CUPS on this machine (got: ${DRV:-nothing}).
    Nothing would print. Check:  node scripts/list-printers.js" ;;
esac

# ------------------------------------------------- 3. prove the cloud end NOW
# Doing this before any install is the whole point: an unauthenticated station
# is a kiosk that releases codes and never prints.
step "Checking the Render deployment before installing anything"

have curl || { sudo apt-get update -qq && sudo apt-get install -y curl; }

HEALTH="$(curl -fsS --max-time 30 "$SERVER/api/health" 2>&1)" \
  || die "Cannot reach $SERVER/api/health

    curl said: $HEALTH

    A free Render service sleeps after 15 minutes idle and can take ~50s to
    wake. Try once in a browser first, then re-run this.
    Also check the URL has no typo and no trailing path."
ok "reachable"

HELLO="$(curl -fsS --max-time 30 -X POST "$SERVER/api/agent/hello" \
  -H 'Content-Type: application/json' \
  -H "X-Agent-Token: $TOKEN" \
  -d "{\"kioskId\":\"install-check\",\"host\":\"$(hostname)\",\"version\":\"install\"}" 2>&1)"

case "$HELLO" in
  *'"ok":true'*) ok "AGENT_TOKEN accepted" ;;
  *)
    bad "the server rejected this token"
    info "response: $HELLO"
    die "AGENT_TOKEN does not match the server's.

    Render -> your service -> Environment -> AGENT_TOKEN. Copy the whole value.
    Note it is NOT the same as ADMIN_TOKEN: ADMIN_TOKEN unlocks /admin for
    staff, AGENT_TOKEN authenticates this print station. Swapping them fails
    exactly like this."
    ;;
esac

# The server tells us its own mode in the hello response. In LOCAL mode it
# prints by itself and will never hand this agent a job — the kiosk would look
# fine and nothing would ever come out here.
case "$HELLO" in
  *'"cloud":true'*)  ok "server is in CLOUD mode — it will hand jobs to this station" ;;
  *'"cloud":false'*)
    bad "that server is in LOCAL mode, so it will never hand this agent a job"
    die "Set CLOUD=true on Render (Environment tab) and redeploy, then re-run.
    Render normally sets RENDER=true which switches this on by itself, so a
    LOCAL reading usually means CLOUD was explicitly set to false."
    ;;
  *) warn "could not read the server's mode from its reply — continuing" ;;
esac

# ---------------------------------------------------------- 4. dependencies
step "Dependencies"

if ! have node; then
  info "installing Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - || die "NodeSource setup failed."
  sudo apt-get install -y nodejs || die "Could not install Node.js."
fi
NODE_MAJOR="$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/')"
[ -n "$NODE_MAJOR" ] && [ "$NODE_MAJOR" -ge 18 ] || die "Node 18+ required (agent.js needs global fetch); found $(node -v 2>&1)."
ok "node $(node -v)"

sudo usermod -aG lpadmin "$KIOSK_USER" 2>/dev/null || true

if [ "$NO_BROWSER" -eq 0 ]; then
  if ! have chromium-browser && ! have chromium; then
    info "installing chromium"
    sudo apt-get update -qq
    sudo apt-get install -y chromium-browser || sudo apt-get install -y chromium || warn "could not install chromium"
  fi
  sudo apt-get install -y unclutter >/dev/null 2>&1 || true
  if   have chromium-browser; then BROWSER_BIN="chromium-browser"
  elif have chromium;         then BROWSER_BIN="chromium"
  else BROWSER_BIN=""; warn "no chromium — the service is still installed, open the page yourself"
  fi
  [ -n "${BROWSER_BIN:-}" ] && ok "browser $BROWSER_BIN"
fi

# ------------------------------------------- 5. stand down the local service
if systemctl list-unit-files 2>/dev/null | grep -q '^printkiosk\.service'; then
  step "Disabling the local-mode service"
  info "printkiosk.service runs server.js on this Pi. In cloud mode Render is"
  info "the server, so leaving both running gives you two unrelated order"
  info "lists and no way to tell which one the dashboard is showing."
  sudo systemctl disable --now printkiosk.service 2>/dev/null || true
  ok "stopped and disabled printkiosk.service (agent service replaces it)"
fi

# ------------------------------------------------------------- 6. the secret
step "Storing the agent token"

# 0600, root-owned, read by systemd — not inline in the unit, which is 0644.
sudo install -m 600 -o root -g root /dev/null /etc/printkiosk-agent.env
sudo tee /etc/printkiosk-agent.env >/dev/null <<ENVFILE
# PRINTKIOSK cloud print station. Written by scripts/install-pi-cloud.sh.
# Mode 0600: AGENT_TOKEN is a credential for the Render deployment.
CLOUD_URL=$SERVER
AGENT_TOKEN=$TOKEN
PRINTER_NAME=$PRINTER
PRINTER_DRIVER=cups
KIOSK_ID=station-$(hostname)
ENVFILE
ok "/etc/printkiosk-agent.env (0600, root only)"

# ------------------------------------------------------------- 7. the service
step "Installing printkiosk-agent.service"

sudo tee /etc/systemd/system/printkiosk-agent.service >/dev/null <<UNIT
[Unit]
Description=PRINTKIOSK cloud print station agent
Documentation=https://github.com/SUDHEER052006/printkiosk-pi
After=network-online.target cups.service
Wants=network-online.target cups.service

[Service]
Type=simple
User=$KIOSK_USER
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
EnvironmentFile=/etc/printkiosk-agent.env
ExecStart=/usr/bin/node $APP_DIR/agent.js
# The agent is a long-poll loop that must never stay down: if it is not running,
# a student can pay, get a code, type it, and get nothing.
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable printkiosk-agent.service
sudo systemctl restart printkiosk-agent.service
ok "enabled and started"

# Confirm it actually connected, rather than assuming systemd starting it is enough.
printf '    waiting for the station to connect'
CONNECTED=0
for _ in $(seq 1 20); do
  if journalctl -u printkiosk-agent -n 40 --no-pager 2>/dev/null | grep -q 'waiting for print jobs'; then
    CONNECTED=1; break
  fi
  if ! systemctl is-active --quiet printkiosk-agent; then break; fi
  printf '.'
  sleep 1
done
printf '\n'

if [ "$CONNECTED" -eq 1 ]; then
  ok "station is connected to $SERVER and waiting for jobs"
else
  bad "the station did not report 'waiting for print jobs' within 20s"
  info "Last log lines:"
  journalctl -u printkiosk-agent -n 20 --no-pager 2>/dev/null | sed 's/^/      /'
  info ""
  info "Follow it with:  sudo journalctl -u printkiosk-agent -f"
fi

# ------------------------------------------------------------ 8. kiosk screen
if [ "$NO_BROWSER" -eq 0 ] && [ -n "${BROWSER_BIN:-}" ]; then
  step "Fullscreen kiosk browser -> $SERVER"

  cat > "$APP_DIR/scripts/kiosk-browser-cloud.sh" <<BROWSER
#!/usr/bin/env bash
# Opens the Render keypad fullscreen. Written by scripts/install-pi-cloud.sh.
#
# The page is served by Render, not this Pi, so the wait below polls the Render
# health endpoint — a free instance can take ~50s to wake from sleep, and
# Chromium opening before that shows an error page the student would be left
# staring at.
xset s off; xset -dpms; xset s noblank
command -v unclutter >/dev/null 2>&1 && unclutter -idle 0.5 -root &

for _ in \$(seq 1 60); do
  curl -sf --max-time 10 "$SERVER/api/health" >/dev/null 2>&1 && break
  sleep 2
done

exec $BROWSER_BIN \\
  --kiosk \\
  --incognito \\
  --noerrdialogs \\
  --disable-infobars \\
  --disable-session-crashed-bubble \\
  --disable-features=TranslateUI \\
  --check-for-update-interval=31536000 \\
  --autoplay-policy=no-user-gesture-required \\
  --touch-events=enabled \\
  "$SERVER/?cursorless"
BROWSER
  chmod +x "$APP_DIR/scripts/kiosk-browser-cloud.sh"

  AUTOSTART_DIR="/home/$KIOSK_USER/.config/autostart"
  mkdir -p "$AUTOSTART_DIR"
  # Replace the local-mode autostart if it is there, so one reboot does not
  # open a keypad pointed at a server that is no longer running.
  rm -f "$AUTOSTART_DIR/printkiosk.desktop"
  cat > "$AUTOSTART_DIR/printkiosk-cloud.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=PrintKiosk (cloud)
Exec=$APP_DIR/scripts/kiosk-browser-cloud.sh
X-GNOME-Autostart-enabled=true
DESKTOP
  ok "Chromium will open $SERVER fullscreen on login"
fi

# --------------------------------------------------------------- 9. hand over
step "Done"
info "station    $SERVER  <- upload and approve here"
info "keypad     this Pi's touchscreen, showing that same URL"
info "queue      $PRINTER"
printf '\n'
info "status     sudo systemctl status printkiosk-agent"
info "logs       sudo journalctl -u printkiosk-agent -f"
info "restart    sudo systemctl restart printkiosk-agent"
printf '\n'
info "Verify the whole flow end to end, with real paper at the end:"
info "  BASE=$SERVER ADMIN_TOKEN=<ADMIN_TOKEN> node scripts/selftest.js"
printf '\n'
info "Then reboot to confirm it all comes back on its own."
printf '\n'
