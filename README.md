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

---

## Quick start (simulation — no printer needed)

```bash
cd printkiosk-pi
PRINTER_DRIVER=mock node server.js
```

Then:

1. Open **http://localhost:8080/sim** — this stands in for the phone app and the Razorpay webhook.
2. Set pages/copies/duplex, click **Create paid order**. It shows a 6-digit OTP.
3. Open **http://localhost:8080/** — the kiosk keypad.
4. Type the OTP, press **RELEASE MY PRINTOUT**, and watch the job run.

In mock mode a receipt and a copy of the document land in `data/mock-prints/`.

Prove the whole pipeline in one command:

```bash
node scripts/selftest.js
```

```
  PASS  agent is up
  PASS  TC-02 duplex math  5p x2 duplex = 6 sheets, Rs.18
  PASS  report example    7p x2 duplex = 8 sheets, Rs.24
  PASS  TC-01 order created + pages parsed
  PASS  TC-06 wrong OTP rejected
  PASS  TC-05 correct OTP releases job
  PASS  job reached COMPLETED
  PASS  TC-07 document shredded after print
  PASS  OTP cannot be reused
```

---

## Real printing

```bash
node scripts/list-printers.js          # find the exact queue name
PRINTER_NAME="Canon_MF240" node server.js
```

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

---

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/kiosk/verify-otp` | Release a paid job — the keypad's only write |
| `GET` | `/api/jobs/:id/events` | SSE live progress (drives the screen) |
| `GET` | `/api/jobs/:id` | Poll fallback if SSE drops |
| `GET` | `/api/health` | Driver, queue and kiosk status |
| `GET` | `/api/orders` | Order list |
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
src/pdf.js             dependency-free PDF writer for simulation
src/printer.js         Hardware Abstraction Layer: cups | windows | mock
src/jobs.js            lifecycle, progress bus, shredding, error mapping
public/kiosk.html      the touchscreen keypad
public/sim.html        simulator console (phone app + Razorpay stand-in)
scripts/selftest.js    end-to-end test of the report's test cases
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
- **Set `SIM_ENABLED=false` on a real kiosk.** Otherwise `/sim` will mint free paid orders.
