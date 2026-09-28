#!/usr/bin/env node
/**
 * End-to-end self test against a running kiosk agent.
 *
 *   node scripts/selftest.js                  # against http://127.0.0.1:8080
 *   BASE=http://127.0.0.1:8099 node scripts/selftest.js
 *
 * Drives the real path only — upload, order, approve, release — so it works
 * whether or not the /sim shortcuts are enabled. With PRINTER_DRIVER=mock it
 * proves the pipeline without paper; with a real driver it genuinely prints.
 */

import { makePdf } from '../src/pdf.js';

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

async function upload(name, pages, title) {
  const res = await fetch(BASE + '/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf', 'X-Filename': name },
    body: makePdf({ pageCount: pages, title: title || name }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** Creates an order and, when approval is required, approves it as staff. */
async function payableOrder(opts, { approve = true } = {}) {
  const up = await upload(opts.name || 'test.pdf', opts.pages, opts.title);
  const made = await post('/api/orders', {
    documentId: up.body.documentId,
    copies: opts.copies || 1,
    duplex: Boolean(opts.duplex),
    colourMode: opts.colourMode || 'bw',
  });
  if (approve && made.body.otp === null) {
    await post('/api/payments/approve', { orderId: made.body.order.id });
    const st = await get('/api/orders/' + made.body.order.id + '/status');
    return { up, made, otp: st.body.otp };
  }
  return { up, made, otp: made.body.otp };
}

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

  const h = await get('/api/health');
  ok('agent is up', h.status === 200);
  if (h.status !== 200) { console.log('\n  agent unreachable, aborting\n'); process.exit(1); }

  const mode = h.body.paymentMode;
  console.log(`  driver:  ${h.body.printer.driver}${h.body.printer.simulated ? ' (simulation)' : ''}`);
  console.log(`  printer: ${h.body.printer.activePrinter || '(system default)'}`);
  console.log(`  payments: ${mode}${mode === 'sim' ? '' : ' — staff approval required'}\n`);

  /* ------------------------- pricing (report s.7) ------------------------- */

  const a = await payableOrder({ name: 'duplex-5.pdf', pages: 5, copies: 2, duplex: true });
  ok('TC-02 duplex math  5p x2 duplex = 6 sheets, Rs.18',
     a.made.body.quote.totalSheets === 6 && a.made.body.order.amount === 18,
     `got ${a.made.body.quote.totalSheets} sheets / Rs.${a.made.body.order.amount}`);

  const b = await payableOrder({ name: 'duplex-7.pdf', pages: 7, copies: 2, duplex: true });
  ok('report example    7p x2 duplex = 8 sheets, Rs.24',
     b.made.body.quote.totalSheets === 8 && b.made.body.order.amount === 24,
     `got ${b.made.body.quote.totalSheets} sheets / Rs.${b.made.body.order.amount}`);

  const c = await payableOrder({ name: 'colour-10.pdf', pages: 10, colourMode: 'colour' });
  ok('colour single     10p x1 = Rs.100', c.made.body.order.amount === 100,
     `got Rs.${c.made.body.order.amount}`);

  /* ------------------------------- uploads -------------------------------- */

  const up9 = await upload('upload-test.pdf', 9, 'Upload Path Test');
  ok('TC-01 upload accepts a real PDF and counts its pages',
     up9.status === 201 && up9.body.pageCount === 9,
     up9.body.pageCount ? `${up9.body.pageCount} pages in ${up9.body.parseMs}ms` : (up9.body.error || ''));

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

  const priced = await post('/api/orders',
    { documentId: up9.body.documentId, copies: 2, duplex: true, colourMode: 'bw' });
  ok('order priced from the STORED page count',
     priced.status === 201 && priced.body.quote.totalSheets === 10 && priced.body.order.amount === 30,
     `${priced.body.quote && priced.body.quote.totalSheets} sheets / Rs.${priced.body.order && priced.body.order.amount}`);

  /* ------------------------------ OTP + print ----------------------------- */

  const bad = await post('/api/kiosk/verify-otp', { otp: '000000' });
  ok('TC-06 wrong OTP rejected', bad.status === 404 && bad.body.code === 'INVALID');

  const malformed = await post('/api/kiosk/verify-otp', { otp: '42' });
  ok('short OTP rejected', malformed.status === 400 && malformed.body.code === 'MALFORMED');

  const job = await payableOrder({ name: 'print-me.pdf', pages: 2, title: 'Print Test' });
  ok('order is payable and has a code', Boolean(job.otp), job.otp || 'no otp');

  const rel = await post('/api/kiosk/verify-otp', { otp: job.otp });
  ok('TC-05 correct OTP releases job', rel.status === 200 && rel.body.ok, rel.body.jobId || '');

  if (rel.body.ok) {
    const done = await waitForJob(rel.body.jobId);
    ok('job reached COMPLETED', done && done.succeeded && done.stage === 'COMPLETED',
       done ? `${done.stage} ${done.percent}%${done.error ? ' - ' + done.error : ''}` : 'no result');

    const orders = await get('/api/orders');
    const row = orders.body.orders.find((o) => o.order_id === job.made.body.order.order_id);
    ok('TC-07 document shredded after print', row && row.document && row.document.shredded);
    ok('order marked COMPLETED', row && row.print_status === 'COMPLETED', row && row.print_status);

    const reuse = await post('/api/kiosk/verify-otp', { otp: job.otp });
    ok('OTP cannot be reused', reuse.status === 409 && reuse.body.code === 'ALREADY_PRINTED');
  }

  /* --------------------- manual approval is the only gate ------------------ */

  if (mode !== 'sim') {
    console.log('');

    const held = await payableOrder({ name: 'held.pdf', pages: 2 }, { approve: false });
    ok('unpaid order withholds the OTP', held.made.body.otp === null);
    ok('unpaid order is not READY_FOR_KIOSK',
       held.made.body.order.print_status === 'CREATED', held.made.body.order.print_status);

    const st = await get('/api/orders/' + held.made.body.order.id + '/status');
    ok('status endpoint withholds the OTP while unpaid',
       st.body.paymentStatus === 'PENDING' && st.body.otp === null);

    const badUtr = await post('/api/payments/claim',
      { orderId: held.made.body.order.id, utr: '123' });
    ok('a malformed UPI reference is rejected', badUtr.status === 400);

    const claim = await post('/api/payments/claim',
      { orderId: held.made.body.order.id, utr: '400000000001' });
    ok('UPI reference accepted, still awaiting a person',
       claim.status === 202 && claim.body.status === 'AWAITING_VERIFICATION');

    const stillHeld = await get('/api/orders/' + held.made.body.order.id + '/status');
    ok('claiming payment does NOT release the code', stillHeld.body.otp === null);

    const dupe = await payableOrder({ name: 'dupe.pdf', pages: 1 }, { approve: false });
    const reused = await post('/api/payments/claim',
      { orderId: dupe.made.body.order.id, utr: '400000000001' });
    ok('the same UPI reference cannot pay twice', reused.status === 409);

    const gone = await fetch(BASE + '/api/payments/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: held.made.body.order.id }),
    });
    ok('nothing can confirm a payment automatically', gone.status === 404);

    const approved = await post('/api/payments/approve', { orderId: held.made.body.order.id });
    ok('staff approval is what marks it PAID',
       approved.status === 200 && approved.body.status === 'PAID');

    const released = await get('/api/orders/' + held.made.body.order.id + '/status');
    ok('OTP released only after approval', Boolean(released.body.otp));

    /* an order the phone never reported must still be approvable */
    const silent = await payableOrder({ name: 'no-claim.pdf', pages: 1 }, { approve: false });
    const stats = await get('/api/stats');
    ok('an unclaimed order still appears on the dashboard',
       (stats.body.pending || []).some((p) => p.id === silent.made.body.order.id));

    const blind = await post('/api/payments/approve', { orderId: silent.made.body.order.id });
    ok('staff can approve an order with no reference', blind.status === 200);

    const blindSt = await get('/api/orders/' + silent.made.body.order.id + '/status');
    ok('that order then releases its OTP', Boolean(blindSt.body.otp));

    const blank = await payableOrder({ name: 'blank-utr.pdf', pages: 1 }, { approve: false });
    const blankClaim = await post('/api/payments/claim', { orderId: blank.made.body.order.id });
    ok('"I have paid" works without a reference', blankClaim.status === 202);

    const rejected = await post('/api/payments/approve',
      { orderId: blank.made.body.order.id, reject: true });
    ok('staff can reject a payment', rejected.status === 200 && rejected.body.status === 'FAILED');

    const afterReject = await get('/api/orders/' + blank.made.body.order.id + '/status');
    ok('a rejected order stays locked', afterReject.body.otp === null);
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\nself test crashed:', err.message, '\n');
  process.exit(1);
});
