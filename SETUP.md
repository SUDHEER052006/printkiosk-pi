# PRINTKIOSK — Setup Guide

Every command you need, in order, with what each one does and what to do when it breaks.

Written for someone sitting in front of a Raspberry Pi with nothing installed yet.

---

## Table of contents

1. [What you need](#1-what-you-need)
2. [Try it on your laptop first (5 minutes, no printer)](#2-try-it-on-your-laptop-first)
3. [Put it on the Raspberry Pi](#3-put-it-on-the-raspberry-pi)
4. [Connect the printer](#4-connect-the-printer)
5. [Print for real](#5-print-for-real)
6. [Make it boot fullscreen on power-on](#6-make-it-boot-fullscreen-on-power-on)
7. [Demo script for your viva](#7-demo-script-for-your-viva)
8. [Settings reference](#8-settings-reference)
9. [When something breaks](#9-when-something-breaks)
10. [How the code is laid out](#10-how-the-code-is-laid-out)
11. [Sending from a phone](#11-sending-from-a-phone)

---

## 1. What you need

**To try the simulation:** any laptop with Node.js 18 or newer. That's it.

**To print for real:**

| Item | Notes |
|---|---|
| Raspberry Pi 4 (2GB+) | A Pi 3 works but the browser feels slow |
| microSD card, 16GB+ | With Raspberry Pi OS **with Desktop** (you need a GUI for the browser) |
| Touchscreen | Official 7" Pi display, or any HDMI monitor + USB touch panel |
| Printer | Canon MF240 series, HP LaserJet, Brother DCP — anything with a Linux/CUPS driver |
| USB cable or Wi-Fi | However the printer connects |
| Power supply | The official Pi one. Underpowered supplies cause random USB/printer dropouts. |

Check your Node version:

```bash
node --version
```

If it says `v18` or higher, you're fine. If the command isn't found, see
[section 3](#3-put-it-on-the-raspberry-pi) for install steps.

---

## 2. Try it on your laptop first

Do this before touching the Pi. It proves the software works and teaches you the flow, and it
needs **no printer at all**.

### 2.1 Get the code

```bash
git clone https://github.com/SUDHEER052006/printkiosk-pi.git
cd printkiosk-pi
```

(Or unzip `printkiosk-pi.zip` and `cd` into it.)

There is **no `npm install`**. The project has zero dependencies on purpose — so it can't break
because of a bad network or a missing package.

### 2.2 Start it in simulation mode

```bash
PRINTER_DRIVER=mock node server.js
```

On **Windows PowerShell** the syntax is different:

```powershell
$env:PRINTER_DRIVER="mock"; node server.js
```

You should see:

```
  PRINTKIOSK  kiosk agent
  ----------------------------------------------------
  kiosk id    kiosk-raspberrypi
  driver      mock  (SIMULATION - no paper will move)
  printer     Mock_Canon_MF240
  ----------------------------------------------------
  keypad      http://localhost:8080/
  upload      http://192.168.0.118:8080/upload      <- open this on the phone
  dashboard   http://localhost:8080/admin
  simulator   http://localhost:8080/sim
```

Leave this terminal running. It's the server.

### 2.3 Walk through the flow with a real PDF

Open **two browser tabs**:

**Tab 1 — http://localhost:8080/upload**

This is the student's page. Drag in **any real PDF from your computer**. The server reads the file,
counts its actual pages, and prices it from that count — nothing is faked:

```
  assignment.pdf
  842 KB · 19 pages · parsed in 2ms
```

Pick copies / colour / double-sided, watch the amount update, then **Pay & get pickup code**. A
6-digit code appears, like `483920`.

**Tab 2 — http://localhost:8080/**

This is the actual kiosk keypad — what shows on the Pi's touchscreen. Type the 6-digit code and
press **RELEASE MY PRINTOUT**.

Watch it run: `Sending to printer → Queued → Printing sheet 1 of 20 → Erasing your document →
Collect your printout`.

> **http://localhost:8080/sim** is the other tab worth knowing: it mints test orders with a
> generated PDF instead of a real upload, and lists every order with its status. Useful for quick
> repeat tests; the upload page is the honest end-to-end path.

**What actually happens to your PDF:** it's stored under a random UUID filename (your filename never
touches the filesystem), priced from the page count the *server* read, printed byte-for-byte as you
uploaded it, then deleted from disk the instant the job completes.

**What gets rejected, and why:**

| You upload | Response |
|---|---|
| `notes.exe`, `run.sh`, `photo.jpg` | `400` — extension not allowed |
| A `.pdf` that isn't really a PDF | `400` — checked by magic bytes, not the name |
| A password-protected PDF | `400` — pages can't be counted, so it can't be priced |
| An empty file | `400` — the file was empty |
| Over 25 MB, or over 200 pages | `413` / `422` with the limit named |

### 2.4 Prove it works

```bash
node scripts/selftest.js
```

This runs the test cases from your project report end to end:

```
  PASS  agent is up
  PASS  TC-02 duplex math  5p x2 duplex = 6 sheets, Rs.18
  PASS  report example    7p x2 duplex = 8 sheets, Rs.24
  PASS  colour single     10p x1 = Rs.100
  PASS  upload accepts a real PDF and counts its pages   9 pages in 1ms
  PASS  TC-03 non-PDF content rejected
  PASS  TC-03 .exe extension rejected
  PASS  uploaded doc priced from the STORED page count   10 sheets / Rs.30
  PASS  TC-01 order created + pages parsed
  PASS  TC-06 wrong OTP rejected
  PASS  short OTP rejected
  PASS  TC-05 correct OTP releases job
  PASS  job reached COMPLETED
  PASS  TC-07 document shredded after print
  PASS  order marked COMPLETED
  PASS  OTP cannot be reused

  16 passed, 0 failed
```

**Screenshot this for your report.** It's direct evidence for your testing chapter.

> Note: if the server is on a port other than 8080, tell the test:
> `BASE=http://127.0.0.1:8099 node scripts/selftest.js`

In mock mode, look in `data/mock-prints/` — you'll find a receipt and a copy of the exact PDF that
*would* have printed. Useful proof that the right document reached the right queue.

To stop the server: **Ctrl+C**.

---

## 3. Put it on the Raspberry Pi

### 3.1 Prepare the Pi

Flash **Raspberry Pi OS (64-bit) with Desktop** using Raspberry Pi Imager. Boot it, connect to
Wi-Fi, and open a terminal.

Update everything first — this prevents most weird errors later:

```bash
sudo apt update && sudo apt full-upgrade -y
sudo reboot
```

### 3.2 Install Node.js

Raspberry Pi OS ships an old Node. Install a current one:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version
```

You want `v20.x` or higher.

### 3.3 Get the code

```bash
cd ~
git clone https://github.com/SUDHEER052006/printkiosk-pi.git
cd printkiosk-pi
```

If `git` is missing: `sudo apt install -y git`

### 3.4 Test it on the Pi with no printer

```bash
PRINTER_DRIVER=mock node server.js
```

Open Chromium on the Pi to `http://localhost:8080/sim`, make an order, then go to
`http://localhost:8080/` and type the code. Same flow as your laptop.

Working? Good — the software is fine on the Pi. Now the printer.

Stop it with **Ctrl+C**.

---

## 4. Connect the printer

### 4.1 Install CUPS

CUPS is the Linux printing system. Your agent talks to it.

```bash
sudo apt install -y cups
sudo usermod -aG lpadmin $USER
sudo systemctl enable --now cups
```

**Log out and back in** (or reboot) — group changes don't apply to your current session.

### 4.2 Add the printer

Plug the printer in via USB and power it on. Then open Chromium on the Pi:

```
http://localhost:631
```

Go to **Administration → Add Printer**. It should list your printer under "Local Printers".
Select it → Continue → pick the driver (search your model, e.g. `MF240`) → **Add Printer**.

On the options page set **A4** as the default paper size. Then **Print Test Page** — if paper comes
out, CUPS is working and the rest is easy.

> **Canon MF240 series specifically:** if no driver is listed, install the generic UFR II driver:
> ```bash
> sudo apt install -y printer-driver-cups-pdf cups-filters
> ```
> Canon's official `.deb` for ARM is at Canon's support site if the generic one misbehaves. A
> "Generic PCL 6" or "Generic PostScript" driver is usually good enough for plain assignment
> printing.

### 4.3 Find the exact queue name

```bash
cd ~/printkiosk-pi
node scripts/list-printers.js
```

Output:

```
  driver        cups
  default       Canon_MF240

  Queues:
    * Canon_MF240

  Use it with:  PRINTER_NAME="Canon_MF240" npm start
```

**Copy that exact name.** Underscores and capitals matter.

---

## 5. Print for real

### 5.1 Prove the printer works first

Before involving the kiosk at all, send one page straight to the hardware:

```bash
node scripts/testprint.js --printer "Canon_MF240"
```

```
  driver    cups
  printer   Canon_MF240

  sending...
     20%  SPOOLING   Sending to Canon_MF240
     40%  SPOOLED    Queued as Canon_MF240-42
     92%  PRINTING   Printing sheets
     96%  PRINTED    Sheets delivered

  done in 8.4s  ·  job Canon_MF240-42
  Check the printer tray.
```

If a page comes out, the hardware path is good and everything else is software. If it fails, the
script prints the exact diagnostic commands to run next.

Add `--duplex`, `--colour`, `--pages 3`, `--copies 2` to test those specifically — worth doing, since
duplex is the setting most likely to be unsupported by a given driver.

### 5.2 Then run the kiosk against it

```bash
cd ~/printkiosk-pi
PRINTER_NAME="Canon_MF240" node server.js
```

The banner should now say `driver cups` with **no** "SIMULATION" warning. If it still says
`mock`, CUPS isn't installed or `lp` isn't on the PATH — go back to 4.1.

Now the real test. Two terminals or two browser tabs:

```bash
# terminal 2 — create a paid order and get a code
cd ~/printkiosk-pi
node scripts/seed.js --pages 2
```

```
  order    PK-2026-000001
  spec     2 pages x 1 single bw A4
  sheets   2 @ Rs.2
  amount   Rs. 4

  OTP      847213
```

Type `847213` on the keypad at `http://localhost:8080/`.

**Paper should come out of the printer.**

Or do it with a real document: open `http://localhost:8080/upload` on your phone (use the Pi's IP,
e.g. `http://192.168.0.118:8080/upload`), drag in a PDF, pay, and type the code on the kiosk.

Or run the whole test suite against real hardware — it will genuinely print:

```bash
node scripts/selftest.js
```

---

## 6. Make it boot fullscreen on power-on

One command does everything — Node, CUPS, Chromium, the background service, and the fullscreen
browser on boot:

```bash
cd ~/printkiosk-pi
bash scripts/install-pi.sh "Canon_MF240"
```

Then:

```bash
sudo reboot
```

The Pi comes up straight into the keypad — fullscreen, no address bar, no mouse cursor, screen
never blanks.

### Managing the service

```bash
sudo systemctl status printkiosk      # is it running?
sudo systemctl restart printkiosk     # restart it
sudo systemctl stop printkiosk        # stop it
journalctl -u printkiosk -f           # watch live logs (Ctrl+C to exit)
```

### Getting out of kiosk mode

`Alt+F4` closes the browser. `Ctrl+Alt+T` opens a terminal.

### Before you deploy it for real students

Turn off the simulator, or anyone can mint free print orders:

```bash
sudo systemctl edit printkiosk
```

Add:

```
[Service]
Environment=SIM_ENABLED=false
```

Then `sudo systemctl restart printkiosk`.

---

## 7. Demo script for your viva

A clean 3-minute run for faculty.

**Setup before they walk in:**

```bash
sudo systemctl restart printkiosk     # fresh state
```

Have the simulator open on a laptop/phone, and the kiosk keypad on the Pi touchscreen.

**The demo:**

1. *"This is the student's phone."* → on `/sim`, create an order: 7 pages, 2 copies, double-sided.
   Point out the price: **Rs. 24**, computed by the server, not the browser.

2. *"The maths is enforced on the backend."* → 7 pages double-sided is `ceil(7/2) = 4` sheets per
   copy, × 2 copies = 8 sheets, × Rs. 3 = **Rs. 24**. This matches section 7 of your report exactly.

3. *"Payment succeeds, and the student gets a code."* → point at the 6-digit OTP.

4. *"Nothing has printed yet."* → this is the key point. The document sits locked. Nobody can see it
   and no paper is sitting in an open tray.

5. *"The student walks to the kiosk."* → type a **wrong** code first. It shakes and says
   `Invalid OTP or order not found. 4 attempts left.` → shows brute force is handled.

6. Type the **correct** code. Paper comes out while the screen shows live progress.

7. *"And the document is now gone."* → on `/sim`, the order row reads **shredded**. Show the file
   is really deleted:

   ```bash
   ls ~/printkiosk-pi/data/documents/
   ```

   Empty. Zero-trace compliance, demonstrated rather than claimed.

**Likely question — "why not just print after payment?"**
Uncollected sheets pile up in an open tray where anyone can read them. The OTP guarantees the
document only leaves the printer when the student is physically standing there.

**Likely question — "why doesn't Vercel print?"**
A serverless function runs in a datacenter container. It has no CUPS, no printer and no route into
the campus network. Printing has to happen on the machine wired to the printer — that's this Pi
agent. Vercel keeps the web app, pricing and payment; the Pi keeps the paper.

---

## 8. Settings reference

Set these before `node server.js`, or in the systemd file for a permanent install.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8080` | Which port to serve on |
| `PRINTER_DRIVER` | `auto` | `auto`, `cups`, `windows`, or `mock` |
| `PRINTER_NAME` | system default | Exact queue name from `list-printers.js` |
| `SIM_ENABLED` | `true` | Exposes `/sim`. **Set `false` in production.** |
| `SHRED_ON_COMPLETE` | `true` | Delete the document after printing |
| `KIOSK_RESET_MS` | `20000` | "Next customer" auto-reset delay |
| `OTP_TTL_HOURS` | `24` | How long a code stays valid |
| `OTP_MAX_ATTEMPTS` | `5` | Wrong tries before a cooldown |
| `PRINT_TIMEOUT_MS` | `180000` | Give up on a stuck printer (3 min) |
| `MOCK_DURATION_MS` | `7000` | How long a fake print takes |
| `DATA_DIR` | `./data` | Where documents and records live |
| `UPLOAD_MAX_BYTES` | `26214400` | Upload size limit (25 MB) |
| `UPLOAD_MAX_PAGES` | `200` | Page limit for one job |

Example — different port, no simulator, specific printer:

```bash
PORT=9000 SIM_ENABLED=false PRINTER_NAME="HP_LaserJet" node server.js
```

---

## 9. When something breaks

### "Port 8080 already in use"

Something else is on that port, or an old copy is still running.

```bash
# Linux / Pi
sudo lsof -i :8080
kill <the PID>
```
```powershell
# Windows
netstat -ano | findstr :8080
taskkill /PID <the PID> /F
```

Or just use another port: `PORT=8090 node server.js`

### Banner says "mock" when I want real printing

`lp` isn't installed or isn't on the PATH.

```bash
which lp                       # should print /usr/bin/lp
sudo apt install -y cups
sudo systemctl status cups     # should say active (running)
```

### "No CUPS printer configured"

No default queue is set.

```bash
lpstat -a                                  # list queues
lpoptions -d Canon_MF240                   # set a default
```

Or pass it explicitly: `PRINTER_NAME="Canon_MF240" node server.js`

### Job says COMPLETED but nothing printed

The agent handed the file to CUPS successfully, so the problem is below it — CUPS or the printer.

```bash
lpstat -t                      # full status of everything
lpstat -W completed -o         # recently finished jobs
cancel -a                      # clear a jammed queue
sudo systemctl restart cups
```

Check the obvious too: paper, toner, printer's own error light, USB cable.

### Windows: a print dialog opens instead of printing silently

Windows has no built-in way to print a PDF from the command line without a helper. Install
SumatraPDF once and the agent finds it automatically:

```powershell
winget install SumatraPDF.SumatraPDF
```

Or set `SUMATRA_PATH` to a portable copy. This does not apply to the Raspberry Pi — CUPS prints
directly, which is why the Pi is the deployment target.

### Upload says "page count could not be read"

The PDF is damaged or unusually built. Open it and re-save it (any viewer's Print → Save as PDF
works), then upload again. Password-protected PDFs are rejected on purpose: pages can't be counted
through the encryption, so the job can't be priced honestly.

### Printer prints garbage or blank pages

Wrong driver. Go back to `http://localhost:631` → **Administration → Manage Printers** → your
printer → **Modify Printer** and try a different one. "Generic PostScript" and "Generic PCL 6" are
good fallbacks.

### "Too many wrong attempts"

The brute-force guard. It's 30 seconds the first time, doubling if it keeps happening, up to
5 minutes. Just wait — or restart the service to clear it instantly:

```bash
sudo systemctl restart printkiosk
```

### Keypad shows "agent offline"

The browser is up but the server isn't.

```bash
sudo systemctl status printkiosk
journalctl -u printkiosk -n 50      # last 50 log lines — read the actual error
```

### Touchscreen taps land in the wrong place

Calibration, not this software:

```bash
sudo apt install -y xinput-calibrator
xinput_calibrator
```

### Start over completely

```bash
rm -rf ~/printkiosk-pi/data
sudo systemctl restart printkiosk
```

Deletes all orders and documents. The code is untouched.

---

## 10. How the code is laid out

```
server.js               HTTP server, routes, live progress stream
src/config.js           all settings and their defaults
src/store.js            orders + documents        <-- swap this for Supabase
src/pricing.js          the sheet maths from report section 7
src/otp.js              code generation, secure matching, brute-force guard
src/pdf.js              makes test PDFs (so simulation needs no sample files)
src/printer.js          talks to CUPS / Windows / mock
src/jobs.js             job lifecycle, progress, shredding, error messages
src/multipart.js        binary-safe form-upload parser
public/kiosk.html       the touchscreen keypad
public/upload.html      the student's upload page (real PDFs)
public/sim.html         the simulator (generated PDFs, order list)
scripts/selftest.js     the test suite
scripts/seed.js         make one order quickly from the terminal
scripts/list-printers.js  find your queue name
scripts/testprint.js    send one page straight to the hardware
scripts/install-pi.sh   sets up the whole Pi in one command
```

### Connecting it to your real Vercel + Supabase backend

Replace **one file**: `src/store.js`.

It exposes four functions — `releasableOrders()`, `getDocument()`, `updateOrder()` and
`markDocumentShredded()` — backed by a local JSON file. Point those at Supabase instead and nothing
else in the project changes.

The pattern to use is **pull, not push**: the Pi polls Supabase (or subscribes to Realtime on the
`orders` table) for rows where `payment_status = 'PAID' AND print_status = 'READY_FOR_KIOSK'`, then
downloads the file with a signed URL. This needs no public IP, no port forwarding and no tunnel —
the Pi only makes outbound requests, which any campus firewall allows.

---

**Questions this guide didn't answer?** The behaviour is all in `README.md`, and every failure mode
prints a real error — `journalctl -u printkiosk -f` is almost always the fastest way to see what
actually went wrong.


---

## 11. Sending from a phone

This is the flow you want for a demo: **drag from the phone, type the code on the monitor.**

### It already works on your Wi-Fi — no Vercel needed

1. Start the agent on the Pi. The banner prints the address to use:

   ```
   upload      http://192.168.0.118:8080/upload      <- open this on the phone
   ```

2. The kiosk screen shows a **QR code** in the right-hand panel. Scan it with the phone camera —
   it opens that address. No typing.

3. Phone: pick a PDF, choose settings, **Pay & get pickup code**.

4. Monitor: type the 6-digit code on the keypad. It prints.

**The phone must be on the same Wi-Fi as the Pi.** Mobile data will not reach a private address like
`192.168.x.x` — that is what `VERCEL.md` is for.

### If the QR points at the wrong address

Laptops often have several network adapters (VirtualBox, WSL, Docker) that look like a LAN but route
nowhere. The agent scores them and picks the real one, but you can force it:

```bash
KIOSK_HOST=192.168.0.118 node server.js
```

Find the right address with `hostname -I` on the Pi, or `ipconfig` on Windows.

### Give the Pi a fixed address

Otherwise the IP changes after a reboot and every QR code you printed goes stale. Either set a DHCP
reservation on the router (easiest), or on the Pi:

```bash
sudo nmcli con mod "preconfigured" ipv4.addresses 192.168.0.118/24   ipv4.gateway 192.168.0.1 ipv4.dns 8.8.8.8 ipv4.method manual
sudo reboot
```

### Firewall

If the phone cannot reach the page, the Pi's firewall is the usual cause:

```bash
sudo ufw allow 8080/tcp      # only if ufw is enabled
```

On Windows, allow Node through the Private network profile when prompted.

### The staff dashboard

`http://<pi-address>:8080/admin` — jobs today, sheets, revenue, awaiting pickup, failures, a 7-day
chart, the full job list, printer health, and the same QR code so staff can help a student who
cannot scan it from the kiosk.
