#!/usr/bin/env node
/** Prints what the HAL can see, so you can copy the exact queue name into PRINTER_NAME. */
import { driverInfo } from '../src/printer.js';

const info = await driverInfo();

console.log('');
console.log(`  driver        ${info.driver}${info.simulated ? '  (simulation - no paper will move)' : ''}`);
console.log(`  configured    ${info.configured}`);
console.log(`  platform      ${info.platform}`);
console.log(`  default       ${info.activePrinter || '(none)'}`);
console.log('');

if (!info.printers.length) {
  console.log('  No printer queues detected.');
  console.log('  Linux/Pi : check `lpstat -a`, and that CUPS is running (sudo systemctl status cups)');
  console.log('  Windows  : check `Get-Printer`');
} else {
  console.log('  Queues:');
  for (const p of info.printers) {
    console.log(`    ${p === info.activePrinter ? '*' : ' '} ${p}`);
  }
  console.log('');
  console.log(`  Use it with:  PRINTER_NAME="${info.printers[0]}" npm start`);
}
console.log('');
