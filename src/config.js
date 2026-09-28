import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

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
   * How a job becomes payable.
   *   sim        - auto-paid. Demo only; never on a kiosk students can reach.
   *   upi_manual - show a UPI QR, student submits the UPI reference, staff approve.
   *   webhook    - an HMAC-signed callback marks it paid (gateway or SMS relay).
   */
  payments: {
    mode: (env.PAYMENT_MODE || (bool(env.SIM_ENABLED, true) ? 'sim' : 'upi_manual')).toLowerCase(),
    webhookSecret: env.PAYMENT_WEBHOOK_SECRET || '',
    // Staff approval token. Empty = approvals allowed from this machine only.
    adminToken: env.ADMIN_TOKEN || '',
    // How long an unpaid order stays claimable before it is abandoned.
    pendingTtlMin: num(env.PAYMENT_PENDING_TTL_MIN, 30),
  },

  upi: {
    vpa: env.UPI_VPA || '',
    name: env.UPI_NAME || 'PrintKiosk',
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
