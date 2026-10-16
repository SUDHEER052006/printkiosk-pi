#!/usr/bin/env bash
# =============================================================================
#  PRINTKIOSK — "the queue exists but nothing printed". Fix it, for good.
#
#      bash scripts/fix-printing.sh              repair, then find what prints
#      bash scripts/fix-printing.sh --report     inspect and repair, print nothing
#      bash scripts/fix-printing.sh --auto       no questions (headless; weaker)
#      bash scripts/fix-printing.sh --name Q     name the queue it ends up making
#
#  WHY THIS EXISTS
#  ---------------
#  setup-printer.sh creates a queue as soon as `lpadmin` accepts the device.
#  That is not the same thing as printing. lpadmin succeeds whenever it can
#  reach the device and build a PPD, so a queue can be created, enabled and
#  accepting jobs while the driver behind it silently discards every page.
#  CUPS then reports the job "completed" and no paper moves. That gap is this
#  whole bug, and no amount of log reading closes it: the only authority on
#  whether a (transport, driver) pair works is a sheet of paper.
#
#  So this script stops guessing. It:
#
#    1. repairs the five conditions that silently eat jobs on a Pi
#         - cups-browsed auto-queues pointing at implicitclass:// (swallow all)
#         - a queue CUPS paused after one failed job (everything queues forever)
#         - jobs left held or stuck by the previous attempt
#         - ipp-usb not running, so a USB printer has no IPP route at all
#         - a missing PDF filter chain: text prints, every PDF vanishes
#    2. enumerates every transport the printer actually offers
#    3. builds the (transport x driver) matrix, best first
#    4. PRINTS A PROBE PAGE on each combination and asks you: did paper come out?
#    5. pins the first combination that physically printed as the real queue,
#       with A4 and mono defaults, then proves it through printFile().
#
#  It writes a full transcript to PRINTER-FIX-REPORT.txt. If every combination
#  fails, that file names the reason and what to do about it.
#
#  Safe to re-run. It only adds a queue, re-enables a paused one, and removes
#  cups-browsed's own auto-created duplicates.
# =============================================================================

set -uo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

NAME=""
AUTO=0
REPORT_ONLY=0
MAX_PROBES="${MAX_PROBES:-10}"
REPORT="$APP_DIR/PRINTER-FIX-REPORT.txt"

while [ $# -gt 0 ]; do
  case "$1" in
    --name)    NAME="${2:-}"; shift 2 ;;
    --auto)    AUTO=1; shift ;;
    --report)  REPORT_ONLY=1; shift ;;
    --max)     MAX_PROBES="${2:-10}"; shift 2 ;;
    -h|--help) sed -n '3,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1  (try --help)"; exit 1 ;;
  esac
done

# ------------------------------------------------------------------- output
# Everything shown is also recorded, without colour, so one file can be sent on.
: > "$REPORT"
log() { printf '%s\n' "$*" >> "$REPORT"; }

say()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; log ""; log "==> $*"; }
ok()   { printf '    \033[0;32m%s\033[0m\n' "$*"; log "    [ok] $*"; }
warn() { printf '    \033[0;33m%s\033[0m\n' "$*"; log "    [warn] $*"; }
bad()  { printf '    \033[0;31m%s\033[0m\n' "$*"; log "    [FAIL] $*"; }
info() { printf '    %s\n' "$*"; log "    $*"; }
have() { command -v "$1" >/dev/null 2>&1; }

# Runs a command and shows its output indented, in both places.
show() {
  local out
  out="$("$@" 2>&1)" || true
  if [ -n "$out" ]; then
    printf '%s\n' "$out" | sed 's/^/      /'
    printf '%s\n' "$out" | sed 's/^/      /' >> "$REPORT"
  fi
  return 0
}

# askyn <question> -> 0 yes, 1 no, 2 stop asking
askyn() {
  local q="$1" r=""
  if [ "$AUTO" -eq 1 ] || [ ! -r /dev/tty ]; then return 1; fi
  while :; do
    printf '\n    \033[1m%s\033[0m\n    [y = paper came out / n = nothing / s = stop] ' "$q"
    read -r r < /dev/tty || r="n"
    case "$r" in
      y|Y|yes|YES) log "    ANSWER: yes, paper came out"; return 0 ;;
      n|N|no|NO|'') log "    ANSWER: no paper";            return 1 ;;
      s|S|skip)    log "    ANSWER: stop";                 return 2 ;;
    esac
  done
}

printf '\n\033[1m  PRINTKIOSK — fix printing\033[0m\n'
log "PRINTKIOSK printer repair — $(date)"
log "host: $(uname -a 2>/dev/null)"
info "$APP_DIR"
info "transcript: $REPORT"

[ "$(uname -s)" = "Linux" ] || { bad "This script targets Raspberry Pi OS / Debian."; exit 1; }
have lp || { bad "CUPS is not installed. Run: bash scripts/setup-printer.sh"; exit 1; }

get_env() { sed -n -E "s/^${1}=(.*)$/\1/p" .env 2>/dev/null | tail -n1; }

# =============================================================== 1. repairs
say "Repair pass — the five things that silently eat print jobs"

# --- (a) CUPS itself -------------------------------------------------------
if have systemctl; then
  systemctl is-active --quiet cups || sudo systemctl enable --now cups 2>/dev/null || true
  if systemctl is-active --quiet cups; then ok "cups is running"; else warn "cups is NOT running"; fi
fi
info "scheduler: $(lpstat -r 2>&1)"

# --- (b) cups-browsed: the silent swallower -------------------------------
#
# cups-browsed watches the network and creates its own queues pointing at
# implicitclass://<name>/ — a CUPS class it then populates. When it cannot (a
# USB printer behind ipp-usb, or a printer that stopped advertising), the queue
# still exists, still accepts jobs, and nothing ever prints them. It also races
# setup-printer.sh for the queue name. On a single-printer kiosk it buys nothing
# and costs exactly this bug.
BROWSED_OFF=0
if have systemctl && systemctl is-active --quiet cups-browsed 2>/dev/null; then
  warn "cups-browsed is running — it auto-creates queues that can swallow jobs"
  sudo systemctl stop cups-browsed    2>/dev/null || true
  sudo systemctl disable cups-browsed 2>/dev/null || true
  BROWSED_OFF=1
  ok "stopped and disabled it (a kiosk wants one explicit queue, not discovery)"
else
  ok "cups-browsed not running"
fi

# Remove any implicitclass:// queue it left behind. Those are not real queues.
for q in $(lpstat -v 2>/dev/null | awk '/implicitclass/{print $3}' | tr -d ':'); do
  warn "removing cups-browsed queue '$q' (implicitclass:// — never prints)"
  sudo lpadmin -x "$q" 2>/dev/null || true
done

# --- (c) paused queues, held and stuck jobs -------------------------------
QUEUES="$(lpstat -a 2>/dev/null | awk '{print $1}')"
if [ -n "$QUEUES" ]; then
  for q in $QUEUES; do
    st="$(lpstat -p "$q" 2>/dev/null | head -n1)"
    case "$st" in
      *disabled*)
        warn "queue '$q' is DISABLED — CUPS paused it after a failed job"
        info "  everything sent since then has been queueing, not printing"
        show lpstat -p "$q" -l
        sudo cupsenable "$q" 2>/dev/null || true
        sudo cupsaccept "$q" 2>/dev/null || true
        ok "  re-enabled"
        ;;
      *) ok "queue '$q': enabled" ;;
    esac
  done

  HELD="$(lpstat -W not-completed -o 2>/dev/null | grep -c . || true)"
  if [ "${HELD:-0}" != "0" ]; then
    warn "$HELD job(s) still sitting in the queues, from the failed attempt"
    show lpstat -W not-completed -l -o
    sudo cancel -a -x 2>/dev/null || sudo cancel -a 2>/dev/null || true
    ok "purged them, so a probe page is unambiguous"
  else
    ok "no jobs stuck in any queue"
  fi
else
  warn "no queues exist yet"
fi

# --- (d) ipp-usb: a USB printer's only driverless route -------------------
if have systemctl; then
  if ! dpkg -s ipp-usb >/dev/null 2>&1 && have apt-get; then
    warn "ipp-usb is not installed — a USB printer has no driverless route"
    sudo apt-get install -y ipp-usb >/dev/null 2>&1 || warn "could not install ipp-usb"
  fi
  sudo systemctl enable ipp-usb  2>/dev/null || true
  sudo systemctl restart ipp-usb 2>/dev/null || true
  sleep 2
  if systemctl is-active --quiet ipp-usb; then
    ok "ipp-usb running (restarted, so it re-scanned the USB bus)"
  else
    warn "ipp-usb not active — harmless for a network printer, fatal for USB driverless"
  fi
  systemctl is-active --quiet avahi-daemon || sudo systemctl enable --now avahi-daemon 2>/dev/null || true
fi

if have lsusb; then
  info "printer-looking USB devices the kernel sees:"
  show sh -c "lsusb | grep -iE 'canon|hewlett|hp|brother|epson|samsung|lexmark|kyocera|ricoh|printer' || echo '(none)'"
fi

# --- (e) the PDF filter chain --------------------------------------------
# PrintKiosk prints PDFs. A missing rasteriser is the one failure that lets
# plain text print while every PDF disappears without an error anywhere.
MISSING=""
for b in gs pdftops pdftoppm; do have "$b" || MISSING="$MISSING $b"; done
if [ -n "$MISSING" ]; then
  warn "PDF filter chain incomplete, missing:$MISSING"
  if have apt-get; then
    if sudo apt-get install -y ghostscript poppler-utils cups-filters >/dev/null 2>&1; then
      ok "installed ghostscript / poppler-utils / cups-filters"
    else
      warn "could not install them — PDFs may not render"
    fi
  fi
else
  ok "PDF filter chain present (ghostscript + poppler)"
fi

# =========================================================== 2. transports
say "Every transport this printer offers"

parse_devices() {
  awk '
    function emit() { printf "%s\t%s\t%s\n", uri, mm, did }
    /^Device:/ {
      if (seen) emit()
      t = $0; sub(/^Device:[ \t]*uri[ \t]*=[ \t]*/, "", t); uri = t
      mm = ""; did = ""; seen = 1; next
    }
    /^[ \t]*make-and-model[ \t]*=/ { t=$0; sub(/^[ \t]*make-and-model[ \t]*=[ \t]*/,"",t); mm=t; next }
    /^[ \t]*device-id[ \t]*=/      { t=$0; sub(/^[ \t]*device-id[ \t]*=[ \t]*/,"",t);      did=t; next }
    END { if (seen) emit() }
  '
}

# How good is this transport? Lower is better. A dnssd:// URI must be judged by
# its service type, not its scheme: the same printer advertises several and they
# are not interchangeable. _printer._tcp is LPD on port 515, and for a USB
# printer bridged by ipp-usb nothing listens there at all.
rank_of() {
  case "$1" in
    *_ipps._tcp*)           echo 0 ;;
    *_ipp._tcp*)            echo 1 ;;
    ipps://*)               echo 2 ;;
    ipp://*)                echo 3 ;;
    usb://*)                echo 4 ;;
    *_pdl-datastream._tcp*) echo 6 ;;
    socket://*)             echo 7 ;;
    *_printer._tcp*)        echo 8 ;;
    lpd://*)                echo 9 ;;
    dnssd://*)              echo 6 ;;
    *)                      echo 9 ;;
  esac
}

name_from_uri() {
  printf '%s' "$1" \
    | sed -e 's|^[a-z]*://||' -e 's|\._[a-z-]*\._tcp.*$||' -e 's|[?/].*$||' \
          -e 's|%20| |g' -e 's|%2520| |g' -e 's|+| |g' \
          -e 's|[[:space:]]*([Uu][Ss][Bb])[[:space:]]*| |g' \
          -e 's|^[[:space:]]*||' -e 's|[[:space:]]*$||'
}

CANDIDATES=""
add_cand() {
  CANDIDATES="${CANDIDATES}$(rank_of "$1")|$1|$2|${3:-}
"
}

if have driverless; then
  info "driverless — what CUPS can drive with no vendor driver at all:"
  DL="$(driverless 2>/dev/null | grep -oE '(ipps?|dnssd)://[^ ]+' || true)"
  if [ -n "$DL" ]; then
    show printf '%s\n' "$DL"
    while IFS= read -r u; do
      [ -n "$u" ] && add_cand "$u" "$(name_from_uri "$u")" ""
    done <<CAND_DL
$DL
CAND_DL
  else
    info "      (none — there is no IPP Everywhere route to this printer)"
  fi
else
  warn "the 'driverless' command is missing (install cups-ipp-utils)"
fi

info "lpinfo -v — everything CUPS can reach:"
LP="$(lpinfo -l -v 2>/dev/null | parse_devices | grep -vE '^(file|cups-brf|cups-pdf|beh|hpfax|scsi|smb):' || true)"
if [ -n "$LP" ]; then
  while IFS="$(printf '\t')" read -r u m d; do
    [ -z "$u" ] && continue
    if [ -z "$m" ] || [ "$m" = "Unknown" ]; then m="$(name_from_uri "$u")"; fi
    info "      $u"
    info "        model: ${m:-unknown}"
    info "        id:    ${d:-none}"
    add_cand "$u" "$m" "$d"
  done <<CAND_LP
$LP
CAND_LP
else
  info "      (nothing)"
fi

# Whatever the existing queue points at belongs in the matrix too: it may be the
# right transport paired with the wrong driver, which is the likeliest case of all.
OLDQ="$(get_env PRINTER_NAME)"
OLDURI=""
if [ -n "$OLDQ" ]; then
  OLDURI="$(lpstat -v "$OLDQ" 2>/dev/null | sed -n 's/.*: *//p')"
  if [ -n "$OLDURI" ]; then
    info "the queue install.sh made ('$OLDQ') points at:"
    info "      $OLDURI"
    add_cand "$OLDURI" "$(name_from_uri "$OLDURI")" ""
  fi
fi

RANKED="$(printf '%s' "$CANDIDATES" | grep -v '^$' | sort -t'|' -k1,1n | awk -F'|' '!seen[$2]++')"

if [ -z "$RANKED" ]; then
  bad "No transport to the printer at all."
  info ""
  info "The printer is not reachable, so no driver can help. In order:"
  info "  lsusb                           is the device on the USB bus?"
  info "  sudo systemctl status ipp-usb   a USB printer needs this bridge"
  info "  driverless                      should list an ipp:// URI"
  info "  ping <printer-ip>               network printer on this subnet?"
  info ""
  info "For a Wi-Fi printer: turn AirPrint / Mopria ON in the printer's own"
  info "menu — many ship with it off — then re-run this script."
  log "VERDICT: no transport found"
  exit 1
fi

# ============================================================= 3. the matrix
say "Driver candidates"

# Best PPDs CUPS can pair with this exact device, best first.
match_ppds() {
  local did="$1" mdl="$2" out="" key
  if [ -n "$did" ]; then
    out="$(lpinfo --device-id "$did" -m 2>/dev/null | awk '{print $1}' | head -n3)"
  fi
  if [ -z "$out" ] && [ -n "$mdl" ]; then
    key="$(printf '%s' "$mdl" | awk '{print $2}')"
    [ -z "$key" ] && key="$(printf '%s' "$mdl" | awk '{print $1}')"
    if [ -n "$key" ]; then
      out="$(lpinfo -m 2>/dev/null | grep -i -- "$key" | awk '{print $1}' | head -n3)"
    fi
  fi
  printf '%s' "$out"
}

vendor_packages() {
  case "$(printf '%s' "$1" | tr 'A-Z' 'a-z')" in
    *hp*|*hewlett*)                echo "hplip printer-driver-hpcups" ;;
    *brother*)                     echo "printer-driver-brlaser printer-driver-ptouch" ;;
    *epson*|*seiko*)               echo "printer-driver-escpr printer-driver-escpr2" ;;
    *samsung*|*xerox*|*dell*)      echo "printer-driver-splix printer-driver-foo2zjs" ;;
    *canon*)                       echo "printer-driver-gutenprint printer-driver-c2esp printer-driver-foo2zjs" ;;
    *lexmark*|*konica*|*minolta*)  echo "printer-driver-foo2zjs" ;;
    *) echo "printer-driver-gutenprint foomatic-db" ;;
  esac
}

# MATRIX lines: uri|ppd|label
MATRIX=""
add_combo() {
  case "$MATRIX" in
    *"$1|$2|"*) return ;;
  esac
  MATRIX="${MATRIX}$1|$2|$3
"
}

MFG_SEEN=""

while IFS='|' read -r rank uri mm did; do
  [ -z "$uri" ] && continue
  MFG="$(printf '%s' "$did" | tr ';' '\n' | sed -n 's/^\(MFG\|MANUFACTURER\):\(.*\)$/\2/p' | head -n1)"
  [ -z "$MFG" ] && MFG="$(printf '%s' "$mm" | awk '{print $1}')"
  [ -n "$MFG" ] && MFG_SEEN="$MFG"

  # 1. Driverless, where the transport supports it. No vendor driver, so it is
  #    architecture-independent — the only route that can work on ARM for a
  #    printer whose vendor ships x86-only binaries.
  case "$uri" in
    ipp://*|ipps://*|dnssd://*_ipp*|dnssd://*_ipps*)
      add_combo "$uri" "everywhere" "driverless (IPP Everywhere)" ;;
  esac

  # 2. A PPD matched to the device's own IEEE-1284 id.
  for p in $(match_ppds "$did" "${mm:-}"); do
    [ -n "$p" ] && add_combo "$uri" "$p" "PPD matched to the device"
  done
done <<MATRIX_1
$RANKED
MATRIX_1

# 3. Install the vendor's driver package, then re-match.
if have apt-get; then
  PKGS="$(vendor_packages "${MFG_SEEN:-generic}")"
  info "installing driver packages for '${MFG_SEEN:-unknown make}': $PKGS"
  # shellcheck disable=SC2086
  if sudo apt-get install -y $PKGS >/dev/null 2>&1; then ok "installed"; else warn "some were unavailable"; fi
  while IFS='|' read -r rank uri mm did; do
    [ -z "$uri" ] && continue
    for p in $(match_ppds "$did" "${mm:-}"); do
      [ -n "$p" ] && add_combo "$uri" "$p" "PPD from an installed driver package"
    done
  done <<MATRIX_2
$RANKED
MATRIX_2
fi

# 4. Generic fallbacks, last. textonly is not a real driver — it is a probe. If
#    textonly prints and nothing else does, the transport is sound and this
#    printer has no graphics driver on this architecture. That is a verdict, not
#    a failure, and it is worth one sheet of paper to learn it.
BESTURI="$(printf '%s\n' "$RANKED" | head -n1 | cut -d'|' -f2)"
add_combo "$BESTURI" "drv:///sample.drv/generic.ppd"  "generic PostScript"
add_combo "$BESTURI" "drv:///sample.drv/textonly.ppd" "text-only (transport probe)"

MATRIX="$(printf '%s' "$MATRIX" | grep -v '^$')"
NCOMBO="$(printf '%s\n' "$MATRIX" | grep -c '|' || true)"

i=0
while IFS='|' read -r u p l; do
  [ -z "$u" ] && continue
  i=$((i + 1))
  info "[$i] $l"
  info "     driver $p"
  info "     device $u"
done <<MATRIX_SHOW
$MATRIX
MATRIX_SHOW
info ""
info "$NCOMBO combination(s) to try, best first."

if [ "$REPORT_ONLY" -eq 1 ]; then
  say "--report given: repaired and inspected, printed nothing."
  info "Transcript: $REPORT"
  exit 0
fi

# =============================================================== 4. probing
say "Probing — one page per combination, until paper comes out"
info "Load A4 paper. Watch the printer. Answer honestly: CUPS saying"
info "'completed' proves nothing; a sheet of paper proves everything."

TMP="$(mktemp -d)"
PROBE_Q="PK_PROBE"
cleanup() {
  sudo lpadmin -x "$PROBE_Q" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

# The probe PDF is built by PrintKiosk's own generator, so the probe exercises
# the same bytes the kiosk will later send.
cat > "$TMP/mk.mjs" <<'PROBE_MJS'
import fs from 'node:fs';
const { makePdf } = await import('file://' + process.env.PK_ROOT + '/src/pdf.js');
fs.writeFileSync(process.env.PK_OUT, makePdf({
  title: 'PRINTKIOSK probe page',
  pageCount: 1,
  note: 'If this is on paper, this driver and transport work.',
}));
PROBE_MJS
PK_ROOT="$APP_DIR" PK_OUT="$TMP/probe.pdf" node "$TMP/mk.mjs" >>"$REPORT" 2>&1 || true
if [ -s "$TMP/probe.pdf" ]; then
  ok "probe PDF built with src/pdf.js ($(wc -c < "$TMP/probe.pdf" | tr -d ' ') bytes)"
else
  warn "could not build the probe PDF with src/pdf.js — probing with plain text"
fi
printf 'PRINTKIOSK probe page\n\nIf you are reading this on paper, this\ncombination works.\n\n%s\n' \
  "$(date)" > "$TMP/probe.txt"

# wait_for_job <queue> <jobid> -> 0 it left the queue, 1 still stuck
wait_for_job() {
  local q="$1" jid="$2" n=0
  while [ "$n" -lt 30 ]; do
    lpstat -W not-completed -o "$q" 2>/dev/null | grep -q "$jid" || return 0
    sleep 1
    n=$((n + 1))
  done
  return 1
}

WINNER_URI=""
WINNER_PPD=""
WINNER_LABEL=""
ATTEMPT=0
STOPPED=0
TEXTONLY_PRINTED=0

while IFS='|' read -r uri ppd label; do
  [ -z "$uri" ] && continue
  [ "$STOPPED" -eq 1 ] && break
  ATTEMPT=$((ATTEMPT + 1))
  if [ "$ATTEMPT" -gt "$MAX_PROBES" ]; then
    warn "stopping after $MAX_PROBES combinations (raise it with --max N)"
    break
  fi

  say "Probe $ATTEMPT of $NCOMBO — $label"
  info "driver $ppd"
  info "device $uri"

  sudo lpadmin -x "$PROBE_Q" 2>/dev/null || true
  ERR="$(sudo lpadmin -p "$PROBE_Q" -E -v "$uri" -m "$ppd" 2>&1)"
  if [ -n "$ERR" ]; then
    bad "lpadmin refused this combination: $ERR"
    continue
  fi

  sudo cupsenable "$PROBE_Q" 2>/dev/null || true
  sudo cupsaccept "$PROBE_Q" 2>/dev/null || true
  # abort-job, not the default stop-printer: a failure must surface here rather
  # than pause the queue and leave every later probe queueing behind it.
  sudo lpadmin -p "$PROBE_Q" -o printer-error-policy=abort-job 2>/dev/null || true
  ok "queue created"

  case "$ppd" in
    *textonly*) FILE="$TMP/probe.txt" ;;
    *)          FILE="$TMP/probe.pdf"; [ -s "$FILE" ] || FILE="$TMP/probe.txt" ;;
  esac

  OUT="$(lp -d "$PROBE_Q" -o media=A4 -o fit-to-page "$FILE" 2>&1)"
  info "lp: $OUT"
  JID="$(printf '%s' "$OUT" | grep -oE "${PROBE_Q}-[0-9]+" | head -n1)"

  if [ -z "$JID" ]; then
    bad "CUPS would not even accept the job"
    continue
  fi

  printf '    waiting up to 30s for the job to leave the queue'
  if wait_for_job "$PROBE_Q" "$JID"; then
    printf '\n'
    ok "job $JID left the queue"
  else
    printf '\n'
    bad "job $JID is STUCK — this transport does not deliver to the hardware"
    show lpstat -W not-completed -l -o "$PROBE_Q"
    sudo cancel -a -x "$PROBE_Q" 2>/dev/null || true
    continue
  fi

  sleep 2
  askyn "Did a page actually come out of the printer?"
  case $? in
    0)
      WINNER_URI="$uri"; WINNER_PPD="$ppd"; WINNER_LABEL="$label"
      case "$ppd" in *textonly*) TEXTONLY_PRINTED=1 ;; esac
      break
      ;;
    2) STOPPED=1; break ;;
    *) info "noted — trying the next combination" ;;
  esac
done <<PROBE_LOOP
$MATRIX
PROBE_LOOP

# ================================================================ 5. verdict
if [ -z "$WINNER_URI" ]; then
  say "No combination printed"

  if [ "$AUTO" -eq 1 ]; then
    info "--auto cannot confirm that paper moved, so this is inconclusive."
    info "Re-run interactively:  bash scripts/fix-printing.sh"
    log "VERDICT: inconclusive (--auto cannot confirm paper)"
    exit 2
  fi

  bad "Every transport and driver this machine can offer was tried."
  info ""
  info "That narrows it to one of three things, and the transcript says which."
  info ""
  info "  A. The printer is host-based ('GDI', 'winprinter')."
  info "     Canon UFR II LT and CAPT, and some Samsung and Lexmark models, put"
  info "     the rendering in a closed driver shipped as x86-only binaries. A"
  info "     Raspberry Pi is ARM, so that driver cannot run here at all and no"
  info "     configuration fixes it. Two ways out:"
  info "       - Connect the printer by Wi-Fi and turn AirPrint / Mopria ON in"
  info "         the printer's own menu. That makes it an IPP Everywhere device"
  info "         and the driverless route starts working. Then re-run this."
  info "       - Or keep the Pi as the kiosk and print from an x86 mini-PC:"
  info "         install the vendor driver there and run PrintKiosk's agent"
  info "         (bash run-agent.sh <url> <token> <queue>). Nothing else changes."
  info ""
  info "  B. The printer is in an error state it never reported to CUPS."
  info "     Empty tray, cartridge not seated, lid ajar, a panel prompt waiting"
  info "     for OK, or a tray set to Letter while every job asks for A4."
  info "     Clear it at the printer itself, then re-run."
  info ""
  info "  C. The cable or the port. A charge-only USB cable, or a hub that"
  info "     drops the device. Plug the printer straight into the Pi with a"
  info "     data cable and re-run."
  info ""
  info "Quickest discriminator — did the text-only probe print?"
  info "  text printed, nothing else  -> A, certainly. The transport is fine."
  info "  nothing printed at all      -> B or C."
  info ""
  info "Transcript to send on:  $REPORT"
  log "VERDICT: no combination produced paper"
  exit 1
fi

# =============================================================== 6. pin it
say "Found it"
ok "$WINNER_LABEL"
info "driver $WINNER_PPD"
info "device $WINNER_URI"
log "VERDICT: WORKS — $WINNER_LABEL | $WINNER_PPD | $WINNER_URI"

if [ "$TEXTONLY_PRINTED" -eq 1 ]; then
  warn "Only the text-only driver printed. That queue cannot render a PDF, so"
  warn "it is not usable for the kiosk — but it proves the transport is sound"
  warn "and this printer has no graphics driver for ARM. Read verdict A above:"
  info "  turn on AirPrint / Mopria and connect by Wi-Fi, or print via agent.js"
  info "  from an x86 machine that has the vendor driver."
  info ""
  info "Transcript: $REPORT"
  log "VERDICT: transport OK, no ARM graphics driver (text-only)"
  exit 1
fi

if [ -z "$NAME" ]; then
  NAME="$(printf '%s\n' "$RANKED" | grep -F "|$WINNER_URI|" | head -n1 | cut -d'|' -f3)"
  NAME="$(printf '%s' "$NAME" | sed -e 's/[^A-Za-z0-9]\+/_/g' -e 's/^_//' -e 's/_$//' | cut -c1-40)"
  [ -z "$NAME" ] && NAME="PrintKiosk"
fi

say "Creating the real queue: $NAME"
sudo lpadmin -x "$NAME" 2>/dev/null || true
ERR="$(sudo lpadmin -p "$NAME" -E -v "$WINNER_URI" -m "$WINNER_PPD" 2>&1)"
if [ -n "$ERR" ]; then
  bad "could not create '$NAME': $ERR"
  info "The combination works, so create it by hand with:"
  info "  sudo lpadmin -p $NAME -E -v '$WINNER_URI' -m '$WINNER_PPD'"
  exit 1
fi

sudo cupsenable "$NAME" 2>/dev/null || true
sudo cupsaccept "$NAME" 2>/dev/null || true
sudo lpadmin -d "$NAME" 2>/dev/null || true
# A4 is what the pricing model assumes, so make it the queue default too.
sudo lpadmin -p "$NAME" -o media-default=iso_a4_210x297mm      2>/dev/null || true
sudo lpadmin -p "$NAME" -o print-color-mode-default=monochrome 2>/dev/null || true
# retry-current-job, not abort-job: on the live kiosk a transient glitch should
# survive a retry rather than discard a page a student has already paid for.
sudo lpadmin -p "$NAME" -o printer-error-policy=retry-current-job 2>/dev/null || true
ok "enabled, accepting, A4 + mono by default, set as the system default"
info "$(lpstat -p "$NAME" 2>/dev/null | head -n1)"

# Remove the dead queue the earlier run left behind, if it is a different one.
if [ -n "$OLDQ" ] && [ "$OLDQ" != "$NAME" ]; then
  warn "removing the earlier queue '$OLDQ', which never printed"
  sudo lpadmin -x "$OLDQ" 2>/dev/null || true
fi

say "Pinning PRINTER_NAME in .env"
touch .env
if grep -q '^PRINTER_NAME=' .env 2>/dev/null; then
  sed -i "s|^PRINTER_NAME=.*|PRINTER_NAME=$NAME|" .env
else
  printf '\n# Set by scripts/fix-printing.sh — the combination that physically printed.\nPRINTER_NAME=%s\n' "$NAME" >> .env
fi
grep -q '^PRINTER_DRIVER=' .env 2>/dev/null || printf 'PRINTER_DRIVER=cups\n' >> .env
ok "PRINTER_NAME=$NAME"

# ========================================================= 7. prove the path
say "Proving it through PrintKiosk's own printFile()"
if node scripts/testprint.js --printer "$NAME" 2>&1 | tee -a "$REPORT"; then
  ok "testprint.js completed"
else
  bad "testprint.js failed even though lp works — that is a PrintKiosk bug."
  info "Send on $REPORT"
  exit 1
fi

askyn "Did the PrintKiosk test page come out too?"
RC=$?
if [ "$RC" -eq 0 ] || [ "$AUTO" -eq 1 ]; then
  say "Done — printing works end to end"
  log "RESULT: end-to-end confirmed"
  info "Start the kiosk:    bash run.sh"
  info "Install at boot:    bash install.sh --service"
  [ "$BROWSED_OFF" -eq 1 ] && info "cups-browsed was disabled on purpose. Leave it off."
  info ""
  info "Then: upload from a phone -> approve in /admin -> type the OTP at the kiosk."
  printf '\n'
  exit 0
fi

bad "lp printed but PrintKiosk's own page did not."
info "That is an option PrintKiosk sends being rejected by this driver."
info "Narrow it with:  bash scripts/diagnose-printer.sh --printer $NAME"
info "and send on $REPORT"
exit 1
