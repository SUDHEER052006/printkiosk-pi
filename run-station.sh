#!/usr/bin/env bash
# =============================================================================
#  PRINTKIOSK — run this Pi as the print station. One command.
#
#      bash run-station.sh                       # reads settings from .env
#      bash run-station.sh https://your-app.onrender.com <AGENT_TOKEN>
#      bash run-station.sh --no-browser          # agent only, no kiosk screen
#      bash run-station.sh --printer "Queue"     # pin a queue for this run
#
#  WHAT THIS IS FOR
#  ----------------
#      phone (any network) ──https──► RENDER ◄──https── THIS PI ──► CUPS ──► printer
#                                   upload            outbound only
#                                   approve
#
#  Upload and approval happen on Render. This Pi does two things and nothing
#  else: it shows the OTP keypad fullscreen, and it prints the jobs Render
#  hands it. No server runs here, nothing listens on a port, no port
#  forwarding — the Pi makes all the connections itself.
#
#  Both halves run from this one command and stop together on Ctrl+C. Nothing
#  is installed; for a Pi that should come up printing after a power cut, use
#      bash scripts/install-pi-cloud.sh --server ... --token ...
#
#  It checks the things that otherwise fail silently BEFORE opening the kiosk
#  screen, because every one of them looks identical to a student: a keypad
#  that takes the code and never produces paper.
# =============================================================================

set -uo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

SERVER=""
TOKEN=""
PRINTER=""
NO_BROWSER=0

# Bare URL and token as positional arguments, like run-agent.sh takes them.
while [ $# -gt 0 ]; do
  case "$1" in
    --server)     SERVER="${2:-}"; shift 2 ;;
    --token)      TOKEN="${2:-}"; shift 2 ;;
    --printer)    PRINTER="${2:-}"; shift 2 ;;
    --no-browser) NO_BROWSER=1; shift ;;
    -h|--help)    sed -n '3,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    http://*|https://*) if [ -z "$SERVER" ]; then SERVER="$1"; else TOKEN="$1"; fi; shift ;;
    *) if [ -z "$TOKEN" ]; then TOKEN="$1"; else PRINTER="$1"; fi; shift ;;
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

set_env() {
  local key="$1" val="$2"
  touch .env
  if grep -qE "^${key}=" .env; then
    awk -v k="$key" -v v="$val" '
      BEGIN{d=0} !d && $0 ~ "^" k "=" {print k "=" v; d=1; next} {print}
    ' .env > .env.tmp && mv .env.tmp .env
  else
    printf '%s=%s\n' "$key" "$val" >> .env
  fi
}

printf '\n\033[1m  PRINTKIOSK print station\033[0m\n'
info "$APP_DIR"

# ------------------------------------------------------------------ 1. inputs
step "Settings"

[ -z "$SERVER" ]  && SERVER="$(get_env CLOUD_URL)"
[ -z "$SERVER" ]  && SERVER="$(get_env SERVER_URL)"
[ -z "$TOKEN" ]   && TOKEN="$(get_env AGENT_TOKEN)"
[ -z "$PRINTER" ] && PRINTER="$(get_env PRINTER_NAME)"
SERVER="${SERVER%/}"

if [ -z "$SERVER" ] || [ -z "$TOKEN" ]; then
  die "This station needs your Render URL and its AGENT_TOKEN.

    bash run-station.sh https://your-app.onrender.com <AGENT_TOKEN>

    Both come from Render -> your service -> Environment. They are saved to
    .env on the first successful run, so later runs need no arguments."
fi
case "$SERVER" in
  https://*) ;;
  http://*)  warn "http:// is unencrypted — student documents cross the network in clear" ;;
  *) die "'$SERVER' is not a URL; it must start with https://" ;;
esac

ok "server   $SERVER"
ok "token    ${TOKEN:0:6}...  (${#TOKEN} chars)"

have node || die "Node.js is not installed. Run: bash install.sh"
NODE_MAJOR="$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/')"
[ -n "$NODE_MAJOR" ] && [ "$NODE_MAJOR" -ge 18 ] \
  || die "Node 18+ required (agent.js needs global fetch); found $(node -v 2>&1)."
ok "node     $(node -v)"

# ----------------------------------------------------------------- 2. printer
step "Printer on this Pi"

if have lp; then
  [ -z "$PRINTER" ] && PRINTER="$(lpstat -d 2>/dev/null | sed -n 's/.*: *//p')"
  if [ -z "$PRINTER" ]; then
    die "No print queue on this Pi, so nothing can come out of it.
    Make one that actually prints:  bash scripts/fix-printing.sh"
  fi
  lpstat -p "$PRINTER" >/dev/null 2>&1 || die "Queue '$PRINTER' does not exist here.
    Present: $(lpstat -a 2>/dev/null | awk '{print $1}' | tr '\n' ' ')
    Fix with:  bash scripts/fix-printing.sh"

  # A queue CUPS paused after a failed job accepts everything and prints
  # nothing, which from the keypad is indistinguishable from working.
  case "$(lpstat -p "$PRINTER" 2>/dev/null | head -n1)" in
    *disabled*)
      warn "queue '$PRINTER' was paused by CUPS — re-enabling"
      sudo cupsenable "$PRINTER" 2>/dev/null || true
      sudo cupsaccept "$PRINTER" 2>/dev/null || true
      ;;
  esac
  ok "queue    $PRINTER"
else
  warn "CUPS not found — this station cannot print. Continuing anyway."
fi

# The agent must land on the cups driver. If it falls back to mock it reports
# every job as a success while no paper moves, and the dashboard looks healthy.
DRV="$(PRINTER_NAME="$PRINTER" PRINTER_DRIVER="${PRINTER_DRIVER:-cups}" node -e "
import('./src/printer.js').then(async (m) => {
  const i = await m.driverInfo();
  console.log(i.driver + '|' + (i.activePrinter || '') + '|' + i.printers.length);
}).catch((e) => { console.log('ERR|' + e.message + '|0'); });
" 2>/dev/null)"
DRV_ID="$(printf '%s' "$DRV" | cut -d'|' -f1)"
DRV_Q="$(printf '%s' "$DRV" | cut -d'|' -f2)"
DRV_N="$(printf '%s' "$DRV" | cut -d'|' -f3)"

# cups with no queue at all is not a working station. PRINTER_DRIVER=cups is
# obeyed even where CUPS is absent, so the driver name alone proves nothing —
# a station like that accepts every code and prints nothing.
if [ "$DRV_ID" = "cups" ] && [ -z "$DRV_Q" ] && [ "${DRV_N:-0}" = "0" ]; then
  die "CUPS is selected but this machine has no print queue at all.

    The station would accept codes and print nothing. Make a queue that
    actually prints:  bash scripts/fix-printing.sh"
fi

case "$DRV" in
  cups\|*) ok "driver   cups -> ${DRV_Q:-(system default)}" ;;
  mock\|*) die "The agent would SIMULATE printing on this machine, not print.

    Every job would be reported as a success and no paper would move.
    PRINTER_DRIVER is set to mock, or CUPS is not reachable. Check:
      grep PRINTER_DRIVER .env
      node scripts/list-printers.js" ;;
  *) die "Could not work out the print driver (got: ${DRV:-nothing}).
    Check:  node scripts/list-printers.js" ;;
esac

# ------------------------------------------- 3. prove the Render end is right
# All three of these failures look the same from the keypad, so none of them
# may be discovered by a student standing at the kiosk.
step "Checking Render before opening the keypad"

have curl || { sudo apt-get update -qq && sudo apt-get install -y curl; }

HEALTH="$(curl -fsS --max-time 60 "$SERVER/api/health" 2>&1)" || die "Cannot reach $SERVER

    curl said: $HEALTH

    A free Render service sleeps after 15 minutes idle and can take ~50s to
    wake — open the URL in a browser once, then re-run. Otherwise check the
    URL for a typo."
ok "reachable"

HELLO="$(curl -fsS --max-time 30 -X POST "$SERVER/api/agent/hello" \
  -H 'Content-Type: application/json' -H "X-Agent-Token: $TOKEN" \
  -d "{\"kioskId\":\"preflight\",\"host\":\"$(hostname)\",\"version\":\"run-station\"}" 2>&1)"

case "$HELLO" in
  *'"ok":true'*) ok "AGENT_TOKEN accepted" ;;
  *) bad "the server rejected this token"
     info "response: $HELLO"
     die "AGENT_TOKEN does not match the server's.

    Render -> Environment -> AGENT_TOKEN, copied whole. It is NOT ADMIN_TOKEN:
    ADMIN_TOKEN unlocks /admin for staff, AGENT_TOKEN authenticates this
    station. Swapping the two fails exactly like this." ;;
esac

case "$HELLO" in
  *'"cloud":true'*) ok "server is in CLOUD mode — it will hand jobs to this station" ;;
  *'"cloud":false'*)
    bad "that server is in LOCAL mode"
    die "In LOCAL mode the server prints by itself and will never hand this
    station a job — the keypad would accept codes and nothing would print.

    Set CLOUD=true on Render (Environment) and redeploy, then re-run." ;;
  *) warn "could not read the server's mode from its reply — continuing" ;;
esac

# Remember a working configuration so the next run is argument-free.
set_env CLOUD_URL "$SERVER"
set_env AGENT_TOKEN "$TOKEN"
[ -n "$PRINTER" ] && set_env PRINTER_NAME "$PRINTER"
grep -q '^PRINTER_DRIVER=' .env 2>/dev/null || set_env PRINTER_DRIVER cups
chmod 600 .env 2>/dev/null || true
ok "saved to .env — next time just:  bash run-station.sh"

# ------------------------------------------------------------- 4. the agent
step "Starting the print station"

AGENT_PID=""
BROWSER_PID=""

cleanup() {
  printf '\n'
  [ -n "$BROWSER_PID" ] && kill "$BROWSER_PID" 2>/dev/null
  [ -n "$AGENT_PID" ]   && kill "$AGENT_PID"   2>/dev/null
  wait 2>/dev/null
  printf '\033[1;34m==>\033[0m station stopped\n\n'
}
trap cleanup EXIT INT TERM

CLOUD_URL="$SERVER" AGENT_TOKEN="$TOKEN" PRINTER_NAME="$PRINTER" \
PRINTER_DRIVER="${PRINTER_DRIVER:-cups}" KIOSK_ID="station-$(hostname)" \
  node agent.js --server "$SERVER" --token "$TOKEN" ${PRINTER:+--printer "$PRINTER"} &
AGENT_PID=$!

# Do not open the keypad until the station is genuinely collecting jobs: a
# keypad that is up before the agent is a keypad that can take a code it
# cannot fulfil.
printf '    waiting for the station to connect'
CONNECTED=0
for _ in $(seq 1 40); do
  ONLINE="$(curl -fsS --max-time 10 "$SERVER/api/health" 2>/dev/null \
    | tr ',' '\n' | grep -m1 '"online"' || true)"
  case "$ONLINE" in *true*) CONNECTED=1; break ;; esac
  kill -0 "$AGENT_PID" 2>/dev/null || { printf '\n'; die "The agent exited during startup — see its output above."; }
  printf '.'
  sleep 1
done
printf '\n'

if [ "$CONNECTED" -eq 1 ]; then
  ok "station is online and collecting jobs"
else
  warn "the server has not reported this station online yet"
  info "It may still connect; watch the agent output below."
fi

# --------------------------------------------------------- 5. the OTP keypad
if [ "$NO_BROWSER" -eq 0 ]; then
  step "Opening the OTP keypad"

  # Over SSH there is no DISPLAY, but the Pi's own desktop is usually :0.
  if [ -z "${DISPLAY:-}" ] && [ -e /tmp/.X11-unix/X0 ]; then
    export DISPLAY=:0
    info "no DISPLAY set — using the Pi's desktop (:0)"
  fi

  if   have chromium-browser; then BROWSER_BIN="chromium-browser"
  elif have chromium;         then BROWSER_BIN="chromium"
  elif have firefox;          then BROWSER_BIN="firefox"
  else BROWSER_BIN=""
  fi

  if [ -z "${DISPLAY:-}" ]; then
    warn "no graphical display — not opening the keypad"
    info "Open this on the touchscreen yourself:  $SERVER/"
  elif [ -z "$BROWSER_BIN" ]; then
    warn "no browser installed"
    info "sudo apt-get install -y chromium-browser    then re-run"
    info "Meanwhile open:  $SERVER/"
  else
    xset s off        2>/dev/null || true   # no screen blanking at a kiosk
    xset -dpms        2>/dev/null || true
    xset s noblank    2>/dev/null || true
    have unclutter && (unclutter -idle 0.5 -root >/dev/null 2>&1 &)

    case "$BROWSER_BIN" in
      chromium*)
        "$BROWSER_BIN" \
          --kiosk --incognito --noerrdialogs --disable-infobars \
          --disable-session-crashed-bubble --disable-features=TranslateUI \
          --check-for-update-interval=31536000 \
          --autoplay-policy=no-user-gesture-required \
          --touch-events=enabled \
          "$SERVER/?cursorless" >/dev/null 2>&1 &
        ;;
      firefox)
        "$BROWSER_BIN" --kiosk "$SERVER/" >/dev/null 2>&1 &
        ;;
    esac
    BROWSER_PID=$!
    ok "$BROWSER_BIN fullscreen on $SERVER/"
    info "Quit kiosk mode with Alt+F4, or Ctrl+C here."
  fi
fi

# ------------------------------------------------------------------ 6. in use
step "Running"
info "upload     $SERVER/upload          <- the student's phone, any network"
info "approve    $SERVER/admin           <- staff, needs ADMIN_TOKEN once"
info "keypad     this Pi's touchscreen"
info "printer    ${PRINTER:-(system default)}"
printf '\n'
info "The code is typed here; the job comes to this Pi and prints."
info "If the station drops out, a code is refused with \"station is offline\""
info "and stays valid — nobody loses a print they paid for."
printf '\n'
printf '    \033[1mPress Ctrl+C to stop the station and the keypad.\033[0m\n\n'

wait "$AGENT_PID"
