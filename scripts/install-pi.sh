#!/usr/bin/env bash
# PRINTKIOSK - Raspberry Pi provisioning.
#
#   bash scripts/install-pi.sh                     # auto-detect the default CUPS queue
#   bash scripts/install-pi.sh "Canon_MF240"       # pin a queue by name
#
# Installs the agent as a systemd service and makes Chromium open the keypad
# fullscreen on boot. Run it from the project directory as the kiosk user.

set -euo pipefail

PRINTER_NAME="${1:-}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KIOSK_USER="${SUDO_USER:-$USER}"
PORT="${PORT:-8080}"

echo "==> app dir : $APP_DIR"
echo "==> user    : $KIOSK_USER"

# ---------------------------------------------------------------- dependencies
if ! command -v node >/dev/null 2>&1; then
  echo "==> installing Node.js"
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "==> node    : $(node --version)"

echo "==> installing CUPS + chromium"
sudo apt-get update -qq
sudo apt-get install -y cups chromium-browser unclutter xdotool

# Let the kiosk user drive the printer without sudo.
sudo usermod -aG lpadmin "$KIOSK_USER" || true

# ------------------------------------------------------------------- printer
if [ -z "$PRINTER_NAME" ]; then
  PRINTER_NAME="$(lpstat -d 2>/dev/null | sed -n 's/.*: *//p' || true)"
fi
if [ -z "$PRINTER_NAME" ]; then
  echo ""
  echo "!! No default CUPS printer found."
  echo "   Add one at http://localhost:631  (Administration -> Add Printer)"
  echo "   then re-run:  bash scripts/install-pi.sh \"Your_Queue_Name\""
  echo ""
fi
echo "==> printer : ${PRINTER_NAME:-<none>}"

# ------------------------------------------------------------------- service
echo "==> installing systemd service"
sudo tee /etc/systemd/system/printkiosk.service >/dev/null <<UNIT
[Unit]
Description=PRINTKIOSK kiosk agent
After=network-online.target cups.service
Wants=network-online.target

[Service]
Type=simple
User=$KIOSK_USER
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=PORT=$PORT
Environment=PRINTER_DRIVER=cups
Environment=PRINTER_NAME=$PRINTER_NAME
Environment=SIM_ENABLED=true
ExecStart=/usr/bin/node $APP_DIR/server.js
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable printkiosk.service
sudo systemctl restart printkiosk.service

# ------------------------------------------------------------------ autostart
echo "==> configuring Chromium autostart"
AUTOSTART_DIR="/home/$KIOSK_USER/.config/autostart"
mkdir -p "$AUTOSTART_DIR"
cat > "$AUTOSTART_DIR/printkiosk.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=PrintKiosk
Exec=$APP_DIR/scripts/kiosk-browser.sh
X-GNOME-Autostart-enabled=true
DESKTOP

cat > "$APP_DIR/scripts/kiosk-browser.sh" <<BROWSER
#!/usr/bin/env bash
# Waits for the agent, then opens the keypad fullscreen with no chrome.
xset s off; xset -dpms; xset s noblank
unclutter -idle 0.5 -root &

until curl -sf "http://localhost:$PORT/api/health" >/dev/null; do sleep 1; done

exec chromium-browser \\
  --kiosk \\
  --incognito \\
  --noerrdialogs \\
  --disable-infobars \\
  --disable-session-crashed-bubble \\
  --disable-features=TranslateUI \\
  --check-for-update-interval=31536000 \\
  --autoplay-policy=no-user-gesture-required \\
  --touch-events=enabled \\
  "http://localhost:$PORT/?cursorless"
BROWSER
chmod +x "$APP_DIR/scripts/kiosk-browser.sh"

echo ""
echo "==> done"
echo "    status   : sudo systemctl status printkiosk"
echo "    logs     : journalctl -u printkiosk -f"
echo "    keypad   : http://localhost:$PORT/"
echo "    simulator: http://localhost:$PORT/sim"
echo "    selftest : BASE=http://localhost:$PORT node scripts/selftest.js"
echo ""
echo "    Reboot to bring up the fullscreen kiosk browser."
echo ""
