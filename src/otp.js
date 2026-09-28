import crypto from 'node:crypto';
import config from './config.js';
import * as store from './store.js';

/** Uniform 6-digit OTP from CSPRNG bytes (rejection sampling, no modulo bias). */
export function generateOtp(length = config.otp.length) {
  const max = 10 ** length;
  const limit = Math.floor(0xffffffff / max) * max;
  let n;
  do {
    n = crypto.randomBytes(4).readUInt32BE(0);
  } while (n >= limit);
  return String(n % max).padStart(length, '0');
}

const eq = (a, b) => {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
};

/* ----------------------------- attempt limiter ---------------------------- */

/**
 * Attempt limiter with progressive backoff.
 *
 * A kiosk sees every keypress from one IP: its own. A long flat lockout would
 * let one person with a wrong code brick the machine for the whole queue. So a
 * strike costs 30s, doubling per repeat offence up to a 5-minute ceiling. That
 * caps a brute-force at ~10 guesses/minute against a 1,000,000-code space while
 * an honest mistyper waits half a minute.
 */
const attempts = new Map(); // key -> { count, firstAt, lockedUntil, strikes }

function backoffMs(strikes) {
  const ms = config.otp.lockoutBaseMs * 2 ** Math.max(0, strikes - 1);
  return Math.min(ms, config.otp.lockoutMaxMs);
}

export function throttleState(key) {
  const rec = attempts.get(key);
  if (!rec) return { locked: false, remaining: config.otp.maxAttempts };
  const now = Date.now();
  if (rec.lockedUntil && rec.lockedUntil > now) {
    return { locked: true, retryAfterMs: rec.lockedUntil - now, remaining: 0 };
  }
  if (rec.lockedUntil && rec.lockedUntil <= now) {
    // Lockout served: reset the counter but remember the strike for the next one.
    rec.count = 0;
    rec.firstAt = now;
    rec.lockedUntil = 0;
    attempts.set(key, rec);
    return { locked: false, remaining: config.otp.maxAttempts };
  }
  return { locked: false, remaining: Math.max(0, config.otp.maxAttempts - rec.count) };
}

function recordFailure(key) {
  const now = Date.now();
  const rec = attempts.get(key) || { count: 0, firstAt: now, lockedUntil: 0, strikes: 0 };

  // Forget an old, isolated mistake rather than accumulating it forever.
  if (now - rec.firstAt > config.otp.windowMs) {
    rec.count = 0;
    rec.firstAt = now;
    if (now - rec.firstAt > config.otp.strikeDecayMs) rec.strikes = 0;
  }

  rec.count += 1;
  if (rec.count >= config.otp.maxAttempts) {
    rec.strikes += 1;
    rec.lockedUntil = now + backoffMs(rec.strikes);
  }
  attempts.set(key, rec);
  return rec;
}

export const clearFailures = (key) => attempts.delete(key);

/* -------------------------------- matching -------------------------------- */

/**
 * Scans every releasable order with a constant-time compare so response timing
 * does not leak which digits were right. Returns a tagged result.
 */
export function verifyOtp(rawOtp, { throttleKey = 'global' } = {}) {
  const otp = String(rawOtp ?? '').trim();

  const gate = throttleState(throttleKey);
  if (gate.locked) {
    return { ok: false, code: 'LOCKED_OUT', retryAfterMs: gate.retryAfterMs };
  }
  if (!new RegExp(`^[0-9]{${config.otp.length}}$`).test(otp)) {
    const rec = recordFailure(throttleKey);
    return { ok: false, code: 'MALFORMED', remaining: Math.max(0, config.otp.maxAttempts - rec.count) };
  }

  let match = null;
  for (const order of store.releasableOrders()) {
    if (eq(order.pickup_otp, otp) && !match) match = order;
  }

  if (!match) {
    // An OTP that is real but already used / unpaid gets the same generic answer,
    // except expiry which the user can act on.
    const anywhere = store.raw().orders.find((o) => eq(o.pickup_otp, otp));
    if (anywhere && anywhere.print_status === 'COMPLETED') {
      const rec = recordFailure(throttleKey);
      return { ok: false, code: 'ALREADY_PRINTED', remaining: Math.max(0, config.otp.maxAttempts - rec.count) };
    }
    if (anywhere && anywhere.print_status === 'PRINTING') {
      return { ok: false, code: 'IN_PROGRESS', orderId: anywhere.id };
    }
    const rec = recordFailure(throttleKey);
    return { ok: false, code: 'INVALID', remaining: Math.max(0, config.otp.maxAttempts - rec.count) };
  }

  if (match.otp_expires_at && Date.parse(match.otp_expires_at) < Date.now()) {
    const rec = recordFailure(throttleKey);
    return { ok: false, code: 'EXPIRED', remaining: Math.max(0, config.otp.maxAttempts - rec.count) };
  }

  clearFailures(throttleKey);
  return { ok: true, order: match };
}

export const otpExpiryISO = () =>
  new Date(Date.now() + config.otp.ttlHours * 3600 * 1000).toISOString();
