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

# Parses `lpinfo -l -v` blocks into: uri <TAB> make-and-model <TAB> device-id
parse_devices() {
  awk '
    function emit() { printf "%s\t%s\t%s\n", uri, mm, did }
    /^Device:/ {
      if (have) emit()
      t = $0; sub(/^Device:[ \t]*uri[ \t]*=[ \t]*/, "", t); uri = t
      mm = ""; did = ""; have = 1; next
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

# How good is this URI? Lower is better.
#
# A dnssd:// URI must be judged by its SERVICE TYPE, not just its scheme. The
# same printer advertises several, and they are not interchangeable:
#   _ipps._tcp        IPP over TLS      - best
#   _ipp._tcp         IPP               - good
#   _pdl-datastream   AppSocket/9100    - works, no status reporting
#   _printer._tcp     LPD on port 515   - legacy, and DEAD for a USB printer
#                                         bridged by ipp-usb: nothing listens
#                                         on 515, so lpadmin reports
#                                         "Unable to connect ... Host is down".
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

# "ipp://Brother%20MFC-T930DW%20(USB)._ipp._tcp.local/" -> "Brother MFC-T930DW"
name_from_uri() {
  printf '%s' "$1" \
    | sed -e 's|^[a-z]*://||' \
          -e 's|\._[a-z-]*\._tcp.*$||' \
          -e 's|[?/].*$||' \
          -e 's|%20| |g' -e 's|%2520| |g' \
          -e 's|+| |g' \
          -e 's|[[:space:]]*([Uu][Ss][Bb])[[:space:]]*| |g' \
          -e 's|^[[:space:]]*||' -e 's|[[:space:]]*$||'
}

CANDIDATES=""
elapsed=0
while [ "$elapsed" -lt "$WAIT_SECS" ]; do
  # (a) Ask `driverless` first. It is authoritative about what CUPS can drive
  #     with no vendor driver, and it reports the URIs that actually work -
  #     unlike a blind sweep of every DNS-SD record the printer advertises.
  DL=""
  if have driverless; then
    DL="$(driverless 2>/dev/null | grep -oE '(ipps?|dnssd)://[^ ]+' || true)"
  fi

  # (b) Then everything CUPS can see. Virtual backends are not printers.
  LP="$(lpinfo -l -v 2>/dev/null | parse_devices \
        | grep -vE '^(file|cups-brf|cups-pdf|beh|hpfax|scsi):' || true)"

  if [ -n "${DL}${LP}" ]; then
    # driverless URIs carry no make/model fields; the name is in the URI itself.
    if [ -n "$DL" ]; then
      while IFS= read -r u; do
        [ -z "$u" ] && continue
        CANDIDATES="${CANDIDATES}$(rank_of "$u")|${u}|$(name_from_uri "$u")|
"
      done <<EOF
$DL
EOF
    fi
    if [ -n "$LP" ]; then
      while IFS="$(printf '\t')" read -r u m d; do
        [ -z "$u" ] && continue
        [ -z "$m" ] || [ "$m" = "Unknown" ] && m="$(name_from_uri "$u")"
        CANDIDATES="${CANDIDATES}$(rank_of "$u")|${u}|${m}|${d}
"
      done <<EOF
$LP
EOF
    fi
    break
  fi
  sleep 3
  elapsed=$((elapsed + 3))
  printf '.'
done
printf '\n'

if [ -z "$CANDIDATES" ]; then
  die "No printer detected.

    Work down this list:
      lsusb                      does the kernel see the USB device at all?
      lpinfo -v                  what CUPS thinks it can reach
      driverless                 what CUPS can drive with no vendor driver
      sudo systemctl status ipp-usb avahi-daemon
      ip addr / ping <ip>        for a network printer, same subnet as the Pi?

    Seen by lsusb but not lpinfo usually means ipp-usb is not running:
      sudo systemctl restart ipp-usb   and re-run this script.

    A network printer that never appears may have AirPrint/Mopria disabled in
    its own control panel - switch it on there, then re-run."
fi

# Sort by rank, then drop duplicate URIs (keeping the best-ranked copy).
RANKED="$(printf '%s' "$CANDIDATES" | grep -v '^$' | sort -t'|' -k1,1n \
          | awk -F'|' '!seen[$2]++')"

say "Found"
i=0
while IFS='|' read -r r u m d; do
  [ -z "$u" ] && continue
  i=$((i + 1))
  printf '    [%d] %s\n' "$i" "${m:-unknown model}"
  printf '        %s\n' "$u"
done <<EOF
$RANKED
EOF

# ------------------------------------------------------------- 3. pick one
COUNT="$(printf '%s\n' "$RANKED" | grep -c '|' || true)"

if [ -n "$FORCE_URI" ]; then
  RANKED="$(printf '%s\n' "$RANKED" | grep -F "|$FORCE_URI|" | head -n1)"
  [ -z "$RANKED" ] && die "No detected device matches --uri $FORCE_URI"
  COUNT=1
elif [ "$COUNT" -gt 1 ] && [ "$ASSUME_YES" -eq 0 ] && [ "$LIST_ONLY" -eq 0 ] && [ -t 0 ]; then
  printf '\n'
  info "[1] is the best match. Press Enter to accept it."
  CHOICE="$(ask "Which printer? [1-$COUNT, default 1] " '1')"
  case "$CHOICE" in ''|*[!0-9]*) CHOICE=1 ;; esac
  if [ "$CHOICE" -ge 1 ] && [ "$CHOICE" -le "$COUNT" ]; then
    # Move the chosen one to the front; the rest stay as fallbacks.
    RANKED="$(printf '%s\n' "$RANKED" | sed -n "${CHOICE}p")
$(printf '%s\n' "$RANKED" | sed "${CHOICE}d")"
  fi
fi

BEST="$(printf '%s\n' "$RANKED" | head -n1)"
say "Identified"
info "name      $(printf '%s' "$BEST" | cut -d'|' -f3)"
info "device    $(printf '%s' "$BEST" | cut -d'|' -f2)"

if [ "$LIST_ONLY" -eq 1 ]; then
  say "--list given, nothing changed."
  info "Re-run without --list to install drivers and create the queue."
  exit 0
fi

# -------------------------------------------------- 4. resolve a driver (PPD)
# Best PPD CUPS can match to this exact device, or empty.
match_ppd() {
  local did="$1" mdl="$2" out=""
  if [ -n "$did" ]; then
    out="$(lpinfo --device-id "$did" -m 2>/dev/null | head -n1 | awk '{print $1}')"
  fi
  if [ -z "$out" ] && [ -n "$mdl" ]; then
    local key
    key="$(printf '%s' "$mdl" | awk '{print $2}')"
    [ -z "$key" ] && key="$(printf '%s' "$mdl" | awk '{print $1}')"
    out="$(lpinfo -m 2>/dev/null | grep -i -- "$key" | head -n1 | awk '{print $1}')"
  fi
  printf '%s' "$out"
}

VENDOR_TRIED=0
resolve_driver() {
  # echoes: <ppd-or-everywhere>|<human description>
  local uri="$1" mm="$2" did="$3" mfg mdl ppd pkgs

  case "$uri" in
    dnssd://*_ipp*|dnssd://*_ipps*|ipp://*|ipps://*)
      printf 'everywhere|driverless (IPP Everywhere) - no vendor driver needed'; return ;;
  esac

  mfg="$(printf '%s' "$did" | tr ';' '\n' | sed -n 's/^\(MFG\|MANUFACTURER\):\(.*\)$/\2/p' | head -n1)"
  mdl="$(printf '%s' "$did" | tr ';' '\n' | sed -n 's/^\(MDL\|MODEL\):\(.*\)$/\2/p'        | head -n1)"
  [ -z "$mfg" ] && mfg="$(printf '%s' "$mm" | awk '{print $1}')"

  ppd="$(match_ppd "$did" "${mdl:-$mm}")"
  if [ -n "$ppd" ]; then printf '%s|PPD matched to the device' "$ppd"; return; fi

  if [ "$VENDOR_TRIED" -eq 0 ] && have apt-get; then
    VENDOR_TRIED=1
    pkgs="$(vendor_packages "${mfg:-generic}")"
    info "no driver installed yet - trying: $pkgs"
    # shellcheck disable=SC2086
    sudo apt-get install -y $pkgs 2>/dev/null || warn "some of those were unavailable"
    ppd="$(match_ppd "$did" "${mdl:-$mm}")"
    if [ -z "$ppd" ]; then
      info "still nothing - trying printer-driver-all (large download)"
      sudo apt-get install -y printer-driver-all 2>/dev/null || true
      ppd="$(match_ppd "$did" "${mdl:-$mm}")"
    fi
    if [ -n "$ppd" ]; then printf '%s|PPD from an installed driver package' "$ppd"; return; fi
  fi

  printf 'drv:///sample.drv/generic.ppd|generic PostScript (duplex/colour may be ignored)'
}

# ------------------------------------------------------------ 5. create queue
# Try each candidate in turn. lpadmin contacts the device to build the PPD, so a
# failure here IS the connectivity test - an advertised-but-dead service (an LPD
# record for a USB printer, say) fails now, and the next candidate gets a go.
say "Creating the queue"

CREATED=0
ATTEMPT=0
LAST_ERR=""

while IFS='|' read -r rank uri mm did; do
  [ -z "$uri" ] && continue
  ATTEMPT=$((ATTEMPT + 1))
  [ "$ATTEMPT" -gt 4 ] && break

  DRV="$(resolve_driver "$uri" "$mm" "$did")"
  MODEL="${DRV%%|*}"
  HOW="${DRV#*|}"

  if [ -z "$NAME" ]; then
    QNAME="$(printf '%s' "$mm" | sed -e 's/[^A-Za-z0-9]\+/_/g' -e 's/^_//' -e 's/_$//' | cut -c1-40)"
    [ -z "$QNAME" ] && QNAME="PrintKiosk"
  else
    QNAME="$NAME"
  fi

  info ""
  info "try $ATTEMPT: $QNAME"
  info "  device  $uri"
  info "  driver  $MODEL  ($HOW)"

  LAST_ERR="$(sudo lpadmin -p "$QNAME" -E -v "$uri" -m "$MODEL" 2>&1)"
  if [ -z "$LAST_ERR" ]; then
    CREATED=1
    NAME="$QNAME"
    ok "queue created: $QNAME"
    break
  fi

  warn "failed: $LAST_ERR"
  sudo lpadmin -x "$QNAME" 2>/dev/null || true
done <<EOF
$RANKED
EOF

if [ "$CREATED" -eq 0 ]; then
  die "Could not create a working queue from any detected device.

    Last error:  $LAST_ERR

    'Host is down' on port 515 means an LPD record was advertised but nothing
    is serving it - normal for a USB printer bridged by ipp-usb. Check that an
    IPP route exists:

      driverless                     should list an ipp:// or ipps:// URI
      sudo systemctl status ipp-usb
      sudo tail -40 /var/log/cups/error_log

    Or add it by hand: http://localhost:631 -> Administration -> Add Printer"
fi

# A new queue can come up paused or rejecting; both look exactly like 'nothing prints'.
sudo cupsenable "$NAME" 2>/dev/null || true
sudo cupsaccept "$NAME" 2>/dev/null || true
sudo lpadmin -d "$NAME" 2>/dev/null || true

# A4 is what the pricing model assumes, so make it the queue default too.
sudo lpadmin -p "$NAME" -o media-default=iso_a4_210x297mm      2>/dev/null || true
sudo lpadmin -p "$NAME" -o print-color-mode-default=monochrome 2>/dev/null || true

ok "enabled and accepting jobs"
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
