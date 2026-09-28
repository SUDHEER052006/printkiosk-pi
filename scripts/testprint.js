#!/usr/bin/env node
/**
 * Sends one page straight to the printer through the same Hardware Abstraction
 * Layer the kiosk uses — no server, no OTP, no order. The fastest way to prove a
 * newly connected printer works before testing the whole flow.
 *
 *   node scripts/testprint.js                        # default queue, 1 page
 *   node scripts/testprint.js --printer "Canon_MF240"
 *   node scripts/testprint.js --pages 2 --duplex --copies 2
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import config from '../src/config.js';
import { makePdf } from '../src/pdf.js';
import { printFile, driverInfo } from '../src/printer.js';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const opt = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const info = await driverInfo();
const printerName = opt('printer', config.printer.name || info.activePrinter || '');

console.log('');
console.log(`  driver    ${info.driver}${info.simulated ? '   << SIMULATION: no paper will move >>' : ''}`);
console.log(`  printer   ${printerName || '(system default)'}`);
console.log(`  queues    ${info.printers.length ? info.printers.join(', ') : '(none detected)'}`);
console.log('');

if (!info.simulated && !printerName && !info.printers.length) {
  console.log('  No printer found. Add one first:');
  console.log('    Linux/Pi : http://localhost:631  ->  Administration  ->  Add Printer');
  console.log('    Windows  : Settings  ->  Bluetooth & devices  ->  Printers & scanners');
  console.log('');
  process.exit(1);
}

const pages = Number(opt('pages', 1));
const copies = Number(opt('copies', 1));
const duplex = flag('duplex');
const colourMode = flag('colour') ? 'colour' : 'bw';
const paperSize = opt('paper', 'A4');

await fs.mkdir(config.spoolDir, { recursive: true });
const file = path.join(config.spoolDir, 'hardware-test.pdf');
await fs.writeFile(file, makePdf({
  title: 'PRINTKIOSK hardware test',
  pageCount: pages,
  note: `${printerName || 'default queue'} via ${info.driver}`,
}));

console.log('  sending...');
const started = Date.now();

try {
  const result = await printFile(
    file,
    { printerName, copies, duplex, colourMode, paperSize, totalSheets: pages * copies },
    (ev) => console.log(`    ${String(ev.percent ?? '').padStart(3)}%  ${ev.stage.padEnd(10)} ${ev.message || ''}`),
  );
  console.log('');
  console.log(`  done in ${((Date.now() - started) / 1000).toFixed(1)}s  ·  job ${result.jobId || '(unnamed)'}`);
  console.log(info.simulated
    ? `  simulated — receipt written to ${config.mockDir}`
    : '  Check the printer tray.');
  console.log('');
} catch (err) {
  console.log('');
  console.log(`  FAILED: ${err.message}`);
  console.log('');
  console.log('  Things to check:');
  console.log('    lpstat -t                    full CUPS status (Linux/Pi)');
  console.log('    lpstat -a                    is the queue accepting jobs?');
  console.log('    cancel -a                    clear a jammed queue');
  console.log('    Get-Printer                  list queues (Windows)');
  console.log('    Printer itself               paper, toner, error light, cable');
  console.log('');
  process.exit(1);
} finally {
  await fs.rm(file, { force: true });
}
