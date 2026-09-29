# Deploying to Render

The flow you want, and where each step runs:

```
  1. student's phone            uploads the PDF, pays
     ANY network, any Wi-Fi  ──────────────────────────────┐
                                                           ▼
  2. Render  https://your-app.onrender.com      ┌──────────────────────┐
     upload page  /upload                       │  prices the job      │
     admin        /admin                        │  holds the PDF       │
     kiosk        /                             │  holds the code      │
                                                └──────────┬───────────┘
  3. staff approve at /admin within 30s                    │
     the 6-digit code appears on the phone                 │  outbound https
                                                           │  long poll
  4. student types the code on the kiosk screen            ▼
                                            ┌──────────────────────────┐
  5. agent.js on the Pi/PC at the printer   │  downloads the PDF       │
                                            │  spools it to CUPS       │
                                            │  reports progress back   │
                                            └────────────┬─────────────┘
                                                         ▼
                                                   Canon MF240 — paper
```

**Render cannot print.** A serverless/container host has no CUPS, no USB, no
printer and no route into your LAN. So Render runs everything except the paper,
and `agent.js` — on the machine actually wired to the printer — comes and
collects the work.

The agent only ever makes **outbound** HTTPS requests. That is the whole trick:
it needs no port forwarding, no static IP, no firewall rule and no VPN. Put the
Pi on the campus Wi-Fi, on a phone hotspot, on a home router behind CGNAT — it
reconnects and keeps printing. That is also what makes the student's side work
from *any* network: everything they touch is a public URL.

---

## 1. Push the repo

```bash
git add -A
git commit -m "Cloud mode: Render web app + local print agent"
git push
```

## 2. Create the service

Render → **New** → **Blueprint** → pick this repo. `render.yaml` is read
automatically and sets:

| Variable | Value | Why |
|---|---|---|
| `CLOUD` | `true` | hand printing to the agent instead of looking for a local printer |
| `PAYMENT_MODE` | `upi_manual` | a human approves every payment |
| `SIM_ENABLED` | `false` | no free-print simulator on a public URL |
| `APPROVAL_SLA_MS` | `30000` | the 30-second approval promise |
| `ADMIN_TOKEN` | generated | unlocks approvals at `/admin` |
| `AGENT_TOKEN` | generated | what the print agent authenticates with |
| `UPI_VPA` | *you type it* | your UPI ID, e.g. `yourname@okhdfcbank` |

Not using the blueprint? Create a **Web Service** by hand with
build `npm install`, start `node server.js`, and set those variables yourself.

## 3. Copy the two tokens

Render → your service → **Environment**. Copy `ADMIN_TOKEN` and `AGENT_TOKEN`.

* `ADMIN_TOKEN` — open `https://your-app.onrender.com/admin?token=<ADMIN_TOKEN>`
  once on the desk laptop or phone. It is stored in that browser and the `?token=`
  drops out of the address bar. Without it the dashboard can view but not approve.
* `AGENT_TOKEN` — goes on the print station, next step.

## 4. Start the print station

On the Raspberry Pi (or the Windows PC) that has the printer:

```bash
git clone https://github.com/SUDHEER052006/printkiosk-pi.git
cd printkiosk-pi

# Pi: make sure CUPS can see the printer first
lpstat -p -d

bash run-agent.sh https://your-app.onrender.com <AGENT_TOKEN> Canon_MF240
```

Windows:

```bat
run-agent.bat https://your-app.onrender.com <AGENT_TOKEN> "Canon MF240"
```

Or put it in the station's own `.env` and just run `npm run agent`:

```
CLOUD_URL=https://your-app.onrender.com
AGENT_TOKEN=<the value from Render>
PRINTER_NAME=Canon_MF240
```

You should see:

```
  connected to https://your-app.onrender.com
  driver      cups
  printer     Canon_MF240
  waiting for print jobs...
```

`/admin` now shows **Print station: <hostname>** and the top-right pill turns
green. Until it does, the kiosk refuses codes with *"The print station is
offline"* rather than taking a code and hanging — the code stays valid.

### Keep it running

Pi, as a service:

```bash
sudo tee /etc/systemd/system/printkiosk-agent.service >/dev/null <<'EOF'
[Unit]
Description=PrintKiosk print agent
After=network-online.target cups.service

[Service]
WorkingDirectory=/home/pi/printkiosk-pi
ExecStart=/usr/bin/node agent.js
Restart=always
RestartSec=5
User=pi
EnvironmentFile=/home/pi/printkiosk-pi/.env

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now printkiosk-agent
journalctl -u printkiosk-agent -f
```

## 5. Walk the flow once

1. **Phone** (any network): open `https://your-app.onrender.com/upload`, pick a
   PDF, choose copies/duplex/colour, tap **Continue to payment**.
2. Pay with the UPI QR, tap **I have paid**. The phone starts a 30-second
   countdown and says the desk is confirming.
3. **Desk**: `/admin` → *Awaiting payment*. The card shows the amount, the UTR
   and a bar counting down from 30s. Press **Payment received**.
4. The 6-digit code appears on the student's phone within a second.
5. **Kiosk** (`https://your-app.onrender.com/` on the touchscreen): type the
   code → the agent downloads the PDF, prints it, and progress animates on the
   screen as it happens.
6. The PDF is deleted from Render and from the station the moment it prints. The
   code cannot be used twice.

---

## Things worth knowing before the demo

**The dashboard must stay reachable in 30 seconds.** Render's free plan sleeps
after 15 minutes with no traffic, and a cold start takes ~30–50s. In practice the
print agent long-polls every 25 seconds, which keeps the service permanently
awake — so as long as the agent is running, there is no cold start. If you will
run the demo without the agent, upgrade to a paid instance or open the URL a
minute beforehand.

**Render's disk is ephemeral.** A restart or a redeploy wipes uploaded PDFs and
the order history. It never breaks a live job (the whole cycle is seconds), but
do not treat the dashboard totals as permanent records. Add a Render disk with
`DATA_DIR` pointed at it, or swap `src/store.js` for Postgres, if you need
history to survive.

**Nothing confirms a UPI payment automatically, by design.** A personal VPA has
no API — no one can ask a bank "was `PK-2026-000012` paid?". The approval step is
not a placeholder for an integration; it *is* the verification. See `PAYMENTS.md`.

**The 30 seconds is a promise, not a guillotine.** The clock goes red and the
card is flagged when it runs out, but the order is not cancelled — the money has
already moved, so a late approval still has to release the code. Rejecting is
always a deliberate press of **Reject**.

**Two tokens, two jobs.** `ADMIN_TOKEN` releases money; `AGENT_TOKEN` moves paper.
Never put either in the repo. In cloud mode the "approvals only from the kiosk
machine" fallback is switched off — there is no such machine on Render — so
without `ADMIN_TOKEN` nobody can approve anything, and the server says so at boot.

## Running it all on the LAN instead

Nothing above is required for a single-building setup. Leave `CLOUD` unset and
`server.js` prints by itself, exactly as before:

```bash
bash run.sh --printer Canon_MF240 --upi you@okhdfcbank
```

The phone then has to be on the same Wi-Fi. Cloud mode exists to remove that one
restriction.
