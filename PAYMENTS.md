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

So the only honest answer is: **a person confirms every payment.** That is how this kiosk works -
nothing auto-confirms, by design.

---

## The two modes

Set with `PAYMENT_MODE`.

| Mode | How a job becomes printable | Use when |
|---|---|---|
| `sim` | Marked paid instantly | Demos and development. **Free printing.** |
| `upi_manual` | Student pays, then **staff click Payment received at `/admin`** | Real money. Attended kiosk. |

There is deliberately no automatic-confirmation mode. `/api/payments/webhook` does not exist, and
the self test asserts it returns `404`.

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
3. They pay, then tap **I have paid**. They can also type the **12-digit UPI reference** (their app
   calls it "UPI transaction ID" or "UTR") - optional, and only there to help the desk find the
   payment faster.
4. The page says *"Waiting for confirmation…"* and **polls the kiosk every 3 seconds.**
5. The moment staff approve, the 6-digit pickup code appears on their phone — no refresh needed.

### What staff see

The dashboard at `/admin` has an **Awaiting payment** card listing **every** order that has not been
paid for - not only the ones where the student remembered to tap "I have paid". Each row shows the
amount, the document, the print spec, and either the UPI reference or *"no confirmation from the
phone yet"*.

Two buttons per row: **Payment received** and **Reject**.

- Rows the student has confirmed are highlighted and sorted to the top - someone is standing there.
- Approving a row the phone never reported asks you to confirm first, so a stray click cannot
  release a job.

Approving flips the order to `PAID` + `READY_FOR_KIOSK`, which is the only thing in the whole system
that makes an OTP work at the keypad.


### Why it is safe enough for a prototype

- **The code is withheld until payment is recognised.** An unpaid order returns `otp: null` from
  every endpoint. The code exists in the database but is never sent to the phone.
- **One UTR, one job.** Re-using a reference on a second order returns `409`. Otherwise one ₹10
  payment prints all term.
- **Claiming payment is not paying.** A student tapping "I have paid" changes nothing except adding
  a row to your queue. Only the staff click releases the code.
- **The amount is never taken from the client.** It is recomputed from the stored page count.
- **Approval is gated.** With `ADMIN_TOKEN` set it needs that token; without one, approvals are
  accepted **only from the kiosk machine itself**, so nobody on the Wi-Fi can approve their own
  payment.

### What it does not do

It does **not** verify the UTR against a bank. A student could invent 12 digits. That is exactly
what the staff click is for — this is an **attended** flow. Do not leave it unattended overnight and
expect the money to match.

---

## If you later want it automatic

Nothing here confirms payments automatically, and that is deliberate. The only route that removes
the manual step honestly is a payment gateway - Razorpay, Cashfree or PhonePe give you a dynamic UPI
QR *and* a signed webhook, which is the one way to get a verifiable record without a person. That
means KYC and a merchant account; Razorpay's test mode works today with no money.

When you get there, the change is a single endpoint that marks an order `PAID` after verifying the
gateway's signature - the same flip the **Payment received** button performs now.

---

## Which should you actually use?

For a **college prototype with a person nearby**: `upi_manual`. It is honest, needs no KYC, no
gateway, no fees, and it demos well — the examiner can watch the phone poll and the code appear the
instant you click **Payment received**.

For a **viva demo with no money at all**: `sim`, and say so plainly.

---

Either way the rule is the same: **the kiosk must be attended.** A human confirming the money is
the entire security model of this mode, and there is no substitute for it short of a gateway.

---

## The thing to never forget

`PAYMENT_MODE=sim` prints for free. It is the default when `SIM_ENABLED` is not turned off, because
that is what makes development bearable. Before students touch the kiosk:

```bash
PAYMENT_MODE=upi_manual SIM_ENABLED=false UPI_VPA=you@okhdfcbank node server.js
```

The dashboard shows the active mode in its header and puts an amber banner across the top while
simulation is on, so you cannot leave it that way by accident.
