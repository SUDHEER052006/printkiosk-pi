#!/usr/bin/env node
/**
 * End-to-end self test against a running kiosk agent.
 *
 *   node scripts/selftest.js                  # against http://127.0.0.1:8080
 *   BASE=http://127.0.0.1:8099 node scripts/selftest.js
 *
 * With PRINTER_DRIVER=mock this proves the whole pipeline without paper.
 * With a real driver it will genuinely print the test sheets.
 */

const BASE = process.env.BASE || `http://127.0.0.1:${process.env.PORT || 8080}`;

let pass = 0;
let fail = 0;

const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  PASS  ${name}${detail ? '  ' + detail : ''}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`); }
};

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, body: json };
}

const post = (p, b) => req('POST', p, b);
const get = (p) => req('GET', p);

async function waitForJob(jobId, timeoutMs = 240000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    const r = await get('/api/jobs/' + jobId);
    if (r.status !== 200) break;
    last = r.body;
    if (last.done) return last;
    await new Promise((res) => setTimeout(res, 600));
  }
  return last;
}

(async () => {
  console.log(`\nPRINTKIOSK self test -> ${BASE}\n`);

  /* -- health -- */
  const h = await get('/api/health');
  ok('agent is up', h.status === 200);
  if (h.status !== 200) { console.log('\n  agent unreachable, aborting\n'); process.exit(1); }
  const driver = h.body.printer.driver;
  console.log(`  driver: ${driver}${h.body.printer.simulated ? ' (simulation)' : ''}`);
  console.log(`  printer: ${h.body.printer.activePrinter || '(system default)'}\n`);

  /* -- TC-02: duplex sheet math from the report -- */
  const q = await post('/api/sim/quote', { pages: 5, copies: 2, duplex: true, colourMode: 'bw' });
  ok('TC-02 duplex math  5p x2 duplex = 6 sheets, Rs.18',
     q.body.totalSheets === 6 && q.body.amount === 18,
     `got ${q.body.totalSheets} sheets / Rs.${q.body.amount}`);

  const q2 = await post('/api/sim/quote', { pages: 7, copies: 2, duplex: true, colourMode: 'bw' });
  ok('report example    7p x2 duplex = 8 sheets, Rs.24',
     q2.body.totalSheets === 8 && q2.body.amount === 24,
     `got ${q2.body.totalSheets} sheets / Rs.${q2.body.amount}`);

  const q3 = await post('/api/sim/quote', { pages: 10, copies: 1, duplex: false, colourMode: 'colour' });
  ok('colour single     10p x1 = Rs.100', q3.body.amount === 100, `got Rs.${q3.body.amount}`);

  /* -- order creation -- */
  const created = await post('/api/sim/order',
    { pages: 2, copies: 1, duplex: false, colourMode: 'bw', title: 'Self Test' });
  ok('TC-01 order created + pages parsed',
     created.status === 201 && created.body.document.page_count === 2,
     `${created.body.order && created.body.order.order_id}, otp ${created.body.otp}`);
  const otp = created.body.otp;

  /* -- TC-06: wrong OTP -- */
  const bad = await post('/api/kiosk/verify-otp', { otp: '000000' });
  ok('TC-06 wrong OTP rejected', bad.status === 404 && bad.body.code === 'INVALID');

  const malformed = await post('/api/kiosk/verify-otp', { otp: '42' });
  ok('short OTP rejected', malformed.status === 400 && malformed.body.code === 'MALFORMED');

  /* -- TC-05: correct OTP releases the job -- */
  const rel = await post('/api/kiosk/verify-otp', { otp });
  ok('TC-05 correct OTP releases job', rel.status === 200 && rel.body.ok, rel.body.jobId || '');

  if (rel.body.ok) {
    const done = await waitForJob(rel.body.jobId);
    ok('job reached COMPLETED', done && done.succeeded && done.stage === 'COMPLETED',
       done ? `${done.stage} ${done.percent}%${done.error ? ' - ' + done.error : ''}` : 'no result');

    /* -- TC-07: shredding -- */
    const orders = await get('/api/orders');
    const row = orders.body.orders.find((o) => o.order_id === created.body.order.order_id);
    ok('TC-07 document shredded after print', row && row.document && row.document.shredded);
    ok('order marked COMPLETED', row && row.print_status === 'COMPLETED', row && row.print_status);

    /* -- OTP is single use -- */
    const reuse = await post('/api/kiosk/verify-otp', { otp });
    ok('OTP cannot be reused', reuse.status === 409 && reuse.body.code === 'ALREADY_PRINTED');
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\nself test crashed:', err.message, '\n');
  process.exit(1);
});
