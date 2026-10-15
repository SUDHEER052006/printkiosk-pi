#!/usr/bin/env bash
# =============================================================================
#  PRINTKIOSK — why is nothing coming out of the printer?
#
#      bash scripts/diagnose-printer.sh
#      bash scripts/diagnose-printer.sh --printer Brother_MFC_T930DW
#      bash scripts/diagnose-printer.sh --no-print     report only, send nothing
#
#  The queue exists and CUPS accepts the job, but no paper appears. This
#  bisects that: it sends the same page by three different routes and reports
#  which ones reach the hardware.
#
#      1. plain text through lp      - the simplest possible CUPS path
#      2. a PDF through lp           - adds the PDF filter chain
#      3. node scripts/testprint.js  - adds PrintKiosk's own options
#
#  Reading the result:
#      none work          -> CUPS, the driver or the hardware. Not PrintKiosk.
#      1 works, 2 doesn't -> the PDF filter chain (cups-filters / Ghostscript)
#      1+2 work, 3 doesn't-> a print option PrintKiosk sends. Our bug.
#      all work           -> the queue is fine; the fault is further up the
#                            kiosk flow (OTP release, agent, cloud mode)
#
#  Nothing here changes configuration except re-enabling a queue that CUPS
#  paused after a failed job, which is the most common cause and is safe.
# =============================================================================

set -uo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

QUEUE=""
DO_PRINT=1

while [ $# -gt 0 ]; do
  case "$1" in
    --printer)  QUEUE="${2:-}"; shift 2 ;;
    --no-print) DO_PRINT=0; shift ;;
    -h|--help)  sed -n '3,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

say()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[0;32m%s\033[0m\n' "$*"; }
warn() { printf '    \033[0;33m%s\033[0m\n' "$*"; }
bad()  { printf '    \033[0;31m%s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

have lp || { echo "CUPS is not installed."; exit 1; }

[ -z "$QUEUE" ] && QUEUE="$(sed -n -E 's/^PRINTER_NAME=(.*)$/\1/p' .env 2>/dev/null | tail -n1)"
[ -z "$QUEUE" ] && QUEUE="$(lpstat -d 2>/dev/null | sed -n 's/.*: *//p')"
[ -z "$QUEUE" ] && QUEUE="$(lpstat -a 2>/dev/null | head -n1 | awk '{print $1}')"

printf '\n\033[1m  PRINTKIOSK printer diagnosis\033[0m\n'
info "queue: ${QUEUE:-<none found>}"

[ -z "$QUEUE" ] && { bad "No queue at all. Run: bash scripts/setup-printer.sh"; exit 1; }

# ------------------------------------------------------------- state of play
say "Queue state"
lpstat -p "$QUEUE" -l 2>&1 | sed 's/^/    /'

say "Device it points at"
lpstat -v "$QUEUE" 2>&1 | sed 's/^/    /'

say "Driver the queue is using"
if [ -r "/etc/cups/ppd/${QUEUE}.ppd" ]; then
  grep -m4 -E '^\*(NickName|Manufacturer|ModelName|cupsFilter)' "/etc/cups/ppd/${QUEUE}.ppd" 2>/dev/null \
    | sed 's/^/    /' || info "(PPD unreadable without sudo)"
else
  info "no PPD at /etc/cups/ppd/${QUEUE}.ppd (driverless queues may not have one)"
fi

say "Is it accepting and enabled?"
STATE="$(lpstat -p "$QUEUE" 2>/dev/null)"
printf '    %s\n' "$STATE"
if printf '%s' "$STATE" | grep -q 'disabled'; then
  warn "The queue is DISABLED. CUPS does this automatically after a failed job,"
  warn "and every job after that silently queues forever. Re-enabling it now."
  sudo cupsenable "$QUEUE" 2>/dev/null || true
  sudo cupsaccept "$QUEUE" 2>/dev/null || true
  ok "re-enabled: $(lpstat -p "$QUEUE" 2>/dev/null | head -n1)"
fi

say "Jobs still in the queue (should be empty)"
lpstat -W not-completed -o "$QUEUE" 2>&1 | sed 's/^/    /' | head -20
info "(nothing listed above = nothing stuck)"

say "ipp-usb (bridges a USB printer to IPP)"
if have systemctl; then
  systemctl is-active ipp-usb >/dev/null 2>&1 \
    && ok "running" \
    || warn "not running - only matters for a USB printer"
fi

ERRLOG=/var/log/cups/error_log
MARK=0
[ -r "$ERRLOG" ] && MARK="$(wc -l < "$ERRLOG" 2>/dev/null || echo 0)"

# ------------------------------------------------------------------- bisect
if [ "$DO_PRINT" -eq 0 ]; then
  say "--no-print given; sending nothing."
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Waits for a job id to leave the queue. Returns 0 if it completed.
wait_job() {
  local jid="$1" n=0
  while [ "$n" -lt 20 ]; do
    lpstat -W not-completed -o "$QUEUE" 2>/dev/null | grep -q "$jid" || return 0
    sleep 1
    n=$((n + 1))
  done
  return 1
}

run_test() {
  local label="$1"; shift
  local out jid
  printf '\n    %s\n' "$label"
  out="$("$@" 2>&1)"
  if [ -n "$out" ]; then printf '      %s\n' "$out"; fi
  jid="$(printf '%s' "$out" | grep -oE '[A-Za-z0-9_-]+-[0-9]+' | head -n1)"
  if [ -z "$jid" ]; then bad "      not accepted by CUPS"; return 1; fi
  if wait_job "$jid"; then
    ok "      left the queue (CUPS says it printed)"
    return 0
  fi
  bad "      STUCK in the queue after 20s"
  return 1
}

say "Test 1 of 3 — plain text, simplest possible path"
printf 'PRINTKIOSK diagnostic page\nTest 1: plain text through lp\n%s\n' "$(date)" > "$TMP/t.txt"
run_test "lp -d $QUEUE t.txt" lp -d "$QUEUE" -o media=A4 "$TMP/t.txt"
R1=$?

say "Test 2 of 3 — a PDF, adds the PDF filter chain"
node -e "
import('./src/pdf.js').then(m=>{
  require('node:fs').writeFileSync(process.argv[1], m.makePdf({title:'PRINTKIOSK diagnostic',pageCount:1,note:'test 2'}));
});" "$TMP/t.pdf" 2>/dev/null
if [ -s "$TMP/t.pdf" ]; then
  run_test "lp -d $QUEUE t.pdf" lp -d "$QUEUE" -o media=A4 "$TMP/t.pdf"
  R2=$?
else
  bad "could not generate the PDF - is node installed?"
  R2=1
fi

say "Test 3 of 3 — through PrintKiosk's own code path"
if node scripts/testprint.js --printer "$QUEUE" >"$TMP/t3.log" 2>&1; then
  ok "testprint.js reported success"
  R3=0
else
  bad "testprint.js failed:"
  tail -12 "$TMP/t3.log" | sed 's/^/      /'
  R3=1
fi

# -------------------------------------------------------------------- report
say "New CUPS errors during these tests"
if [ -r "$ERRLOG" ]; then
  NOW="$(wc -l < "$ERRLOG")"
  if [ "$NOW" -gt "$MARK" ]; then
    tail -n "$((NOW - MARK))" "$ERRLOG" | grep -E '^[EW]' | tail -20 | sed 's/^/    /' \
      || info "(none)"
  else
    info "(none)"
  fi
else
  info "need sudo to read $ERRLOG — run: sudo tail -40 $ERRLOG"
fi

say "Result"
printf '    %-34s %s\n' "1. plain text via lp"      "$([ "$R1" -eq 0 ] && echo PRINTED || echo FAILED)"
printf '    %-34s %s\n' "2. PDF via lp"             "$([ "$R2" -eq 0 ] && echo PRINTED || echo FAILED)"
printf '    %-34s %s\n' "3. PrintKiosk testprint.js" "$([ "$R3" -eq 0 ] && echo PRINTED || echo FAILED)"

printf '\n'
info "Did paper actually come out? CUPS reporting 'printed' only means the job"
info "left the queue - a driver can accept a job and discard it silently."
printf '\n'

if [ "$R1" -ne 0 ]; then
  bad "Nothing reaches the hardware, not even plain text."
  info "This is CUPS, the driver or the printer - PrintKiosk is not involved."
  info "  sudo tail -40 $ERRLOG"
  info "  lpstat -p $QUEUE -l          look for a 'reason' line"
  info "  try another device URI:      bash scripts/setup-printer.sh --list"
elif [ "$R2" -ne 0 ]; then
  bad "Plain text prints, PDF does not: the PDF filter chain is the problem."
  info "  sudo apt install --reinstall cups-filters ghostscript poppler-utils"
elif [ "$R3" -ne 0 ]; then
  bad "lp works, PrintKiosk does not: an option we send is being rejected."
  info "Send me the Test 3 output above - that is our bug to fix."
else
  ok "All three reached the printer."
  info "If paper came out, the queue is healthy: re-run  bash run.sh  and test"
  info "the full upload -> approve -> OTP flow."
  info "If NO paper came out despite all three 'printing', the driver is"
  info "accepting and discarding jobs - try a different URI:"
  info "  bash scripts/setup-printer.sh --list"
fi
printf '\n'
