import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

import config from './src/config.js';
import * as store from './src/store.js';
import { priceOrder } from './src/pricing.js';
import { generateOtp, verifyOtp, otpExpiryISO } from './src/otp.js';
import { makePdf, countPdfPages } from './src/pdf.js';
import { driverInfo, resolveDriver } from './src/printer.js';
import { startJob, getJob, snapshot, bus } from './src/jobs.js';

/* ------------------------------- http utils ------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
};

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new Error('Malformed JSON body');
  }
}

const clientKey = (req) =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
  req.socket.remoteAddress ||
  'unknown';

/* ------------------------------ static files ----------------------------- */

const PUBLIC = path.join(config.root, 'public');

async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'kiosk.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) {
    json(res, 403, { error: 'Forbidden' });
    return true;
  }
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

/* --------------------------------- routes -------------------------------- */

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  /* -- health & hardware -- */

  if (method === 'GET' && pathname === '/api/health') {
    const info = await driverInfo();
    return json(res, 200, {
      ok: true,
      kioskId: config.kioskId,
      uptimeSec: Math.round(process.uptime()),
      node: process.version,
      host: os.hostname(),
      printer: info,
      simEnabled: config.simEnabled,
      resetDelayMs: config.resetDelayMs,
      otpLength: config.otp.length,
    });
  }

  if (method === 'GET' && pathname === '/api/printers') {
    return json(res, 200, await driverInfo());
  }

  /* -- kiosk OTP release -- */

  if (method === 'POST' && pathname === '/api/kiosk/verify-otp') {
    const body = await readJson(req);
    const result = verifyOtp(body.otp, { throttleKey: clientKey(req) });

    if (!result.ok) {
      const codes = {
        LOCKED_OUT: [429, 'Too many wrong attempts. Please wait.'],
        MALFORMED: [400, `Enter all ${config.otp.length} digits.`],
        EXPIRED: [410, 'This OTP has expired. Please contact support.'],
        ALREADY_PRINTED: [409, 'This order has already been printed.'],
        IN_PROGRESS: [409, 'This order is printing right now.'],
        INVALID: [404, 'Invalid OTP or order not found.'],
      };
      const [code, message] = codes[result.code] || [400, 'Verification failed.'];
      return json(res, code, {
        ok: false,
        code: result.code,
        message,
        remaining: result.remaining,
        retryAfterMs: result.retryAfterMs,
      });
    }

    let job;
    try {
      job = startJob(result.order, { printerName: body.printerName });
    } catch (err) {
      store.updateOrder(result.order.id, { print_status: 'READY_FOR_KIOSK' });
      return json(res, 500, { ok: false, code: 'START_FAILED', message: err.message });
    }

    // `ok` last: it means "OTP verified", distinct from the job's `succeeded`.
    return json(res, 200, { ...snapshot(job), ok: true });
  }

  /* -- live progress (SSE) -- */

  if (method === 'GET' && pathname.startsWith('/api/jobs/') && pathname.endsWith('/events')) {
    const jobId = pathname.split('/')[3];
    const job = getJob(jobId);
    if (!job) return json(res, 404, { error: 'Unknown job' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    send(snapshot(job));

    const onUpdate = (snap) => {
      send(snap);
      if (snap.done) {
        clearInterval(ping);
        bus.off(`job:${jobId}`, onUpdate);
        res.end();
      }
    };
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);

    if (job.done) {
      clearInterval(ping);
      res.end();
    } else {
      bus.on(`job:${jobId}`, onUpdate);
    }

    req.on('close', () => {
      clearInterval(ping);
      bus.off(`job:${jobId}`, onUpdate);
    });
    return undefined;
  }

  if (method === 'GET' && pathname.startsWith('/api/jobs/')) {
    const job = getJob(pathname.split('/')[3]);
    if (!job) return json(res, 404, { error: 'Unknown job' });
    return json(res, 200, snapshot(job));
  }

  /* -- orders (read) -- */

  if (method === 'GET' && pathname === '/api/orders') {
    const orders = store.listOrders().map((o) => {
      const doc = store.getDocument(o.document_id);
      return {
        ...o,
        pickup_otp: config.simEnabled ? o.pickup_otp : undefined,
        document: doc
          ? { original_filename: doc.original_filename, page_count: doc.page_count, shredded: Boolean(doc.deleted_at) }
          : null,
      };
    });
    return json(res, 200, { orders });
  }

  /* -- simulator: stand in for the phone app + Razorpay -- */

  if (config.simEnabled && method === 'POST' && pathname === '/api/sim/order') {
    const body = await readJson(req);

    const pages = Math.max(1, Math.min(200, Number(body.pages) || 3));
    const copies = Math.max(1, Math.min(50, Number(body.copies) || 1));
    const duplex = Boolean(body.duplex);
    const colourMode = body.colourMode === 'colour' ? 'colour' : 'bw';
    const paperSize = body.paperSize === 'A3' ? 'A3' : 'A4';

    let quote;
    try {
      quote = priceOrder({ pageCount: pages, copies, duplex, colourMode });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }

    const stored = `${crypto.randomUUID()}.pdf`;
    const storagePath = path.join(config.docsDir, stored);
    const original = body.filename || `assignment-${pages}p.pdf`;

    const otp = generateOtp();
    const pdf = makePdf({
      title: body.title || 'PrintKiosk Test Document',
      pageCount: pages,
      note: body.note || '',
    });
    await fsp.writeFile(storagePath, pdf);

    const doc = store.createDocument({
      stored_filename: stored,
      original_filename: original,
      mime_type: 'application/pdf',
      size_bytes: pdf.length,
      page_count: countPdfPages(pdf),
      storage_path: storagePath,
    });

    const order = store.createOrder({
      document_id: doc.id,
      paper_size: paperSize,
      colour_mode: colourMode,
      duplex,
      copies,
      amount: quote.amount,
      pickup_otp: otp,
      payment_status: 'PAID',            // simulates a verified Razorpay webhook
      print_status: 'READY_FOR_KIOSK',
      otp_expires_at: otpExpiryISO(),
    });

    return json(res, 201, { order, document: doc, quote, otp });
  }

  if (config.simEnabled && method === 'POST' && pathname === '/api/sim/quote') {
    const body = await readJson(req);
    try {
      return json(res, 200, priceOrder({
        pageCount: Number(body.pages) || 1,
        copies: Number(body.copies) || 1,
        duplex: Boolean(body.duplex),
        colourMode: body.colourMode === 'colour' ? 'colour' : 'bw',
      }));
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  if (config.simEnabled && method === 'POST' && pathname === '/api/sim/reset') {
    const db = store.raw();
    for (const doc of db.documents) {
      if (doc.storage_path) await fsp.rm(doc.storage_path, { force: true }).catch(() => {});
    }
    db.documents.length = 0;
    db.orders.length = 0;
    db.seq.document = 0;
    db.seq.order = 0;
    await store.persist();
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'No such endpoint', path: pathname });
}

/* --------------------------------- server -------------------------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');

  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }

    if (url.pathname === '/' || url.pathname === '/kiosk') {
      if (await serveStatic(res, '/kiosk.html')) return;
    }
    if (url.pathname === '/sim') {
      if (!config.simEnabled) return json(res, 404, { error: 'Simulator disabled' });
      if (await serveStatic(res, '/sim.html')) return;
    }
    if (await serveStatic(res, url.pathname)) return;

    json(res, 404, { error: 'Not found' });
  } catch (err) {
    if (!res.headersSent) json(res, 500, { error: err.message });
    else res.end();
  }
});

/* --------------------------------- boot ---------------------------------- */

store.load();

const banner = async () => {
  const info = await driverInfo();
  const nets = Object.values(os.networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);

  console.log('');
  console.log('  PRINTKIOSK  kiosk agent');
  console.log('  ' + '-'.repeat(52));
  console.log(`  kiosk id    ${config.kioskId}`);
  console.log(`  driver      ${info.driver}${info.simulated ? '  (SIMULATION - no paper will move)' : ''}`);
  console.log(`  printer     ${info.activePrinter || '(system default)'}`);
  console.log(`  queues      ${info.printers.length ? info.printers.join(', ') : '(none detected)'}`);
  console.log(`  data        ${config.dataDir}`);
  console.log('  ' + '-'.repeat(52));
  console.log(`  keypad      http://localhost:${config.port}/`);
  if (config.simEnabled) console.log(`  simulator   http://localhost:${config.port}/sim`);
  for (const ip of nets) console.log(`              http://${ip}:${config.port}/`);
  console.log('');
};

server.listen(config.port, config.host, async () => {
  await resolveDriver();
  await banner();
});

const shutdown = async (sig) => {
  console.log(`\n[${sig}] shutting down...`);
  server.close();
  await store.flush();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
