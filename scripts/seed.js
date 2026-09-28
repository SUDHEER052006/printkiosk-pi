#!/usr/bin/env node
/**
 * Creates a paid, ready-to-release order straight against a running agent and
 * prints the OTP, so you can walk to the kiosk and type it.
 *
 *   node scripts/seed.js
 *   node scripts/seed.js --pages 12 --copies 2 --duplex --colour
 */

const BASE = process.env.BASE || `http://127.0.0.1:${process.env.PORT || 8080}`;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes('--' + name);
const opt = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const payload = {
  pages: Number(opt('pages', 3)),
  copies: Number(opt('copies', 1)),
  duplex: flag('duplex'),
  colourMode: flag('colour') ? 'colour' : 'bw',
  paperSize: opt('paper', 'A4'),
  title: opt('title', 'Seeded Test Document'),
};

const res = await fetch(BASE + '/api/sim/order', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});

if (!res.ok) {
  console.error('seed failed:', res.status, await res.text());
  process.exit(1);
}

const d = await res.json();
console.log('');
console.log(`  order    ${d.order.order_id}`);
console.log(`  spec     ${d.document.page_count} pages x ${d.order.copies} ` +
            `${d.order.duplex ? 'duplex' : 'single'} ${d.order.colour_mode} ${d.order.paper_size}`);
console.log(`  sheets   ${d.quote.totalSheets} @ Rs.${d.quote.rate}`);
console.log(`  amount   Rs. ${d.order.amount}`);
console.log('');
console.log(`  OTP      ${d.otp}`);
console.log('');
console.log(`  Type it on the keypad at ${BASE}/`);
console.log('');
