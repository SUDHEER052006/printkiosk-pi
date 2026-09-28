# What to push to Vercel

Short answer, and read this part before you deploy anything:

> **For the flow you just asked for — drag a PDF from your phone, type the code on the monitor —
> you do not need Vercel at all.** The Pi already serves the upload page on your Wi-Fi. Deploying
> to Vercel adds moving parts and cannot make printing work.

Vercel is worth it for exactly one reason: students on **mobile data**, or off campus, who want to
send a job before they walk over. If everyone is on campus Wi-Fi, skip this file.

---

## Why the printing half can never live on Vercel

A Vercel function runs in a short-lived container in a datacenter. It has:

- no CUPS and no printer driver,
- no USB port,
- no route into your campus LAN (the Pi has a private IP like `192.168.0.118`; nothing on the
  public internet can open a connection to it).

So `lp -d Canon_MF240 …` cannot run there. Printing happens on the machine wired to the printer.
That is the whole reason this Pi agent exists.

The split is fixed:

| Concern | Where it runs |
|---|---|
| Upload page, page counting, pricing, Razorpay | Vercel (optional) |
| Order + document storage | Supabase (optional) |
| **OTP keypad, spooling, shredding** | **Raspberry Pi — always** |

---

## Option A — LAN only (what you have now, nothing to deploy)

```
 phone  ──Wi-Fi──►  Raspberry Pi  ──USB──►  printer
                    serves /upload
                    serves /  (keypad on the monitor)
```

The kiosk screen shows a **QR code**; the student scans it, their phone opens
`http://192.168.0.118:8080/upload`, they pick a PDF, pay, get a code, and type it on the monitor.

Requirements: phone and Pi on the same Wi-Fi. That's it.

If the QR shows the wrong address (a laptop with VirtualBox or WSL has several fake adapters), pin
it:

```bash
KIOSK_HOST=192.168.0.118 node server.js
```

**Give the Pi a static IP** or a DHCP reservation on your router, otherwise the address changes
after a reboot and every printed poster with the QR on it goes stale.

---

## Option B — Vercel front end + Pi printing

```
 phone ──internet──► Vercel (upload, pricing, Razorpay)
                        │
                        ▼
                     Supabase  (orders + PDF storage)
                        ▲
                        │  Pi polls: "any PAID orders?"
 monitor ◄── Raspberry Pi ──USB──► printer
```

### What you push to Vercel

A **separate** repository — not this one. This repo is the Pi agent; pushing it to Vercel would
deploy a printing service that cannot print.

```
printkiosk-web/
├─ package.json
├─ vercel.json
├─ public/
│   └─ index.html          ← the upload page (start from this repo's public/upload.html)
└─ api/
    ├─ upload.js           ← receives the PDF, counts pages, stores it in Supabase
    ├─ orders.js           ← prices from the stored page count, creates the order + OTP
    └─ payment-verify.js   ← Razorpay HMAC-SHA256 check, marks the order PAID
```

Reuse from this repo, unchanged:

- `src/pricing.js` — the sheet maths
- `src/pdf.js` — `countPdfPages()` (validated against 44 real PDFs)
- `src/otp.js` — `generateOtp()`

Do **not** copy `src/printer.js` or `src/jobs.js`. Those are the Pi's job.

### Environment variables to set in Vercel

Project → Settings → Environment Variables:

| Name | Where it comes from |
|---|---|
| `SUPABASE_URL` | Supabase → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | same page — **server-side only, never in the browser** |
| `RAZORPAY_KEY_ID` | Razorpay dashboard |
| `RAZORPAY_KEY_SECRET` | Razorpay dashboard — **server-side only** |

### Deploy

```bash
cd printkiosk-web
npx vercel            # preview
npx vercel --prod     # production
```

Or connect the GitHub repo in the Vercel dashboard and let it deploy on push.

### Then point the Pi at Supabase

Replace **one file** on the Pi: `src/store.js`. It currently reads and writes a local JSON file and
exposes four functions:

```js
releasableOrders()      // PAID + READY_FOR_KIOSK
getDocument(id)
updateOrder(id, patch)
markDocumentShredded(id)
```

Re-implement those against Supabase and nothing else in the Pi agent changes.

Use **pull, never push**: the Pi polls Supabase (or subscribes to Realtime on `orders`) for
`payment_status = 'PAID' AND print_status = 'READY_FOR_KIOSK'`, then downloads the PDF with a signed
URL. Only outbound connections, so no public IP, no port forwarding, no firewall exception, no
tunnel. Every campus network allows this; almost none allow the reverse.

---

## What to do about `SIM_ENABLED`

Right now `POST /api/orders` marks orders **PAID immediately** so you can test without money moving,
and `/sim` can mint free paid orders. Both are gated behind `SIM_ENABLED`.

The moment real students use the kiosk:

```bash
SIM_ENABLED=false node server.js
```

With it off, an order stays `PENDING` until something verifies a real payment — which is exactly the
job of the Vercel `payment-verify.js` endpoint above. **Until you build that, leave the kiosk on the
LAN and treat it as a demo**, or anyone who can reach `/upload` prints for free.

---

## Cost check before you commit to this

| | LAN only | Vercel + Supabase |
|---|---|---|
| Monthly cost | ₹0 | ₹0 on free tiers, until you exceed them |
| Works when campus internet is down | **yes** | no |
| Works on mobile data / off campus | no | yes |
| Moving parts that can break | 1 | 4 |
| Razorpay needed | no | yes, for real money |

For a college project demo, Option A demos better: it keeps working when the campus Wi-Fi drops
during your viva, and you can explain the architecture honestly — *"the web tier is optional; the
part that matters is on this Pi, because that is the only machine that can reach the printer."*
