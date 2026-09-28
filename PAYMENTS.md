# Payments — can I just use my UPI QR?

**Yes for a prototype, but not on its own.** Read the next section before you build on it.

---

## The thing nobody tells you about UPI QR codes

A personal UPI QR is a **one-way instruction to the payer's app**. When the student pays:

- the confirmation goes to *their* phone,
- the money lands in *your* bank account,
- and **nothing is sent to your software.**

There is no API where you can ask "was order PK-2026-000012 paid?" for a personal VPA. NPCI does not
expose one, and your bank does not either unless you have a merchant account.

So a static UPI QR **can never, by itself, decide whether to release a print job**. Anything that
claims otherwise is either using a payment gateway, or trusting the student.

That leaves three honest options, and this project implements all three.

---

## The three modes

Set with `PAYMENT_MODE`.

| Mode | How a job becomes printable | Use when |
|---|---|---|
| `sim` | Marked paid instantly | Demos and development. **Free printing.** |
| `upi_manual` | Student pays → submits UPI reference → staff approve in the dashboard | **Prototype with real money.** Attended kiosk. |
| `webhook` | An HMAC-signed callback marks it paid | Later, with a gateway or an SMS relay |

---

## `upi_manual` — what you asked for

```bash
bash run.sh --upi yourname@okhdfcbank --printer "Canon_MF240"
```

or explicitly:

```bash
PAYMENT_MODE=upi_manual UPI_VPA=yourname@okhdfcbank UPI_NAME="PrintKiosk IDEA Lab" node server.js
```

### What the student sees

1. Uploads a PDF, picks settings. The price is computed by the server.
2. **Step 3 — Pay.** A UPI QR appears with **the exact amount and the order id already filled in**.
   It is a proper `upi://pay?pa=…&am=30.00&cu=INR&tn=PrintKiosk PK-2026-000001` intent, so any UPI
   app opens with the amount pre-set. On a phone there is also an **Open UPI app** button.
3. They pay, then type the **12-digit UPI reference** (their app calls it "UPI transaction ID" or
   "UTR") and tap **I have paid**.
4. The page says *"Waiting for confirmation…"* and **polls the kiosk every 3 seconds.**
5. The moment staff approve, the 6-digit pickup code appears on their phone — no refresh needed.

### What staff see

The dashboard at `/admin` grows a **Payments to verify** card showing the amount, the filename, the
UTR, and the time claimed. Staff check the amount arrived (bank app notification or passbook) and
click **Received** — or **Reject**.

Approving flips the order to `PAID` + `READY_FOR_KIOSK`, which is the only thing that makes the OTP
work at the keypad.

### Why it is safe enough for a prototype

- **The code is withheld until payment is recognised.** An unpaid order returns `otp: null` from
  every endpoint. The code exists in the database but is never sent to the phone.
- **One UTR, one job.** Re-using a reference on a second order returns `409`. Otherwise one ₹10
  payment prints all term.
- **The amount is never taken from the client.** It is recomputed from the stored page count.
- **Approval is gated.** With `ADMIN_TOKEN` set it needs that token; without one, approvals are
  accepted **only from the kiosk machine itself**, so nobody on the Wi-Fi can approve their own
  payment.

### What it does not do

It does **not** verify the UTR against a bank. A student could invent 12 digits. That is exactly
what the staff click is for — this is an **attended** flow. Do not leave it unattended overnight and
expect the money to match.

---

## `webhook` — when you want it automatic

```bash
PAYMENT_MODE=webhook PAYMENT_WEBHOOK_SECRET="a-long-random-string" node server.js
```

Then `POST /api/payments/webhook` with an `X-Signature` header holding the HMAC-SHA256 of the raw
body, keyed with that secret — the exact scheme your project report specifies for Razorpay:

```bash
BODY='{"orderId":1,"amount":30,"utr":"412345678901"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "a-long-random-string" -r | cut -d' ' -f1)
curl -X POST http://localhost:8080/api/payments/webhook \
     -H "Content-Type: application/json" -H "X-Signature: $SIG" -d "$BODY"
```

Verified behaviour:

| Request | Response |
|---|---|
| No signature | `401` |
| Wrong signature | `401` |
| Amount that disagrees with the order | `409` |
| Valid | `200`, order PAID, OTP released |

Two ways to feed it:

**A. A real gateway** — Razorpay, Cashfree or PhonePe give you a dynamic UPI QR *and* a webhook.
This is the only route that is genuinely automatic and auditable. Needs KYC and a merchant account;
Razorpay's test mode works today with no money.

**B. An SMS/notification relay** (the classic student hack) — an old Android phone with your bank
app installed, plus a small app that forwards payment SMS to the Pi. Parse the amount and the UTR,
sign it, POST it. Cheap and genuinely automatic; fragile, because it breaks whenever the bank
changes its SMS wording, and it depends on that phone staying on the network.

---

## Which should you actually use?

For a **college prototype with a person nearby**: `upi_manual`. It is honest, needs no KYC, no
gateway, no fees, and it demos well — the examiner can watch the phone poll and the code appear the
instant you click Received.

For **unattended, real money**: a payment gateway. Nothing else gives you a verifiable record.

For a **viva demo with no money at all**: `sim`, and say so plainly.

---

## The thing to never forget

`PAYMENT_MODE=sim` prints for free. It is the default when `SIM_ENABLED` is not turned off, because
that is what makes development bearable. Before students touch the kiosk:

```bash
PAYMENT_MODE=upi_manual SIM_ENABLED=false UPI_VPA=you@okhdfcbank node server.js
```

The dashboard shows the active mode in its header and puts an amber banner across the top while
simulation is on, so you cannot leave it that way by accident.
