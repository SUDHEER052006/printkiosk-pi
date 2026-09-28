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

  /* -- real upload path: a genuine PDF, parsed for real -- */
  {
    const { makePdf } = await import('../src/pdf.js');
    const pdf = makePdf({ pageCount: 9, title: 'Upload Path Test' });

    const upRes = await fetch(BASE + '/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf', 'X-Filename': 'upload-test.pdf' },
      body: pdf,
    });
    const up = await upRes.json();
    ok('upload accepts a real PDF and counts its pages',
       upRes.status === 201 && up.pageCount === 9,
       up.pageCount ? `${up.pageCount} pages in ${up.parseMs}ms` : (up.error || ''));

    const notPdf = await fetch(BASE + '/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf', 'X-Filename': 'notreally.pdf' },
      body: Buffer.from('plain text wearing a .pdf extension'),
    });
    ok('TC-03 non-PDF content rejected', notPdf.status === 400);

    const exe = await fetch(BASE + '/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf', 'X-Filename': 'malware.exe' },
      body: Buffer.from('MZ'),
    });
    ok('TC-03 .exe extension rejected', exe.status === 400);

    if (upRes.status === 201) {
      const ordered = await post('/api/orders',
        { documentId: up.documentId, copies: 2, duplex: true, colourMode: 'bw' });
      // 9 pages duplex -> ceil(9/2)=5 sheets/copy x2 = 10 sheets x Rs.3 = Rs.30
      ok('uploaded doc priced from the STORED page count',
         ordered.status === 201 && ordered.body.quote.totalSheets === 10 && ordered.body.order.amount === 30,
         `${ordered.body.quote && ordered.body.quote.totalSheets} sheets / Rs.${ordered.body.order && ordered.body.order.amount}`);
    }
  }

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

  /* -- payment gating: only reachable when the kiosk is not in sim mode -- */
  if (h.body.paymentMode && h.body.paymentMode !== 'sim') {
    console.log(`\n  payment mode: ${h.body.paymentMode}\n`);

    const { makePdf } = await import('../src/pdf.js');
    const upRes = await fetch(BASE + '/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf', 'X-Filename': 'payment-test.pdf' },
      body: makePdf({ pageCount: 2, title: 'Payment Gate Test' }),
    });
    const up = await upRes.json();
    const made = await post('/api/orders', { documentId: up.documentId, copies: 1 });

    ok('unpaid order withholds the OTP', made.body.otp === null);
    ok('unpaid order is not READY_FOR_KIOSK', made.body.order.print_status === 'CREATED',
       made.body.order.print_status);

    const status = await get('/api/orders/' + made.body.order.id + '/status');
    ok('status endpoint withholds the OTP while unpaid',
       status.body.paymentStatus === 'PENDING' && status.body.otp === null);

    const claimBad = await post('/api/payments/claim',
      { orderId: made.body.order.id, utr: '123' });
    ok('malformed UPI reference rejected', claimBad.status === 400);

    const claim = await post('/api/payments/claim',
      { orderId: made.body.order.id, utr: '400000000001' });
    ok('UPI reference accepted, awaiting verification',
       claim.status === 202 && claim.body.status === 'AWAITING_VERIFICATION');

    const stillLocked = await get('/api/orders/' + made.body.order.id + '/status');
    ok('claimed-but-unverified still withholds the OTP', stillLocked.body.otp === null);

    const approved = await post('/api/payments/approve', { orderId: made.body.order.id });
    ok('staff approval marks it PAID', approved.status === 200 && approved.body.status === 'PAID');

    const released = await get('/api/orders/' + made.body.order.id + '/status');
    ok('OTP released after approval', Boolean(released.body.otp));

    const unsigned = await fetch(BASE + '/api/payments/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: made.body.order.id }),
    });
    ok('unsigned webhook rejected', unsigned.status === 401);
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\nself test crashed:', err.message, '\n');
  process.exit(1);
});
