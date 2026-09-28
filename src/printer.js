import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import config from './config.js';

const exec = promisify(execFile);

/**
 * Hardware Abstraction Layer (report module 5).
 *
 *   cups    - macOS / Linux / Raspberry Pi OS via `lp`, real queue polling via `lpstat`
 *   windows - SumatraPDF silent print if available, else the shell "printto" verb
 *   mock    - no hardware; writes a receipt and emits realistic staged progress
 *
 * Every driver exposes the same surface:
 *   listPrinters() -> string[]
 *   print(file, opts, onProgress) -> { jobId }
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================================ helpers ================================ */

async function which(cmd) {
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const { stdout } = await exec(finder, [cmd]);
    return stdout.split(/\r?\n/).find(Boolean) || null;
  } catch {
    return null;
  }
}

function cupsOptions({ copies = 1, duplex = false, colourMode = 'bw', paperSize = 'A4' }) {
  const args = [];
  if (copies > 1) args.push('-n', String(copies));
  args.push('-o', `media=${paperSize}`);
  args.push('-o', duplex ? 'sides=two-sided-long-edge' : 'sides=one-sided');
  args.push('-o', colourMode === 'colour' ? 'ColorModel=RGB' : 'ColorModel=Gray');
  args.push('-o', 'fit-to-page');
  return args;
}

/* ================================== CUPS ================================= */

const cupsDriver = {
  id: 'cups',

  async available() {
    return Boolean(await which('lp'));
  },

  async listPrinters() {
    try {
      const { stdout } = await exec('lpstat', ['-a']);
      return stdout.split(/\r?\n/).filter(Boolean).map((l) => l.split(/\s+/)[0]);
    } catch {
      return [];
    }
  },

  async defaultPrinter() {
    try {
      const { stdout } = await exec('lpstat', ['-d']);
      const m = stdout.match(/:\s*(\S+)/);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  },

  async print(file, opts, onProgress) {
    const queue = opts.printerName || (await this.defaultPrinter());
    if (!queue) throw new Error('No CUPS printer configured (set PRINTER_NAME or a default queue)');

    onProgress({ stage: 'SPOOLING', percent: 20, message: `Sending to ${queue}` });

    const args = ['-d', queue, ...cupsOptions(opts), file];
    const { stdout } = await exec('lp', args, { timeout: 30000 });

    // "request id is Canon_MF240-42 (1 file(s))"
    const m = stdout.match(/request id is (\S+)/);
    const jobId = m ? m[1] : null;
    onProgress({ stage: 'SPOOLED', percent: 40, message: `Queued as ${jobId || 'job'}`, jobId });

    if (jobId) await this.waitForJob(queue, jobId, onProgress);
    else {
      onProgress({ stage: 'PRINTING', percent: 80, message: 'Printing' });
      await sleep(3000);
    }

    return { jobId };
  },

  /** Polls the live CUPS queue until the job leaves it (or the job times out). */
  async waitForJob(queue, jobId, onProgress) {
    const started = Date.now();
    let sawInQueue = false;
    let pct = 45;

    while (Date.now() - started < config.printer.jobTimeoutMs) {
      let active = '';
      try {
        const { stdout } = await exec('lpstat', ['-W', 'not-completed', '-o', queue]);
        active = stdout;
      } catch {
        active = '';
      }

      const stillQueued = active.includes(jobId);
      if (stillQueued) {
        sawInQueue = true;
        pct = Math.min(92, pct + 4);
        onProgress({ stage: 'PRINTING', percent: pct, message: 'Printing sheets' });
      } else if (sawInQueue || Date.now() - started > 3000) {
        // Job left the active queue. Confirm it completed rather than was cancelled.
        try {
          const { stdout } = await exec('lpstat', ['-W', 'completed', '-o', queue]);
          if (!stdout.includes(jobId)) {
            throw new Error(`Print job ${jobId} left the queue without completing`);
          }
        } catch (err) {
          if (err.message.includes('without completing')) throw err;
          // lpstat -W completed unsupported on some builds: treat disappearance as done.
        }
        return;
      }
      await sleep(config.printer.pollIntervalMs);
    }
    throw new Error(`Print job ${jobId} timed out after ${config.printer.jobTimeoutMs}ms`);
  },
};

/* ================================ Windows ================================ */

const windowsDriver = {
  id: 'windows',

  async available() {
    return process.platform === 'win32';
  },

  async listPrinters() {
    try {
      const { stdout } = await exec(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', 'Get-Printer | Select-Object -ExpandProperty Name'],
        { timeout: 20000 },
      );
      return stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    } catch {
      return [];
    }
  },

  async defaultPrinter() {
    try {
      const { stdout } = await exec(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command',
         '(Get-CimInstance Win32_Printer | Where-Object Default -eq $true).Name'],
        { timeout: 20000 },
      );
      return stdout.trim() || null;
    } catch {
      return null;
    }
  },

  async findSumatra() {
    if (config.printer.sumatra && fsSync.existsSync(config.printer.sumatra)) return config.printer.sumatra;
    const candidates = [
      path.join(process.env.LOCALAPPDATA || '', 'SumatraPDF', 'SumatraPDF.exe'),
      'C:\\Program Files\\SumatraPDF\\SumatraPDF.exe',
      'C:\\Program Files (x86)\\SumatraPDF\\SumatraPDF.exe',
    ];
    for (const c of candidates) if (c && fsSync.existsSync(c)) return c;
    return which('SumatraPDF.exe');
  },

  async print(file, opts, onProgress) {
    const queue = opts.printerName || (await this.defaultPrinter());
    if (!queue) throw new Error('No Windows printer found (set PRINTER_NAME)');

    onProgress({ stage: 'SPOOLING', percent: 20, message: `Sending to ${queue}` });

    const sumatra = await this.findSumatra();
    if (sumatra) {
      const settings = [
        opts.duplex ? 'duplexlong' : 'simplex',
        opts.colourMode === 'colour' ? 'color' : 'monochrome',
        `paper=${opts.paperSize || 'A4'}`,
        `${opts.copies || 1}x`,
      ].join(',');
      await exec(sumatra, ['-print-to', queue, '-print-settings', settings, '-silent', file], {
        timeout: config.printer.jobTimeoutMs,
      });
    } else {
      // Fallback: shell "printto" verb. Needs a registered PDF handler; not silent.
      const ps =
        `Start-Process -FilePath ${JSON.stringify(file)} -Verb PrintTo ` +
        `-ArgumentList ${JSON.stringify(queue)} -PassThru | Out-Null`;
      await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
        timeout: config.printer.jobTimeoutMs,
      });
    }

    onProgress({ stage: 'PRINTING', percent: 70, message: 'Spooled to Windows print queue' });
    await this.waitForQueue(queue, onProgress);
    return { jobId: `win-${Date.now()}` };
  },

  /** Watches the Windows spooler until this queue drains. */
  async waitForQueue(queue, onProgress) {
    const started = Date.now();
    let pct = 70;
    while (Date.now() - started < config.printer.jobTimeoutMs) {
      let count = 0;
      try {
        const { stdout } = await exec(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command',
           `@(Get-PrintJob -PrinterName ${JSON.stringify(queue)} -ErrorAction SilentlyContinue).Count`],
          { timeout: 15000 },
        );
        count = Number(stdout.trim()) || 0;
      } catch {
        return; // cannot inspect the queue: assume handed off
      }
      if (count === 0) return;
      pct = Math.min(92, pct + 3);
      onProgress({ stage: 'PRINTING', percent: pct, message: `Printing (${count} job(s) in queue)` });
      await sleep(config.printer.pollIntervalMs);
    }
  },
};

/* ================================== mock ================================= */

const mockDriver = {
  id: 'mock',

  async available() {
    return true;
  },

  async listPrinters() {
    return ['Mock_Canon_MF240', 'Mock_HP_LaserJet_Pro'];
  },

  async defaultPrinter() {
    return 'Mock_Canon_MF240';
  },

  async print(file, opts, onProgress) {
    const queue = opts.printerName || 'Mock_Canon_MF240';
    const jobId = `${queue}-${Date.now() % 100000}`;
    const total = config.printer.mockDurationMs;
    const sheets = opts.totalSheets || opts.copies || 1;

    onProgress({ stage: 'SPOOLING', percent: 20, message: `Sending to ${queue}` });
    await sleep(total * 0.15);
    onProgress({ stage: 'SPOOLED', percent: 40, message: `Queued as ${jobId}`, jobId });
    await sleep(total * 0.1);

    for (let s = 1; s <= sheets; s += 1) {
      const pct = 45 + Math.round((s / sheets) * 47);
      onProgress({ stage: 'PRINTING', percent: pct, message: `Printing sheet ${s} of ${sheets}` });
      await sleep(Math.max(250, (total * 0.7) / sheets));
    }

    const receipt = [
      '=== MOCK PRINT RECEIPT ===',
      `job:        ${jobId}`,
      `queue:      ${queue}`,
      `file:       ${file}`,
      `copies:     ${opts.copies}`,
      `duplex:     ${opts.duplex ? 'two-sided-long-edge' : 'one-sided'}`,
      `colour:     ${opts.colourMode}`,
      `paper:      ${opts.paperSize}`,
      `sheets:     ${sheets}`,
      `printed_at: ${new Date().toISOString()}`,
      '',
    ].join('\n');

    await fs.mkdir(config.mockDir, { recursive: true });
    const out = path.join(config.mockDir, `${jobId}.txt`);
    await fs.writeFile(out, receipt, 'utf8');
    try {
      await fs.copyFile(file, path.join(config.mockDir, `${jobId}.pdf`));
    } catch { /* source may already be gone */ }

    return { jobId, receipt: out };
  },
};

/* =============================== resolution ============================== */

const DRIVERS = { cups: cupsDriver, windows: windowsDriver, mock: mockDriver };

let resolved = null;

export async function resolveDriver() {
  if (resolved) return resolved;

  const want = config.printer.driver;
  if (want !== 'auto') {
    const d = DRIVERS[want];
    if (!d) throw new Error(`Unknown PRINTER_DRIVER '${want}' (cups | windows | mock | auto)`);
    resolved = d;
    return resolved;
  }

  if (process.platform === 'win32' && (await windowsDriver.available())) resolved = windowsDriver;
  else if (await cupsDriver.available()) resolved = cupsDriver;
  else resolved = mockDriver;

  return resolved;
}

export async function driverInfo() {
  const d = await resolveDriver();
  const printers = await d.listPrinters();
  let active = config.printer.name;
  if (!active) {
    try {
      active = (await d.defaultPrinter()) || '';
    } catch {
      active = '';
    }
  }
  return {
    driver: d.id,
    platform: `${os.type()} ${os.release()}`,
    configured: config.printer.driver,
    printers,
    activePrinter: active,
    simulated: d.id === 'mock',
  };
}

/**
 * Spool one job. `onProgress` receives { stage, percent, message } events and is
 * the single source of truth for what the kiosk screen animates.
 */
export async function printFile(file, opts = {}, onProgress = () => {}) {
  const driver = await resolveDriver();
  const options = {
    printerName: opts.printerName || config.printer.name || '',
    copies: opts.copies || 1,
    duplex: Boolean(opts.duplex),
    colourMode: opts.colourMode || 'bw',
    paperSize: opts.paperSize || 'A4',
    totalSheets: opts.totalSheets,
  };

  await fs.access(file); // fail loudly before touching hardware

  const result = await driver.print(file, options, onProgress);
  onProgress({ stage: 'PRINTED', percent: 96, message: 'Sheets delivered' });
  return { ...result, driver: driver.id };
}

export { DRIVERS };
