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
import { makePdf, countPdfPages, isPdf, isEncrypted } from './src/pdf.js';
import { parseMultipart } from './src/multipart.js';
import { qrSvg } from './src/qr.js';
import { buildUpiUri, normaliseUtr, isValidVpa } from './src/upi.js';
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
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
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

/**
 * The address a phone on the same network should open to upload.
 *
 * Machines are full of adapters that look like a LAN but route nowhere a phone
 * can reach — VirtualBox host-only, WSL, Docker, VMware, Hyper-V. Picking the
 * first 192.168.* hands the student a QR code that cannot resolve, so score the
 * interfaces and let the operator override outright.
 */
function lanAddress() {
  if (config.publicHost) return config.publicHost;

  const VIRTUAL = /virtual|vbox|vmware|hyper-v|wsl|docker|loopback|npcap|tap|tun|bluetooth/i;
  const candidates = [];

  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (!a || a.family !== 'IPv4' || a.internal) continue;
      let score = 0;
      if (VIRTUAL.test(name)) score -= 100;
      if (/^192\.168\.56\./.test(a.address)) score -= 60;   // VirtualBox host-only default
      if (/^172\.(1[7-9]|2\d|3[01])\./.test(a.address)) score -= 40; // Docker's usual range
      if (/^169\.254\./.test(a.address)) score -= 80;       // link-local, no DHCP
      if (/^192\.168\./.test(a.address)) score += 30;
      if (/^10\./.test(a.address)) score += 25;
      if (/wi-?fi|wlan|wireless|eth|en\d|Ethernet/i.test(name)) score += 20;
      candidates.push({ address: a.address, name, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.length ? candidates[0].address : 'localhost';
}

const uploadUrl = () => `http://${lanAddress()}:${config.port}/upload`;

/**
 * Staff actions (approving a payment) are gated. With ADMIN_TOKEN set, the
 * token is required. Without one, approvals are accepted only from the kiosk
 * machine itself — the console is meant to run on the Pi, not across the LAN.
 */
function isStaff(req) {
  if (config.payments.adminToken) {
    const given = req.headers['x-admin-token'] || '';
    const a = Buffer.from(String(given));
    const b = Buffer.from(config.payments.adminToken);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return ip === '127.0.0.1' || ip === '::1';
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
      uploadUrl: uploadUrl(),
      paymentMode: config.payments.mode,
      upiConfigured: isValidVpa(config.upi.vpa),
      upiStaticImage: Boolean(config.upi.qrImage),
      approvalRequired: config.payments.mode !== 'sim',
      // Lets the dashboard say "you cannot approve from here" up front, instead
      // of the staff discovering it when a button silently fails.
      canApprove: isStaff(req),
      tokenRequired: Boolean(config.payments.adminToken),
    });
  }

  if (method === 'GET' && pathname === '/api/printers') {
    return json(res, 200, await driverInfo());
  }

  /* -- QR for the upload page, so a phone can join without typing -- */

  if (method === 'GET' && pathname === '/api/qr') {
    const text = url.searchParams.get('text') || uploadUrl();
    const scale = Math.max(2, Math.min(16, Number(url.searchParams.get('scale')) || 6));
    try {
      const svg = qrSvg(text, { scale, dark: '#11161f', light: '#ffffff' });
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Content-Length': Buffer.byteLength(svg),
        'Cache-Control': 'no-store',
      });
      return res.end(svg);
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  /* -- dashboard metrics -- */

  if (method === 'GET' && pathname === '/api/stats') {
    const orders = store.listOrders();
    const docs = store.raw().documents;
    const today = new Date().toISOString().slice(0, 10);

    const completed = orders.filter((o) => o.print_status === 'COMPLETED');
    const todays = completed.filter((o) => (o.printed_at || '').slice(0, 10) === today);
    const waiting = orders.filter((o) => o.print_status === 'READY_FOR_KIOSK');
    const printing = orders.filter((o) => o.print_status === 'PRINTING');
    const failed = orders.filter((o) => o.failure_reason && o.print_status !== 'COMPLETED');

    const sheetsOf = (o) => {
      const doc = store.getDocument(o.document_id);
      if (!doc) return 0;
      return (o.duplex ? Math.ceil(doc.page_count / 2) : doc.page_count) * o.copies;
    };

    // Sheets printed per day for the last 7 days, oldest first.
    const days = [];
    for (let i = 6; i >= 0; i -= 1) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      const onDay = completed.filter((o) => (o.printed_at || '').slice(0, 10) === d);
      days.push({
        date: d,
        jobs: onDay.length,
        sheets: onDay.reduce((s, o) => s + sheetsOf(o), 0),
        revenue: onDay.reduce((s, o) => s + o.amount, 0),
      });
    }

    return json(res, 200, {
      kioskId: config.kioskId,
      uptimeSec: Math.round(process.uptime()),
      printer: await driverInfo(),
      uploadUrl: uploadUrl(),
      paymentMode: config.payments.mode,
      canApprove: isStaff(req),
      tokenRequired: Boolean(config.payments.adminToken),
      upiConfigured: isValidVpa(config.upi.vpa),
      // Everything still waiting on money, whether or not the student told us
      // they paid. Staff must be able to release a job from the dashboard even
      // when the phone never sent a reference.
      pending: orders
        .filter((o) => o.payment_status === 'PENDING' || o.payment_status === 'AWAITING_VERIFICATION')
        .map((o) => {
          const doc = store.getDocument(o.document_id);
          return {
            id: o.id,
            order_id: o.order_id,
            amount: o.amount,
            utr: o.payment_ref,
            claimed: o.payment_status === 'AWAITING_VERIFICATION',
            claimed_at: o.payment_claimed_at,
            created_at: o.created_at,
            filename: doc ? doc.original_filename : '(removed)',
            pages: doc ? doc.page_count : null,
            copies: o.copies,
            duplex: o.duplex,
            colour_mode: o.colour_mode,
            sheets: sheetsOf(o),
          };
        }),
      totals: {
        jobsToday: todays.length,
        sheetsToday: todays.reduce((s, o) => s + sheetsOf(o), 0),
        revenueToday: todays.reduce((s, o) => s + o.amount, 0),
        jobsAll: completed.length,
        revenueAll: completed.reduce((s, o) => s + o.amount, 0),
        waiting: waiting.length,
        printing: printing.length,
        failed: failed.length,
        awaitingPayment: orders.filter(
          (o) => o.payment_status === 'PENDING' || o.payment_status === 'AWAITING_VERIFICATION').length,
        shredded: docs.filter((d) => d.deleted_at).length,
        onDisk: docs.filter((d) => !d.deleted_at && d.storage_path).length,
      },
      days,
      recent: orders.slice(0, 40).map((o) => {
        const doc = store.getDocument(o.document_id);
        return {
          order_id: o.order_id,
          created_at: o.created_at,
          printed_at: o.printed_at,
          amount: o.amount,
          copies: o.copies,
          duplex: o.duplex,
          colour_mode: o.colour_mode,
          paper_size: o.paper_size,
          payment_status: o.payment_status,
          print_status: o.print_status,
          failure_reason: o.failure_reason,
          sheets: sheetsOf(o),
          filename: doc ? doc.original_filename : '(removed)',
          pages: doc ? doc.page_count : null,
          shredded: doc ? Boolean(doc.deleted_at) : true,
        };
      }),
    });
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

  /* -- real upload: a genuine PDF from the student's device -- */

  if (method === 'POST' && pathname === '/api/upload') {
    let raw;
    try {
      raw = await readBody(req, config.upload.maxBytes);
    } catch (err) {
      return json(res, 413, {
        error: `File too large. Limit is ${Math.round(config.upload.maxBytes / 1024 / 1024)} MB.`,
      });
    }

    // Accept both a real form post and a raw PUT-style body from fetch().
    let filename = decodeURIComponent(req.headers['x-filename'] || '');
    let data = raw;
    const ctype = req.headers['content-type'] || '';

    if (ctype.startsWith('multipart/form-data')) {
      let parsed;
      try {
        parsed = parseMultipart(raw, ctype);
      } catch (err) {
        return json(res, 400, { error: 'Could not read the upload: ' + err.message });
      }
      const file = parsed.files.find((f) => f.field === 'file') || parsed.files[0];
      if (!file) return json(res, 400, { error: 'No file was attached.' });
      data = file.data;
      filename = filename || file.filename;
    }

    filename = (filename || 'document.pdf').replace(/[\r\n]/g, '').trim();

    // TC-03: extension allowlist before anything touches the file.
    const ext = path.extname(filename).toLowerCase();
    if (ext && !config.upload.allowedExtensions.includes(ext)) {
      return json(res, 400, { error: `File extension ${ext} not allowed. Upload a PDF.` });
    }
    if (!data || !data.length) return json(res, 400, { error: 'The file was empty.' });

    // Magic bytes, not the extension — a .pdf that isn't a PDF is still rejected.
    if (!isPdf(data)) {
      return json(res, 400, { error: 'That file is not a PDF. Please upload a PDF.' });
    }
    if (isEncrypted(data)) {
      return json(res, 400, {
        error: 'This PDF is password-protected, so its pages cannot be counted. Please remove the password and try again.',
      });
    }

    const t0 = Date.now();
    const pageCount = countPdfPages(data);
    const parseMs = Date.now() - t0;

    if (!pageCount) {
      return json(res, 422, {
        error: 'The page count could not be read from this PDF. It may be damaged.',
      });
    }
    if (pageCount > config.upload.maxPages) {
      return json(res, 422, {
        error: `${pageCount} pages exceeds the ${config.upload.maxPages}-page limit for one job.`,
      });
    }

    // UUID-masked filename on disk: the user's name never reaches the filesystem.
    const stored = `${crypto.randomUUID()}.pdf`;
    const storagePath = path.join(config.docsDir, stored);
    await fsp.writeFile(storagePath, data);

    const doc = store.createDocument({
      stored_filename: stored,
      original_filename: path.basename(filename),
      mime_type: 'application/pdf',
      size_bytes: data.length,
      page_count: pageCount,
      storage_path: storagePath,
    });

    console.log(`[upload] ${doc.original_filename} -> ${pageCount} pages in ${parseMs}ms ` +
                `(${(data.length / 1024).toFixed(0)} KB)`);

    return json(res, 201, {
      documentId: doc.id,
      filename: doc.original_filename,
      pageCount,
      sizeBytes: data.length,
      parseMs,
    });
  }

  /* -- create an order against a really-uploaded document -- */

  if (method === 'POST' && pathname === '/api/orders') {
    const body = await readJson(req);

    const doc = store.getDocument(Number(body.documentId));
    if (!doc) return json(res, 404, { error: 'Unknown document. Please upload again.' });
    if (doc.deleted_at || !doc.storage_path) {
      return json(res, 410, { error: 'That document has already been printed and erased.' });
    }

    const copies = Number(body.copies) || 1;
    const duplex = Boolean(body.duplex);
    const colourMode = body.colourMode === 'colour' ? 'colour' : 'bw';
    const paperSize = body.paperSize === 'A3' ? 'A3' : 'A4';

    let quote;
    try {
      // Priced from the STORED page count, never a number sent by the client.
      quote = priceOrder({ pageCount: doc.page_count, copies, duplex, colourMode });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }

    const otp = generateOtp();
    const paidUpFront = config.payments.mode === 'sim';

    const order = store.createOrder({
      document_id: doc.id,
      paper_size: paperSize,
      colour_mode: colourMode,
      duplex,
      copies,
      amount: quote.amount,
      pickup_otp: otp,
      payment_status: paidUpFront ? 'PAID' : 'PENDING',
      print_status: paidUpFront ? 'READY_FOR_KIOSK' : 'CREATED',
      payment_method: config.payments.mode,
      otp_expires_at: otpExpiryISO(),
    });

    return json(res, 201, {
      order,
      quote,
      // The code exists from the start but is only handed over once paid —
      // otherwise the payment step is decorative and anyone prints for free.
      otp: paidUpFront ? otp : null,
      paymentMode: config.payments.mode,
      upiConfigured: isValidVpa(config.upi.vpa),
      upiStaticImage: Boolean(config.upi.qrImage),
      // Handed to the phone so "Open UPI app" uses the identical intent the QR encodes.
      upiUri: (!paidUpFront && isValidVpa(config.upi.vpa))
        ? buildUpiUri({ amount: quote.amount, orderId: order.order_id })
        : null,
      document: { original_filename: doc.original_filename, page_count: doc.page_count },
    });
  }

  /* ----------------------------- payments ------------------------------ */

  /** Polled by the phone after the student pays; reveals the OTP once paid. */
  if (method === 'GET' && /^\/api\/orders\/\d+\/status$/.test(pathname)) {
    const order = store.getOrder(Number(pathname.split('/')[3]));
    if (!order) return json(res, 404, { error: 'Unknown order' });
    return json(res, 200, {
      orderId: order.order_id,
      amount: order.amount,
      paymentStatus: order.payment_status,
      printStatus: order.print_status,
      // The code is handed over only once the payment is actually recognised.
      otp: order.payment_status === 'PAID' ? order.pickup_otp : null,
      utr: order.payment_ref || null,
    });
  }

  /** Your own saved bank/PhonePe QR image, when UPI_QR_IMAGE is set. */
  if (method === 'GET' && pathname === '/api/upi-image') {
    if (!config.upi.qrImage) return json(res, 404, { error: 'No UPI_QR_IMAGE configured' });
    try {
      const file = path.resolve(config.root, config.upi.qrImage);
      const data = await fsp.readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'image/jpeg',
        'Content-Length': data.length,
        'Cache-Control': 'no-store',
      });
      return res.end(data);
    } catch (err) {
      return json(res, 404, { error: 'UPI_QR_IMAGE could not be read: ' + err.message });
    }
  }

  /** The UPI intent QR for one order: amount and order id pre-filled. */
  if (method === 'GET' && pathname === '/api/upi-qr') {
    const order = store.getOrder(Number(url.searchParams.get('order')));
    if (!order) return json(res, 404, { error: 'Unknown order' });
    try {
      const uri = buildUpiUri({ amount: order.amount, orderId: order.order_id });
      const svg = qrSvg(uri, { scale: 7, dark: '#11161f', light: '#ffffff' });
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Content-Length': Buffer.byteLength(svg),
        'Cache-Control': 'no-store',
      });
      return res.end(svg);
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  /** Student says "I've paid" and submits the 12-digit UPI reference. */
  if (method === 'POST' && pathname === '/api/payments/claim') {
    const body = await readJson(req);
    const order = store.getOrder(Number(body.orderId));
    if (!order) return json(res, 404, { error: 'Unknown order' });
    if (order.payment_status === 'PAID') {
      return json(res, 200, { ok: true, alreadyPaid: true, otp: order.pickup_otp });
    }

    // The reference is optional: a person checks the money either way, and
    // refusing the job because the student could not find a 12-digit number in
    // their payment app just moves the problem to the desk.
    const raw = String(body.utr ?? '').trim();
    const utr = raw ? normaliseUtr(raw) : null;
    if (raw && !utr) {
      return json(res, 400, {
        error: 'That does not look like a 12-digit UPI reference. Leave it blank if you cannot find it.',
      });
    }

    // One reference, one job. Otherwise a single payment prints all term.
    if (utr) {
      const clash = store.raw().orders.find((o) => o.payment_ref === utr && o.id !== order.id);
      if (clash) {
        return json(res, 409, {
          error: 'That UPI reference has already been used for another order.',
        });
      }
    }

    store.updateOrder(order.id, {
      payment_status: 'AWAITING_VERIFICATION',
      payment_ref: utr,
      payment_claimed_at: new Date().toISOString(),
    });
    console.log(`[payment] ${order.order_id} claimed with UTR ${utr} — awaiting approval`);

    return json(res, 202, {
      ok: true,
      status: 'AWAITING_VERIFICATION',
      message: 'Payment submitted. A staff member will confirm it shortly.',
    });
  }

  /** Staff approve (or reject) a claimed payment from the console. */
  if (method === 'POST' && pathname === '/api/payments/approve') {
    if (!isStaff(req)) return json(res, 403, { error: 'Staff approval is not allowed from here.' });

    const body = await readJson(req);
    const order = store.getOrder(Number(body.orderId));
    if (!order) return json(res, 404, { error: 'Unknown order' });

    if (body.reject) {
      store.updateOrder(order.id, { payment_status: 'FAILED', print_status: 'CREATED' });
      console.log(`[payment] ${order.order_id} rejected by staff`);
      return json(res, 200, { ok: true, status: 'FAILED' });
    }

    store.updateOrder(order.id, {
      payment_status: 'PAID',
      print_status: 'READY_FOR_KIOSK',
      payment_verified_at: new Date().toISOString(),
      payment_method: order.payment_method || 'upi_manual',
    });
    console.log(`[payment] ${order.order_id} approved by staff — OTP released`);
    return json(res, 200, { ok: true, status: 'PAID' });
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
      payment_status: 'PAID',            // /sim shortcut: skips the approval step
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
    if (url.pathname === '/upload') {
      if (await serveStatic(res, '/upload.html')) return;
    }
    if (url.pathname === '/admin') {
      if (await serveStatic(res, '/admin.html')) return;
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
  console.log(`  upload      ${uploadUrl()}      <- open this on the phone`);
  console.log(`  dashboard   http://localhost:${config.port}/admin`);
  if (config.simEnabled) console.log(`  simulator   http://localhost:${config.port}/sim`);
  for (const ip of nets) console.log(`              http://${ip}:${config.port}/`);
  console.log('');

  // Windows has no built-in silent PDF printer. Say so at boot rather than
  // letting the first real job fail with a dialog nobody is standing next to.
  if (info.driver === 'windows') {
    const { DRIVERS } = await import('./src/printer.js');
    const sumatra = await DRIVERS.windows.findSumatra();
    if (!sumatra) {
      console.log('  note: no SumatraPDF found. Windows cannot print a PDF silently without it,');
      console.log('        so jobs fall back to the shell print verb (may open a dialog).');
      console.log('        Install it (winget install SumatraPDF.SumatraPDF) or set SUMATRA_PATH.');
      console.log('        On the Raspberry Pi this does not apply - CUPS prints directly.');
      console.log('');
    }
  }
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
