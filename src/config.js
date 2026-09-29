import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/**
 * Loads a .env file if one exists. Kept to a dozen lines rather than pulling in
 * dotenv, and it exists for one reason: a real UPI ID belongs on the machine,
 * not in a public git repository. .env is gitignored.
 */
function loadEnvFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const raw of text.split('\n')) {
    const t = raw.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    // A real environment variable always wins over the file.
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnvFile(path.join(ROOT, '.env'));

const env = process.env;
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

/** auto -> cups on linux/darwin, windows on win32, mock if neither resolves at runtime */
function defaultDriver() {
  if (env.PRINTER_DRIVER) return env.PRINTER_DRIVER.toLowerCase();
  return 'auto';
}

export const config = {
  root: ROOT,
  port: num(env.PORT, 8080),
  host: env.HOST || '0.0.0.0',

  kioskId: env.KIOSK_ID || `kiosk-${os.hostname()}`,

  /**
   * Cloud mode. On Render (or any host away from the printer) the server keeps
   * doing everything except moving paper: upload, pricing, approval, codes. The
   * printing is handed to `agent.js` running on the machine wired to the
   * printer, which polls this server over plain outbound https.
   *
   * RENDER sets RENDER=true on every instance, so a deploy needs no extra flag.
   */
  cloud: bool(env.CLOUD, Boolean(env.RENDER)),

  /** Absolute URL of this deployment, when it cannot be read off the request. */
  publicUrl: (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, ''),
  publicHost: env.PUBLIC_HOST || '',

  /** The print agent that does the spooling in cloud mode. */
  agent: {
    token: env.AGENT_TOKEN || '',
    longPollMs: num(env.AGENT_LONGPOLL_MS, 25000),
    offlineAfterMs: num(env.AGENT_OFFLINE_MS, 45000),
    claimWaitMs: num(env.AGENT_CLAIM_WAIT_MS, 90000),
    beatTimeoutMs: num(env.AGENT_BEAT_TIMEOUT_MS, 240000),
  },

  dataDir: env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.join(ROOT, 'data'),
  get docsDir() { return path.join(this.dataDir, 'documents'); },
  get spoolDir() { return path.join(this.dataDir, 'spool'); },
  get mockDir() { return path.join(this.dataDir, 'mock-prints'); },
  get dbFile() { return path.join(this.dataDir, 'kiosk-db.json'); },

  printer: {
    driver: defaultDriver(),          // auto | cups | windows | mock
    name: env.PRINTER_NAME || '',     // empty -> system default queue
    // Windows only: path to SumatraPDF.exe for reliable silent PDF printing
    sumatra: env.SUMATRA_PATH || '',
    jobTimeoutMs: num(env.PRINT_TIMEOUT_MS, 180000),
    pollIntervalMs: num(env.PRINT_POLL_MS, 1000),
    mockDurationMs: num(env.MOCK_DURATION_MS, 7000),
  },

  otp: {
    length: 6,
    ttlHours: num(env.OTP_TTL_HOURS, 24),
    maxAttempts: num(env.OTP_MAX_ATTEMPTS, 5),
    // Progressive backoff: a shared kiosk must not be brickable by one mistyper.
    lockoutBaseMs: num(env.OTP_LOCKOUT_BASE_MS, 30 * 1000),
    lockoutMaxMs: num(env.OTP_LOCKOUT_MAX_MS, 5 * 60 * 1000),
    windowMs: num(env.OTP_WINDOW_MS, 5 * 60 * 1000),
    strikeDecayMs: num(env.OTP_STRIKE_DECAY_MS, 30 * 60 * 1000),
  },

  /**
   * How a job becomes payable. Nothing confirms a payment automatically —
   * a person approves every one from the dashboard.
   *
   *   sim        - auto-paid. Demo only; never on a kiosk students can reach.
   *   upi_manual - show a UPI QR; staff approve each payment at /admin.
   */
  payments: {
    mode: (() => {
      const raw = (env.PAYMENT_MODE || (bool(env.SIM_ENABLED, true) ? 'sim' : 'upi_manual')).toLowerCase();
      if (raw === 'manual' || raw === 'upi') return 'upi_manual';
      return raw === 'sim' ? 'sim' : 'upi_manual';
    })(),
    // Staff approval token. Empty = approvals allowed from this machine only.
    adminToken: env.ADMIN_TOKEN || '',
    /**
     * The service promise: a claimed payment is approved within this window.
     * The dashboard counts down against it and the phone tells the student how
     * long to expect. It is an SLA, not a deadline that destroys the order —
     * money has already moved, so a late approval still has to work.
     */
     slaMs: num(env.APPROVAL_SLA_MS, 30000),
  },

  upi: {
    vpa: env.UPI_VPA || '',
    name: env.UPI_NAME || 'PrintKiosk',
    /**
     * Optional path to your own bank/PhonePe QR image, shown instead of a
     * generated one. Note the trade-off: a saved QR is static, so it cannot
     * carry the per-order amount and the student must type it in. The
     * generated QR fills the amount and order number in automatically, so it
     * is the better default whenever you have the VPA.
     */
    qrImage: env.UPI_QR_IMAGE || '',
  },

  upload: {
    maxBytes: num(env.UPLOAD_MAX_BYTES, 25 * 1024 * 1024),
    maxPages: num(env.UPLOAD_MAX_PAGES, 200),
    allowedExtensions: ['.pdf'],
  },

  // zero-trace shredding after a successful print
  shredOnComplete: bool(env.SHRED_ON_COMPLETE, true),

  // auto "next customer" reset delay on the kiosk screen
  resetDelayMs: num(env.KIOSK_RESET_MS, 20000),

  // expose /sim console (disable in production kiosks)
  simEnabled: bool(env.SIM_ENABLED, true),

  rates: {
    bw:     { single: 2,  duplex: 3 },
    colour: { single: 10, duplex: 15 },
  },
};

export default config;
