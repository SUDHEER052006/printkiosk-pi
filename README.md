# PRINTKIOSK — Raspberry Pi kiosk agent

The touchscreen keypad and the code that actually moves paper.

This is the piece the project report puts on Vercel but that **cannot run there**: a serverless
function has no CUPS, no printer and no route into the campus LAN. Spooling has to happen on the
machine physically wired to the printer. That machine is this one.

```
  student phone ──► Vercel web app ──► Supabase        (upload, pricing, Razorpay)
                                          │
                                          │  order PAID + READY_FOR_KIOSK
                                          ▼
                    Raspberry Pi ──► THIS AGENT ──► CUPS ──► Canon MF240
                    (touchscreen)      keypad UI            (paper)
```

Zero npm dependencies. Node 18+ and nothing else.

Four surfaces, all served by the Pi:

| Path | Who uses it |
|---|---|
| `/` | the kiosk touchscreen — OTP keypad, and a QR code to send from a phone |
| `/upload` | the student's phone — pick a PDF, pay, get a 6-digit code |
| `/admin` | staff — jobs, sheets, revenue, printer health |
| `/sim` | you — mint test orders without a real upload |

See **`PAYMENTS.md`** for how UPI payment actually works here (and the one thing nobody tells you
about UPI QR codes), **`VERCEL.md`** for what belongs on Vercel (short version: not the printing, and for a
LAN-only setup, nothing) and **`REPORT-COMPLIANCE.md`** for a section-by-section audit against the
project report.

---

## Quick start

```bash
bash run.sh                                   # Linux / Raspberry Pi / macOS
run.bat                                       # Windows
```

One command: checks Node, checks the printer, starts the agent, waits until it answers, and opens
the dashboard. **It prints for real by default** — if no printer is set up it stops and tells you
how to add one rather than quietly simulating.

```bash
bash run.sh --printer "Canon_MF240"           # pin a queue
bash run.sh --upi you@okhdfcbank              # turn on UPI payment
bash run.sh --install                         # also install Node + CUPS
bash run.sh --service                         # install as a boot service
bash run.sh --sim                             # no printer, simulate (opt-in)
```

Then:

1. Open **http://localhost:8080/upload** — the student's page (or scan the QR on the kiosk screen
   from your phone). Drag in any real PDF.
   The server reads it and reports the actual page count, then prices it from that.
2. Choose copies / colour / duplex and press **Pay & get pickup code**. A 6-digit OTP appears.
3. Open **http://localhost:8080/** — the kiosk keypad.
4. Type the OTP, press **RELEASE MY PRINTOUT**, and watch the job run.

**http://localhost:8080/sim** is the shortcut path: it mints orders against a generated PDF and
lists every order with its status — handy for repeat tests.

In mock mode a receipt and a byte-identical copy of the printed document land in `data/mock-prints/`.

Prove the whole pipeline in one command:

```bash
node scripts/selftest.js
```

```
  PASS  agent is up
  PASS  TC-02 duplex math  5p x2 duplex = 6 sheets, Rs.18
  PASS  report example    7p x2 duplex = 8 sheets, Rs.24
  PASS  upload accepts a real PDF and counts its pages
  PASS  TC-03 non-PDF content rejected
  PASS  TC-03 .exe extension rejected
  PASS  uploaded doc priced from the STORED page count
  PASS  TC-01 order created + pages parsed
  PASS  TC-06 wrong OTP rejected
  PASS  TC-05 correct OTP releases job
  PASS  job reached COMPLETED
  PASS  TC-07 document shredded after print
  PASS  OTP cannot be reused

  16 passed, 0 failed
```

---

## Real printing

```bash
node scripts/list-printers.js          # find the exact queue name
node scripts/testprint.js --printer "Canon_MF240"   # one page, straight to the hardware
PRINTER_NAME="Canon_MF240" node server.js
```

`testprint.js` bypasses the server, the OTP and the order entirely — it is the fastest way to tell a
printer problem from a software problem when you first plug the hardware in.

Drop `PRINTER_DRIVER` entirely and the agent auto-detects: CUPS on Linux/Pi/macOS, the Windows
spooler on Windows, mock if neither is present. Anything other than `mock` prints for real.

**Raspberry Pi, one command:**

```bash
bash scripts/install-pi.sh "Canon_MF240"
```

That installs Node + CUPS + Chromium, registers `printkiosk.service` under systemd, and sets
Chromium to open the keypad fullscreen on boot (no cursor, no address bar, no screen blanking).
Reboot and the kiosk is live.

```bash
sudo systemctl status printkiosk
journalctl -u printkiosk -f
```

---

## Configuration

Everything is an environment variable; every one has a working default.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `PRINTER_DRIVER` | `auto` | `auto` \| `cups` \| `windows` \| `mock` |
| `PRINTER_NAME` | system default | Exact queue name |
| `DATA_DIR` | `./data` | Documents + JSON store |
| `SIM_ENABLED` | `true` | Exposes `/sim`. **Set `false` on a deployed kiosk.** |
| `SHRED_ON_COMPLETE` | `true` | Zero-trace delete after printing |
| `KIOSK_RESET_MS` | `20000` | "Next customer" auto-reset |
| `OTP_TTL_HOURS` | `24` | Code lifetime |
| `OTP_MAX_ATTEMPTS` | `5` | Wrong entries before backoff |
| `PRINT_TIMEOUT_MS` | `180000` | Give up on a stuck queue |
| `MOCK_DURATION_MS` | `7000` | Simulated print duration |
| `SUMATRA_PATH` | auto-detect | Windows silent PDF printing |
| `KIOSK_HOST` | auto-detect | Force the LAN address shown in the QR code |
| `PAYMENT_MODE` | `sim` | `sim` or `upi_manual` - see `PAYMENTS.md`. Nothing auto-confirms. |
| `UPI_VPA` | — | Your UPI ID, e.g. `you@okhdfcbank` |
| `UPI_NAME` | `PrintKiosk` | Payee name shown in the UPI app |
| `ADMIN_TOKEN` | — | Required for staff approval; without it, localhost only |
| `UPLOAD_MAX_BYTES` | `26214400` | Upload limit (25 MB) |
| `UPLOAD_MAX_PAGES` | `200` | Page limit for one job |

---

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/upload` | Upload a real PDF; returns the parsed page count |
| `POST` | `/api/orders` | Price and create an order from an uploaded document |
| `POST` | `/api/kiosk/verify-otp` | Release a paid job — the keypad's only write |
| `GET` | `/api/jobs/:id/events` | SSE live progress (drives the screen) |
| `GET` | `/api/jobs/:id` | Poll fallback if SSE drops |
| `GET` | `/api/health` | Driver, queue and kiosk status |
| `GET` | `/api/orders` | Order list |
| `GET` | `/api/stats` | Dashboard metrics (KPIs, 7-day series, recent jobs) |
| `GET` | `/api/qr` | QR code SVG for the upload URL |
| `GET` | `/api/orders/:id/status` | Payment status; returns the OTP only once paid |
| `GET` | `/api/upi-qr` | UPI payment QR for one order (amount pre-filled) |
| `POST` | `/api/payments/claim` | Student submits the 12-digit UPI reference |
| `POST` | `/api/payments/approve` | Staff confirm or reject a payment - the only way a job is released |
| `POST` | `/api/sim/order` | **sim only** — create a paid order |
| `POST` | `/api/sim/quote` | **sim only** — price without ordering |
| `POST` | `/api/sim/reset` | **sim only** — wipe everything |

---

## Wiring it to the real backend

Replace **one file**: `src/store.js`. It exposes `releasableOrders()`, `getDocument()`,
`updateOrder()` and `markDocumentShredded()` against a local JSON file. Point those at Supabase
instead and nothing else changes.

The pull pattern that avoids firewall work: have the Pi poll Supabase (or subscribe to Realtime on
`orders`) for `payment_status = PAID AND print_status = READY_FOR_KIOSK`, download via a signed URL,
and let the existing job pipeline do the rest. Vercel keeps the web app, pricing and Razorpay; the
Pi keeps the paper.

---

## What each file does

```
server.js              HTTP server, routing, SSE, boot banner
src/config.js          env-var configuration
src/store.js           documents + orders  (swap this for Supabase)
src/pricing.js         report section 7 sheet maths, server-authoritative
src/otp.js             generation, constant-time match, progressive backoff
src/pdf.js             PDF writer + real page counter (inflates ObjStms)
src/multipart.js       binary-safe form-upload parser
src/printer.js         Hardware Abstraction Layer: cups | windows | mock
src/jobs.js            lifecycle, progress bus, shredding, error mapping
src/qr.js              QR encoder (byte mode, ECC-M, versions 1-10)
src/upi.js             UPI intent building and UPI-reference checks
run.sh / run.bat       one-command start: deps, printer check, dashboard
public/kiosk.html      the touchscreen keypad
public/upload.html     student upload page (real PDFs, real page counts)
public/admin.html      operations console
public/sim.html        simulator console (generated PDFs, order list)
public/assets/         IDEA Lab logo, favicon, shared light theme
scripts/selftest.js    end-to-end test of the report's test cases
scripts/testprint.js   send one page straight to the hardware
scripts/install-pi.sh  one-shot Pi provisioning
```

---

## Security notes

- **Pricing is never sent by a client.** It is recomputed from the stored page count.
- **OTP matching is constant-time** across all releasable orders, so response timing cannot be used
  to narrow down digits.
- **Progressive backoff, not a flat lockout.** Every request on a kiosk comes from one IP — its own —
  so a 10-minute lockout would let one mistyper brick the machine for the whole queue. Instead a
  strike costs 30s, doubling to a 5-minute ceiling. That holds brute force to ~10 guesses/minute
  against 1,000,000 codes while an honest mistake costs half a minute.
- **An OTP is single use.** A completed order returns `ALREADY_PRINTED`.
- **A failed print returns the order to the queue** so the same OTP still works — paper jams must not
  cost a student their money.
- **Errors are mapped before display.** Raw messages leak filesystem paths onto a public screen; the
  technical text goes to the journal, a friendly line goes to the student.
- **Set `SIM_ENABLED=false` on a real kiosk.** Otherwise `/sim` mints free paid orders, and
  `/api/orders` marks new orders paid without a verified payment.
- **Uploads are validated by magic bytes, not by filename.** A `.pdf` that is really an executable
  is rejected; so are password-protected PDFs, whose pages cannot be counted and therefore cannot be
  priced honestly.
- **Stored filenames are UUIDs.** The student's own filename never reaches the filesystem, which
  closes the path-traversal route the report calls out.

## Page counting

`countPdfPages()` is validated against **pypdf across 44 real-world PDFs** — Word exports, LaTeX,
scanner output, Chrome print-to-PDF — with an exact match on all 44 in 126ms total. It reads the
page tree from the document's own dictionary (matching `<< >>` nesting, because a `/Kids` array can
run for kilobytes and a fixed character window reads a neighbouring node's `/Count`), and inflates
`/Type /ObjStm` compressed object streams with `zlib` for PDF 1.5+ files that keep the page tree
compressed. It returns `0` rather than a guess when it genuinely cannot tell, so the upload is
rejected instead of the student being charged for the wrong number of sheets.
