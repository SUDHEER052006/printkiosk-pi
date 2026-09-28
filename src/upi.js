/**
 * UPI payment intent helpers.
 *
 * IMPORTANT, and the reason this module is deliberately small:
 *
 * A personal UPI VPA has **no API**. Nothing on this Pi can ask NPCI or a bank
 * "was order PK-2026-000012 paid?". A UPI QR is a one-way instruction to the
 * payer's app; the confirmation goes to the payer's phone and to the payee's
 * bank, never to us. So a static UPI QR alone can never gate a print job.
 *
 * What this file does is build a correct payment intent (with the amount and
 * the order id pre-filled, so reconciliation is possible) and leave the actual
 * "did it arrive?" decision to one of the three modes in config.paymentMode:
 *
 *   sim          - marked paid immediately. Demos only.
 *   upi_manual   - student pays; a person approves it from the dashboard.
 *
 * Nothing confirms a payment automatically. That is the point: the only thing
 * that can release a print job is a human who has seen the money arrive.
 */

import config from './config.js';

/**
 * A VPA looks like name@bank. Kept permissive on purpose — handles range from
 * `a@ybl` to `9876543210@paytm` to `first.last@okhdfcbank`, and rejecting a
 * real one is far worse here than accepting a typo the bank will bounce.
 */
export function isValidVpa(vpa) {
  return typeof vpa === 'string' && /^[A-Za-z0-9._\-]{1,64}@[A-Za-z0-9]{2,32}$/.test(vpa.trim());
}

/**
 * Builds a `upi://pay?...` intent URI.
 * Amount is always sent with two decimals; apps reject "24" from some issuers.
 */
export function buildUpiUri({ amount, orderId, vpa = config.upi.vpa, name = config.upi.name }) {
  if (!isValidVpa(vpa)) throw new Error('UPI_VPA is not set or is not a valid VPA (name@bank)');

  const params = new URLSearchParams({
    pa: vpa.trim(),
    pn: name || 'PrintKiosk',
    am: Number(amount).toFixed(2),
    cu: 'INR',
    tn: `PrintKiosk ${orderId}`,
    tr: String(orderId).replace(/[^A-Za-z0-9]/g, ''),
  });

  return `upi://pay?${params.toString()}`;
}

/**
 * A UPI reference (UTR) is 12 digits. We cannot verify it against a bank from
 * here — it is recorded so a human can reconcile it against the passbook, and
 * so the same reference cannot be reused for a second free print.
 */
export function normaliseUtr(raw) {
  const s = String(raw ?? '').trim().replace(/\s+/g, '');
  return /^[0-9]{12}$/.test(s) ? s : null;
}


export default buildUpiUri;
