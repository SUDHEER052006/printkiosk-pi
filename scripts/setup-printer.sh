#!/usr/bin/env bash
# =============================================================================
#  PRINTKIOSK — detect whatever printer is attached and make it work.
#
#    bash scripts/setup-printer.sh            detect, install drivers, create, test
#    bash scripts/setup-printer.sh --list     identify the printer, change nothing
#    bash scripts/setup-printer.sh --yes      don't prompt, take the best candidate
#    bash scripts/setup-printer.sh --uri URI  force a specific device URI
#    bash scripts/setup-printer.sh --name N   force the queue name
#    bash scripts/setup-printer.sh --no-test  create the queue, skip the test page
#
#  You do not need to know what printer you have. This asks CUPS what is
#  physically there, reads the make and model out of the device itself, and
#  installs drivers based on what it found.
#
#  Driver resolution ladder, best first:
#    1. IPP Everywhere ("driverless")  — no vendor driver at all. CUPS builds the
#       PPD itself, so it is architecture-independent and works on ARM (a Pi),
#       where most vendor drivers ship x86-only binaries and simply cannot run.
#       Network AirPrint/Mopria printers land here; USB ones do too via ipp-usb.
#    2. A PPD matched to the printer's own IEEE-1284 device-id, which is the
#       accurate way to pair a driver to hardware (not grepping model names).
#    3. Install the vendor's driver package for the detected make, then retry 2.
#    4. printer-driver-all, then retry 2.
#    5. Generic PostScript, with a warning that output may be imperfect.
# =============================================================================

set -uo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

NAME=""
FORCE_URI=""
DO_TEST=1
LIST_ONLY=0
ASSUME_YES=0
WAIT_SECS="${WAIT_SECS:-25}"

while [ $# -gt 0 ]; do
  case "$1" in
    --name)    NAME="${2:-}"; shift 2 ;;
    --uri)     FORCE_URI="${2:-}"; shift 2 ;;
    --list)    LIST_ONLY=1; shift ;;
    --yes|-y)  ASSUME_YES=1; shift ;;
    --no-test) DO_TEST=0; shift ;;
    -h|--help) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

say()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '    \033[0;32m%s\033[0m\n' "$*"; }
warn() { printf '    \033[0;33m%s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die()  { printf '\n\033[0;31mERROR:\033[0m %s\n\n' "$*"; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

if [ "$(uname -s)" != "Linux" ]; then
  die "This script is for Raspberry Pi OS / Debian.
    On Windows, add the printer in Settings -> Printers & scanners, then run:
      npm run printers"
fi

# Maps a detected manufacturer to its Debian driver packages. Only consulted if
# the driverless route fails, and every install is non-fatal: success is judged
# by whether a usable PPD appears afterwards, never by the package manager.
vendor_packages() {
  case "$(printf '%s' "$1" | tr 'A-Z' 'a-z')" in
    *hp*|*hewlett*)                echo "hplip printer-driver-hpcups" ;;
    *brother*)                     echo "printer-driver-brlaser printer-driver-ptouch" ;;
    *epson*|*seiko*)               echo "printer-driver-escpr printer-driver-escpr2" ;;
    *samsung*|*xerox*|*dell*)      echo "printer-driver-splix printer-driver-foo2zjs" ;;
    *canon*)                       echo "printer-driver-gutenprint printer-driver-c2esp" ;;
    *lexmark*|*konica*|*minolta*)  echo "printer-driver-foo2zjs" ;;
    *kyocera*|*ricoh*|*sharp*|*oki*|*toshiba*) echo "printer-driver-postscript-hp foomatic-db" ;;
    *) echo "printer-driver-gutenprint foomatic-db" ;;
  esac
}

# --------------------------------------------------------------- 1. base stack
say "Installing the printing stack"

if have apt-get; then
  sudo apt-get update -qq
  # cups           the print system             cups-filters  PDF rasterisation
  # cups-ipp-utils the `driverless` command     ipp-usb       USB printers speak IPP
  # avahi-daemon   DNS-SD, finds network printers
  sudo apt-get install -y cups cups-filters cups-ipp-utils ipp-usb avahi-daemon \
    || warn "Some packages did not install; continuing with what is present."
else
  warn "No apt-get here - skipping install. CUPS must already be present."
fi

have lp || die "CUPS is not installed, so nothing can print."

sudo usermod -aG lpadmin "${SUDO_USER:-$USER}" 2>/dev/null || true
sudo systemctl enable --now cups         2>/dev/null || true
sudo systemctl enable --now avahi-daemon 2>/dev/null || true
# ipp-usb is udev-activated; restarting makes it re-scan an already-plugged printer.
sudo systemctl restart ipp-usb 2>/dev/null || true

ok "cups: $(lpstat -r 2>/dev/null || echo installed)"

# ------------------------------------------------------- 2. what is out there?
say "Detecting printers (up to ${WAIT_SECS}s)"
info "Printer powered on, and plugged in by USB or joined to this Wi-Fi?"

# Parses `lpinfo -l -v` blocks into: uri <TAB> class <TAB> make-and-model <TAB> device-id
parse_devices() {
  awk '
    function emit() { printf "%s\t%s\t%s\t%s\n", uri, cls, mm, did }
    /^Device:/ {
      if (have) emit()
      t = $0; sub(/^Device:[ \t]*uri[ \t]*=[ \t]*/, "", t); uri = t
      cls = ""; mm = ""; did = ""; have = 1; next
    }
    /^[ \t]*class[ \t]*=/ {
      t = $0; sub(/^[ \t]*class[ \t]*=[ \t]*/, "", t); cls = t; next
    }
    /^[ \t]*make-and-model[ \t]*=/ {
      t = $0; sub(/^[ \t]*make-and-model[ \t]*=[ \t]*/, "", t); mm = t; next
    }
    /^[ \t]*device-id[ \t]*=/ {
      t = $0; sub(/^[ \t]*device-id[ \t]*=[ \t]*/, "", t); did = t; next
    }
    END { if (have) emit() }
  '
}

DEVICES=""
elapsed=0
while [ "$elapsed" -lt "$WAIT_SECS" ]; do
  # Drop virtual backends: they are not printers and would be picked by mistake.
  # The URI scheme is the first field, so matching at line start is enough.
  DEVICES="$(lpinfo -l -v 2>/dev/null | parse_devices \
             | grep -vE '^(file|cups-brf|cups-pdf|beh|hpfax|scsi):' || true)"
  [ -n "$DEVICES" ] && break
  sleep 3
  elapsed=$((elapsed + 3))
  printf '.'
done
printf '\n'

if [ -z "$DEVICES" ]; then
  die "No printer detected.

    Work down this list:
      lsusb                      does the kernel see the USB device at all?
      lpinfo -v                  what CUPS thinks it can reach
      sudo systemctl status ipp-usb avahi-daemon
      ip addr / ping <ip>        for a network printer, same subnet as the Pi?

    Seen by lsusb but not lpinfo usually means ipp-usb is not running:
      sudo systemctl restart ipp-usb   and re-run this script.

    A network printer that never appears may have AirPrint/Mopria disabled in
    its own control panel - switch it on there, then re-run."
fi

# Rank candidates: driverless-capable transports first, raw USB last.
rank_of() {
  case "$1" in
    dnssd://*)        echo 0 ;;
    ipps://*)         echo 1 ;;
    ipp://*)          echo 2 ;;
    socket://*|lpd://*) echo 4 ;;
    usb://*)          echo 5 ;;
    *)                echo 6 ;;
  esac
}

RANKED=""
while IFS="$(printf '\t')" read -r u c m d; do
  [ -z "$u" ] && continue
  RANKED="${RANKED}$(rank_of "$u")|${u}|${m}|${d}
"
done <<EOF
$DEVICES
EOF
RANKED="$(printf '%s' "$RANKED" | grep -v '^$' | sort -t'|' -k1,1n)"

say "Found"
i=0
while IFS='|' read -r r u m d; do
  [ -z "$u" ] && continue
  i=$((i + 1))
  printf '    [%d] %s\n' "$i" "${m:-unknown model}"
  printf '        uri       %s\n' "$u"
  [ -n "$d" ] && printf '        device-id %s\n' "$d"
done <<EOF
$RANKED
EOF

if have driverless; then
  DL="$(driverless 2>/dev/null | head -n3 || true)"
  [ -n "$DL" ] && ok "driverless-capable: $(printf '%s' "$DL" | tr '\n' ' ')"
fi

# ------------------------------------------------------------- 3. pick one
COUNT="$(printf '%s\n' "$RANKED" | grep -c '|' || true)"
CHOICE=1

if [ -n "$FORCE_URI" ]; then
  PICK="$(printf '%s\n' "$RANKED" | grep -F "|$FORCE_URI|" | head -n1)"
  [ -z "$PICK" ] && die "No detected device matches --uri $FORCE_URI"
else
  if [ "$COUNT" -gt 1 ] && [ "$ASSUME_YES" -eq 0 ] && [ "$LIST_ONLY" -eq 0 ] && [ -t 0 ]; then
    printf '\n'
    read -r -p "    Which printer? [1-$COUNT, default 1] " CHOICE < /dev/tty || CHOICE=1
    case "$CHOICE" in ''|*[!0-9]*) CHOICE=1 ;; esac
    [ "$CHOICE" -lt 1 ] || [ "$CHOICE" -gt "$COUNT" ] && CHOICE=1
  fi
  PICK="$(printf '%s\n' "$RANKED" | sed -n "${CHOICE}p")"
fi

URI="$(printf '%s' "$PICK"  | cut -d'|' -f2)"
MAKEMODEL="$(printf '%s' "$PICK" | cut -d'|' -f3)"
DEVICE_ID="$(printf '%s' "$PICK" | cut -d'|' -f4)"

# MFG/MDL out of the IEEE-1284 device-id when present; fall back to make-and-model.
MFG="$(printf '%s' "$DEVICE_ID" | tr ';' '\n' | sed -n 's/^\(MFG\|MANUFACTURER\):\(.*\)$/\2/p' | head -n1)"
MDL="$(printf '%s' "$DEVICE_ID" | tr ';' '\n' | sed -n 's/^\(MDL\|MODEL\):\(.*\)$/\2/p'        | head -n1)"
[ -z "$MFG" ] && MFG="$(printf '%s' "$MAKEMODEL" | awk '{print $1}')"
# NB: `cut -f2-` returns the whole field when there is no delimiter, so a
# single-word make-and-model would otherwise duplicate into the model.
[ -z "$MDL" ] && MDL="$(printf '%s' "$MAKEMODEL" | awk '{ $1=""; sub(/^ /,""); print }')"
[ "$MDL" = "$MFG" ] && MDL=""
case "$MFG" in Unknown|unknown) MFG="" ;; esac

say "Identified"
info "make      ${MFG:-unknown}"
info "model     ${MDL:-unknown}"
info "device    $URI"

if [ "$LIST_ONLY" -eq 1 ]; then
  say "--list given, nothing changed."
  info "Re-run without --list to install drivers and create the queue."
  exit 0
fi

# -------------------------------------------------- 4. resolve a driver (PPD)
# Returns the best PPD CUPS can match to this exact device, or empty.
match_ppd() {
  local out=""
  if [ -n "$DEVICE_ID" ]; then
    out="$(lpinfo --device-id "$DEVICE_ID" -m 2>/dev/null | head -n1 | awk '{print $1}')"
  fi
  if [ -z "$out" ] && [ -n "$MDL" ]; then
    local key
    key="$(printf '%s' "$MDL" | awk '{print $1}')"
    out="$(lpinfo -m 2>/dev/null | grep -i -- "$key" | head -n1 | awk '{print $1}')"
  fi
  printf '%s' "$out"
}

MODEL=""
HOW=""

case "$URI" in
  dnssd://*|ipp://*|ipps://*)
    MODEL="everywhere"; HOW="driverless (IPP Everywhere) - no vendor driver needed" ;;
esac

if [ -z "$MODEL" ]; then
  say "Looking for a driver for ${MFG:-this printer}"

  PPD="$(match_ppd)"
  if [ -n "$PPD" ]; then
    MODEL="$PPD"; HOW="PPD matched to the device-id"
  else
    PKGS="$(vendor_packages "${MFG:-generic}")"
    info "no driver installed yet - trying: $PKGS"
    if have apt-get; then
      # shellcheck disable=SC2086
      sudo apt-get install -y $PKGS 2>/dev/null || warn "some of those were unavailable"
    fi
    PPD="$(match_ppd)"
    if [ -n "$PPD" ]; then
      MODEL="$PPD"; HOW="PPD from the $MFG driver package"
    else
      info "still nothing - trying printer-driver-all (this is a large download)"
      if have apt-get; then
        sudo apt-get install -y printer-driver-all 2>/dev/null || true
      fi
      PPD="$(match_ppd)"
      if [ -n "$PPD" ]; then
        MODEL="$PPD"; HOW="PPD from printer-driver-all"
      else
        MODEL="drv:///sample.drv/generic.ppd"
        HOW="generic PostScript"
        warn "No driver matched this printer. Falling back to generic PostScript:"
        warn "plain text will print, but duplex or colour may be ignored."
      fi
    fi
  fi
fi

# Queue name from the real make and model. CUPS forbids spaces, '/' and '#'.
if [ -z "$NAME" ]; then
  NAME="$(printf '%s %s' "$MFG" "$MDL" \
          | sed -e 's/[^A-Za-z0-9]\+/_/g' -e 's/^_//' -e 's/_$//' | cut -c1-40)"
  [ -z "$NAME" ] && NAME="PrintKiosk"
fi

say "Plan"
info "queue   $NAME"
info "device  $URI"
info "driver  $MODEL"
info "via     $HOW"

# ------------------------------------------------------------ 5. create queue
say "Creating the queue"

sudo lpadmin -p "$NAME" -E -v "$URI" -m "$MODEL" \
  || die "lpadmin could not create '$NAME'.

    Read the reason:  sudo tail -40 /var/log/cups/error_log
    Or use the web UI: http://localhost:631 -> Administration -> Add Printer"

# A new queue can come up paused or rejecting; both look exactly like 'nothing prints'.
sudo cupsenable "$NAME" 2>/dev/null || true
sudo cupsaccept "$NAME" 2>/dev/null || true
sudo lpadmin -d "$NAME" 2>/dev/null || true

# A4 is what the pricing model assumes, so make it the queue default too.
sudo lpadmin -p "$NAME" -o media-default=iso_a4_210x297mm      2>/dev/null || true
sudo lpadmin -p "$NAME" -o print-color-mode-default=monochrome 2>/dev/null || true

ok "queue created and enabled"
info "$(lpstat -a "$NAME" 2>/dev/null || true)"

# ------------------------------------------------------------- 6. pin in .env
say "Pinning PRINTER_NAME in .env"
touch .env
if grep -q '^PRINTER_NAME=' .env 2>/dev/null; then
  sed -i "s|^PRINTER_NAME=.*|PRINTER_NAME=$NAME|" .env
  ok "updated PRINTER_NAME=$NAME"
else
  printf '\n# Set by scripts/setup-printer.sh\nPRINTER_NAME=%s\n' "$NAME" >> .env
  ok "added PRINTER_NAME=$NAME"
fi

# ------------------------------------------------------- 7. prove the hardware
if [ "$DO_TEST" -eq 1 ]; then
  say "Sending a test page through the same code path the kiosk uses"
  if node scripts/testprint.js --printer "$NAME"; then
    say "Paper out? Then the kiosk prints too - it calls the same printFile()."
    info "Next:  bash run.sh     then upload -> approve -> type the OTP"
  else
    die "The queue exists but the page did not come out.

    That makes this a driver or hardware problem, not a PrintKiosk one:
      lpstat -t                        look for 'disabled' and the reason
      sudo tail -40 /var/log/cups/error_log
      cancel -a $NAME                  clear a jammed queue
      the printer itself               paper, toner, lid, error light

    If the driver is the suspect, try the driverless route explicitly:
      bash scripts/setup-printer.sh --list        see every transport found
      sudo lpadmin -p $NAME -m everywhere         switch this queue driverless"
  fi
else
  say "Queue ready. Prove the hardware with:"
  info "node scripts/testprint.js --printer $NAME"
fi
