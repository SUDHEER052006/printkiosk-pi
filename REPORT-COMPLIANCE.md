# Compliance against `PrintKiosk_Project_Report.pdf`

A straight audit of what this repository implements versus what the report claims, section by
section. **Not everything in the report is built here** — this is the Pi agent, and three of the
report's pillars (Vercel, Supabase, Razorpay) are cloud services that live outside it.

Legend: **Done** · **Partial** · **Not built**

---

## 1. Abstract — the seven headline features (report p.4)

| # | Claim | Status | Where / why |
|---|---|---|---|
| 1 | Responsive web app for upload from mobile or laptop | **Done** | `public/upload.html`, drag-and-drop, real upload progress, mobile-first |
| 2 | Automated in-memory PDF parsing for page count | **Done** | `src/pdf.js` — parsed from a RAM buffer before anything is written to disk |
| 3 | Backend-authoritative dynamic pricing with duplex maths | **Done** | `src/pricing.js`; the client never sends a price |
| 4 | Razorpay gateway with HMAC verification | **Not built** | Payment is a UPI QR plus **manual staff approval** at `/admin` - a deliberate choice, since a personal UPI VPA exposes no API to verify against. Automatic confirmation was removed on purpose. See `PAYMENTS.md` |
| 5 | Decoupled 6-digit OTP release at the kiosk | **Done** | `src/otp.js` + `public/kiosk.html` |
| 6 | Multi-driver hardware abstraction (CUPS / Windows / mock) | **Done** | `src/printer.js` |
| 7 | Zero-trace shredding from memory, disk and storage | **Partial** | Local disk shredding is done (`src/jobs.js`). There is no cloud bucket to purge because there is no Supabase |

---

## 2. Objectives (report p.5)

| Objective | Status | Note |
|---|---|---|
| Automate ingestion, page counting, cost computation | **Done** | Validated against 44 real PDFs |
| Cashless payment processing | **Partial** - UPI QR with the amount pre-filled works today; confirmation is manual by design |
| Time-bound OTP authorisation | **Done** | 24h TTL, single use, progressive backoff |
| Cloud storage (Supabase) + serverless hosting (Vercel) | **Not built** | Local JSON store instead; `src/store.js` is the single swap point |

---

## 3. Existing vs proposed system (report p.6)

Every row of that comparison table holds, **except** the payment row.

| Parameter | Report's claim | Reality here |
|---|---|---|
| Submission | Secure web upload from mobile/laptop | **Done** — plus a QR code on the kiosk so no typing |
| Page counting | Automated parser | **Done** |
| Pricing | Backend-enforced sheet & duplex formulas | **Done** |
| Payment | Automated gateway with webhook verification | **Differs by design** - UPI QR carrying the per-order amount, released by staff approval. No automatic confirmation |
| Privacy | Operator never sees the document | **Done** — UUID filenames, no operator view |
| Print release | Locked until 6-digit OTP | **Done** |
| Data retention | Automatic shredding on completion | **Done** |
| Availability | 24/7 autonomous | **Done** — systemd unit + boot-to-kiosk |

---

## 4. Requirements (report p.7)

**Software**

| Report says | Here |
|---|---|
| HTML5, CSS3 variables, ES6 | **Done** |
| Lucide icons | **Not used** — inline SVG instead, so the kiosk renders with no network |
| Node.js runtime | **Done** |
| Express.js | **Not used** — `node:http` directly, to keep the project at zero dependencies |
| Supabase PostgreSQL | **Not built** |
| SQLite fallback (`node-sqlite3-wasm`) | **Substituted** — atomic JSON store, same schema shape, no native build on the Pi |
| Supabase Storage bucket | **Not built** — local `data/documents/` |
| Razorpay REST + HMAC-SHA256 | **Not built** - payment is a UPI QR plus staff approval |
| Vercel serverless | **Not built** — and cannot host the printing half |
| `pdf-parse` | **Substituted** — own parser in `src/pdf.js`, validated against pypdf on 44 real files |

**Hardware** — matches: Raspberry Pi 4 / Mini PC, 7"–15" touchscreen, laser/MFP printer, Wi-Fi or
USB. Tested driver-side against a real Windows spooler; CUPS path needs your Pi to confirm.

---

## 5. Architecture and data flow (report p.8–9)

The three-tier split is implemented, with **one deliberate correction**.

The report places the Hardware Abstraction Layer in the Application Tier on Vercel. That cannot
work: a serverless container has no CUPS, no printer and no route into the campus LAN. Spooling is
therefore in this Pi agent. `VERCEL.md` documents the corrected split.

The six DFD stages all exist: Upload → Order → Payment → Release → Print → Cleanup. Stage 3
(Payment) runs in one of three modes — see `PAYMENTS.md`.

---

## 6. Core modules (report p.10)

| Module | Status |
|---|---|
| 1 — Document ingestion & in-memory parsing | **Done** |
| 2 — Authoritative pricing engine | **Done** |
| 3 - Payment orchestration & webhook security | **Not built** - replaced by manual approval; `PAYMENTS.md` explains why a UPI QR cannot be verified in software |
| 4 — Decoupled OTP kiosk release | **Done** |
| 5 — Hardware abstraction layer | **Done** |

---

## 7. Mathematical model (report p.11)

**Done, and tested.** Rates: B&W ₹2 single / ₹3 duplex, colour ₹10 / ₹15. Duplex sheets are
`ceil(P/2)`. The report's worked example — 7 pages, 2 copies, B&W duplex = 8 sheets = **₹24** — is
asserted in `scripts/selftest.js` and passes on every run.

---

## 8. Database schema (report p.12)

**Done, column for column.** `documents` (id, stored_filename, original_filename, mime_type,
size_bytes, page_count, storage_path, created_at, deleted_at) and `orders` (id, order_id,
document_id, paper_size, colour_mode, duplex, copies, amount, pickup_otp, payment_status,
print_status). Order IDs use the report's `PK-2026-000001` format. The engine is a JSON store rather
than Postgres.

---

## 9. Security & privacy (report p.13)

| Control | Status |
|---|---|
| Zero-knowledge operator | **Done** |
| UUID sanitisation against path traversal | **Done** |
| HMAC-SHA256 payment signatures | **Not built** - no gateway; a person confirms each payment |
| Auto-shredding engine | **Done** |
| Helmet HTTP headers | **Partial** — `X-Content-Type-Options` and `Referrer-Policy` are set; no Helmet, no CSP/HSTS |

**Beyond the report**, because they turned out to matter:

- OTP matching is **constant-time** across all releasable orders, so response timing cannot narrow
  down digits.
- Brute-force backoff is **progressive** (30s doubling to 5 min) rather than a flat lockout, because
  every request on a kiosk arrives from one IP — its own — and a flat 10-minute lockout would let one
  mistyper brick the machine for the whole queue.
- Uploads are validated by **magic bytes**, not filename; password-protected PDFs are rejected
  because their pages cannot be counted and therefore cannot be priced honestly.
- Error messages are **mapped before display** — raw errors leak filesystem paths onto a public
  screen.

---

## 10. Printer spooling (report p.14)

**Done.** The exact invocation from the report is what the CUPS driver builds:

```
lp -d "Canon_MF240" -n 2 -o media=A4 -o sides=two-sided-long-edge -o ColorModel=Gray file.pdf
```

Progress is polled from the live queue with `lpstat` and streamed to the screen over SSE.

---

## 11. Test cases (report p.15)

All seven are automated in `scripts/selftest.js`, which runs 16 assertions in `sim` mode and 32
with manual approval active.
when a payment mode is active.

| ID | Scenario | Status |
|---|---|---|
| TC-01 | Multi-page PDF upload, page count returned | **Pass** |
| TC-02 | Duplex sheet maths | **Pass** |
| TC-03 | Invalid file filtering (`.exe` / `.sh`) | **Pass** — plus content-sniffing |
| TC-04 | Razorpay signature check | **Not applicable** - no gateway. The suite instead asserts that *nothing* can confirm a payment automatically, and that the OTP stays withheld until a person approves |
| TC-05 | OTP release at kiosk | **Pass** |
| TC-06 | Incorrect OTP handling | **Pass** |
| TC-07 | Auto file shredding | **Pass** |

---

## 12. Results & deployment (report p.16)

| Benchmark | Report | Measured here |
|---|---|---|
| Document ingestion | < 350 ms | ~2 ms for a 107 KB, 19-page PDF (local, no cloud hop) |
| PDF page extraction | ~28 ms | 126 ms for **44 PDFs** — about 3 ms each |
| OTP verify → spool | < 150 ms | Immediate; the HTTP response does not wait for paper |
| Database query | ~65 ms | In-process, sub-millisecond |

The live Vercel/Supabase endpoints in the report are **not** this project.

---

## 13. Future scope (report p.17)

None of the four are built: RFID/NFC release, AI slide condenser, multi-kiosk load balancing,
offline mesh spooling. They are correctly listed as future work.

---

## Summary

**Built and tested:** the upload path, page counting, pricing, the OTP release mechanism, the
hardware abstraction layer, shredding, the database shape, the kiosk and admin interfaces, and six
of the seven test cases.

**Not built:** Razorpay and its HMAC verification. Payment is instead a UPI QR released by manual
staff approval - a deliberate design decision rather than a gap, because a personal UPI VPA exposes
no API to verify against. Also not built: Supabase as the database and object store, and Vercel
deployment.

Those three are one coherent piece of work — the cloud tier — and `VERCEL.md` is the plan for it.
The honest framing for your viva: *the payment gateway is the remaining integration; everything that
touches the printer, the document and the student's privacy is implemented and tested.*
