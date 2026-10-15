# Deploying PrintKiosk

Read this page before you start. It will save you a wasted evening.

---

## The one thing to understand first

**The code in this repo will not run on Vercel as it is.**

`server.js` is a long-running Node HTTP server. It holds print jobs in memory, streams live
progress over SSE, writes uploaded PDFs to `data/`, and shells out to `lp`. Vercel runs **serverless
functions**: each request gets a fresh container that lives a few seconds, has a read-only disk, and
disappears. Nothing survives between requests.

So deploying this repo to Vercel does not give you a working kiosk. It gives you a 404.

There are three honest options.

| Option | Effort | What you get |
|---|---|---|
| **A. Render / Railway** | ~10 min, **no code changes** | The whole thing online, exactly as it works now |
| **B. Vercel** | A rewrite (half a day) | Upload + payment online; printing still on the Pi |
| **C. Stay on the LAN** | 0 min | Everything works; phone must be on campus Wi-Fi |

**And in every option, printing still happens on the Raspberry Pi.** No cloud host can reach your
printer. The Pi always does the paper.

---

## Option A — Render (what "easiest" actually means)

Render runs a normal Node process, so your existing code works untouched. This is the one to pick if
you want it online today.

### A1. Push your code (already done)

Your repo is at `https://github.com/SUDHEER052006/printkiosk-pi`.

### A2. Create the service

1. Go to **render.com** → sign up (free, GitHub login works).
2. **New +** → **Web Service**.
3. **Public Git repository** → paste `https://github.com/SUDHEER052006/printkiosk-pi` → **Connect**.
   (Because the repo is public, this works from *any* account — you do not need to own the GitHub repo.)
4. Fill in:
   - **Name**: `printkiosk`
   - **Runtime**: `Node`
   - **Build Command**: leave **empty** (there are no dependencies)
   - **Start Command**: `node server.js`
   - **Instance Type**: **Free**
5. **Advanced → Add Environment Variable**, add these:

   | Key | Value |
   |---|---|
   | `PAYMENT_MODE` | `upi_manual` |
   | `UPI_VPA` | `your-upi-id@ybl` |
   | `UPI_NAME` | `PrintKiosk IDEA Lab` |
   | `SIM_ENABLED` | `false` |
   | `PRINTER_DRIVER` | `mock` |
   | `ADMIN_TOKEN` | a long random string you invent |

   `PRINTER_DRIVER=mock` is deliberate: the cloud server has no printer. It accepts jobs and marks
   them ready; the Pi does the printing (step A4).

6. **Create Web Service**. Two minutes later you get `https://printkiosk-xxxx.onrender.com`.

### A3. Use it

- Students: `https://printkiosk-xxxx.onrender.com/upload` — works on mobile data, anywhere.
- You: `https://printkiosk-xxxx.onrender.com/admin?token=YOUR_ADMIN_TOKEN` (enter it once).
- Kiosk monitor: point the Pi's browser at `https://printkiosk-xxxx.onrender.com/`.

> **Free tier caveat:** Render sleeps a free service after 15 minutes idle, and the next request
> takes ~30 seconds to wake it. Fine for a demo. For a real kiosk, the $7/month tier stays awake.

> **Storage caveat:** Render's free disk is ephemeral — uploaded PDFs and the order list are lost on
> restart. Fine for a demo, and jobs are meant to be short-lived anyway. For permanence you need a
> database, which is the same work as Option B.

### A4. Connect the printer

On the Pi, run the agent in **worker mode** pointed at your cloud URL, so it pulls paid jobs and
prints them. That code does not exist yet — see "What still needs building" at the bottom.

Until then: run the Pi locally as you do now, and use the cloud site as the student-facing half.

---

## Option B — Vercel

Pick this only if you specifically need Vercel. It is more work, not less.

### What has to be rewritten

| Now | On Vercel |
|---|---|
| One `server.js` with routes | One file per route in `api/` |
| `data/` on disk | Supabase (or Vercel Postgres + Blob) |
| Jobs held in memory | Rows in a table |
| SSE live progress | Polling |
| `lp` to CUPS | Removed — the Pi does it |

### B1. Make a Supabase project

1. **supabase.com** → new project (free). Pick a region near you.
2. **SQL Editor** → run this:

   ```sql
   create table documents (
     id bigserial primary key,
     stored_filename text not null unique,
     original_filename text not null,
     mime_type text not null,
     size_bytes bigint not null,
     page_count integer not null,
     storage_path text,
     created_at timestamptz default now(),
     deleted_at timestamptz
   );

   create table orders (
     id bigserial primary key,
     order_id text unique,
     document_id bigint references documents(id),
     paper_size text default 'A4',
     colour_mode text default 'bw',
     duplex integer default 0,
     copies integer default 1,
     amount integer not null,
     pickup_otp text not null,
     payment_status text not null default 'PENDING',
     print_status text not null default 'CREATED',
     payment_ref text,
     payment_claimed_at timestamptz,
     payment_verified_at timestamptz,
     printed_at timestamptz,
     failure_reason text,
     created_at timestamptz default now()
   );

   create table throttle (
     key text primary key,
     count integer default 0,
     strikes integer default 0,
     locked_until timestamptz,
     updated_at timestamptz default now()
   );
   ```

3. **Storage** → **New bucket** → name it `print-documents` → keep it **private**.
4. **Project Settings → API** → copy the **Project URL** and the **service_role** key.
   The service_role key bypasses all security. Never put it in a browser or a public repo.

### B2. Build the serverless app

This is the actual work. You need, under `web/`:

```
web/
  package.json          { "type": "module" }
  lib/                  pricing.js, pdf.js, qr.js, upi.js, db.js
  api/health.js         GET  — is Supabase reachable?
  api/upload.js         POST — signed upload URL, then count pages
  api/orders.js         POST — price it, create the order + OTP
  api/order-status.js   GET  — the phone polls this
  api/upi-qr.js         GET  — QR with the amount in it
  api/payments-claim.js POST — "I have paid"
  api/payments-approve.js POST — staff approve (token required)
  api/stats.js          GET  — dashboard data
  api/kiosk-verify.js   POST — OTP typed at the kiosk
  api/worker.js         GET/POST — the Pi pulls jobs and reports back
  public/               upload.html, admin.html, kiosk.html, assets/
```

I have already adapted and verified `pricing.js`, `pdf.js`, `qr.js`, `upi.js` and written `db.js`
into `web/lib/` in your working folder — uncommitted. The `api/` routes and the page rewiring are
what remains.

**One gotcha that will bite you:** a Vercel function can only receive about **4.5 MB** of request
body. A scanned PDF is bigger. So the browser must upload **straight to Supabase** with a signed
URL, and only tell your API where it landed. `db.js` already has `createSignedUploadUrl` for this.

### B3. Deploy to a *different* Vercel account

The CLI is the easiest route for a second account — no GitHub linkage at all.

```bash
cd D:\printkiosk-pi\web

npx vercel logout          # drop any account you are already signed into
npx vercel login           # sign in with the OTHER account's email
npx vercel                 # first deploy: answer the prompts, it creates the project
```

When asked "In which directory is your code located?" answer `./` (you are already inside `web`).

Then add the secrets:

```bash
npx vercel env add SUPABASE_URL production
npx vercel env add SUPABASE_SERVICE_ROLE_KEY production
npx vercel env add UPI_VPA production
npx vercel env add UPI_NAME production
npx vercel env add ADMIN_TOKEN production
```

And ship it:

```bash
npx vercel --prod
```

> Prefer the dashboard? On the other account: **Add New → Project → Import Third-Party Git
> Repository** and paste the public repo URL. Then set **Root Directory** to `web` in project
> settings. Because the repo is public, the other account can import it without owning it.

### B4. Point the Pi at it

Same as A4 — the Pi polls your Vercel URL for paid jobs and prints them.

---

## Option C — stay on the LAN

What you have now. `bash run.sh` on the Pi; phone scans the QR on the monitor. No accounts, no bills,
and it keeps working when the campus internet drops — which is worth something during a viva.

The only thing it cannot do is accept uploads from mobile data.

---

## What still needs building (for A or B)

The Pi currently owns everything. To split it across a cloud host it needs a **worker mode**:

1. Poll `GET /api/worker?token=...` every few seconds for orders that are `PAID` and
   `READY_FOR_KIOSK`.
2. Download the PDF with a signed URL.
3. Print it with the existing CUPS driver (already written and working).
4. `POST /api/worker` to mark it printed, which triggers the shredding.

That is roughly 120 lines in `src/worker.js` plus the matching cloud endpoint. Nothing conceptually
hard — the Pi only ever makes outbound requests, so no port forwarding, no public IP, no firewall
exception.

---

## Honest recommendation

- **Demo tomorrow?** Option C. It already works.
- **Want it online with least effort?** Option A (Render). No code changes.
- **Vercel specifically required?** Option B, and budget an afternoon.

In all three, the Raspberry Pi is what prints. That never moves to the cloud.
