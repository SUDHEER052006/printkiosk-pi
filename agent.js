#!/usr/bin/env node
/**
 * PRINTKIOSK print agent.
 *
 * Runs on the machine physically wired to the printer — the Raspberry Pi at the
 * kiosk, or a Windows PC. Its whole job is to take print jobs off the cloud
 * server and put them on paper.
 *
 *   node agent.js --server https://printkiosk.onrender.com --token <AGENT_TOKEN>
 *
 * Why it exists: a Render instance has no CUPS, no printer and no way into the
 * campus LAN. It also cannot reach *into* this machine. So this side does all
 * the connecting — plain outbound https, long-polled. That means it works on any
 * Wi-Fi, on a hotspot, behind CGNAT, with no port forwarding, no fixed IP and no
 * firewall change. Unplug it, move it to another network, and it reconnects.
 *
 * Zero npm dependencies. Node 18+ (needs global fetch).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import config from './src/config.js';
import { printFile, driverInfo, resolveDriver } from './src/printer.js';

const VERSION = '1.0.0';

/* --------------------------------- options -------------------------------- */

function argv(name, fallback = '') {
  const i = process.argv.indexOf('--' + name);
  if (i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return fallback;
}

const SERVER = argv('server', process.env.CLOUD_URL || process.env.SERVER_URL || '').replace(/\/+$/, '');
const TOKEN = argv('token', process.env.AGENT_TOKEN || '');
const PRINTER = argv('printer', process.env.PRINTER_NAME || '');
const LABEL = argv('id', process.env.KIOSK_ID || 'station-' + os.hostname());
const WAIT_MS = Number(process.env.AGENT_LONGPOLL_MS || 25000);

if (!SERVER || !/^https?:\/\//.test(SERVER)) {
  console.error('\nThe agent needs the address of your deployment:\n');
  console.error('  node agent.js --server https://your-app.onrender.com --token <AGENT_TOKEN>\n');
  console.error('or set CLOUD_URL and AGENT_TOKEN in .env\n');
  process.exit(1);
}
if (!TOKEN) {
  console.error('\nAGENT_TOKEN is missing. It must match the AGENT_TOKEN set on the server.\n');
  process.exit(1);
}
if (PRINTER) config.printer.name = PRINTER;

const api = (p) => SERVER + p;
const headers = (extra = {}) => ({ 'X-Agent-Token': TOKEN, ...extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* -------------------------------- heartbeat ------------------------------- */

let online = false;

async function hello() {
  const info = await driverInfo().catch(() => ({}));
  const res = await fetch(api('/api/agent/hello'), {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ kioskId: LABEL, host: os.hostname(), version: VERSION, printer: info }),
  });
  if (res.status === 401) throw new Error('AGENT_TOKEN rejected by the server');
  if (!res.ok) throw new Error('hello failed with HTTP ' + res.status);
  return res.json();
}

/* --------------------------------- one job -------------------------------- */

const spoolDir = path.join(config.dataDir, 'agent-spool');

async function report(ticketId, ev) {
  try {
    await fetch(api('/api/agent/jobs/' + ticketId + '/progress'), {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(ev),
    });
  } catch { /* progress is cosmetic; never fail a print over it */ }
}

async function finish(ticketId, body) {
  await fetch(api('/api/agent/jobs/' + ticketId + '/done'), {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  }).catch(() => {});
}

async function handle(ticket) {
  const { ticketId, opts, label } = ticket;
  const tag = label || ticketId.slice(0, 8);
  console.log('[job ' + tag + '] claimed after ' + Math.round((ticket.waitedMs || 0) / 1000) + 's — ' +
    opts.copies + 'x, ' + (opts.duplex ? 'duplex' : 'single') + ', ' + opts.colourMode + ', ' + opts.paperSize);

  const file = path.join(spoolDir, crypto.randomUUID() + '.pdf');
  let done = false;

  // The cloud fails a job whose station goes quiet. A long print is not quiet,
  // it is busy — so keep a slow drip going until the driver reports back.
  const keepalive = setInterval(() => {
    if (!done) report(ticketId, { stage: 'PRINTING', message: 'Printing' });
  }, 20000);
  keepalive.unref?.();

  try {
    await report(ticketId, { stage: 'FETCHING', percent: 32, message: 'Downloading your document' });

    const res = await fetch(api('/api/agent/jobs/' + ticketId + '/file'), { headers: headers() });
    if (!res.ok) throw new Error('could not download the document (HTTP ' + res.status + ')');
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!bytes.length) throw new Error('the document downloaded empty');
    await fs.writeFile(file, bytes);
    console.log('[job ' + tag + '] downloaded ' + (bytes.length / 1024).toFixed(0) + ' KB');

    const result = await printFile(
      file,
      { ...opts, printerName: opts.printerName || config.printer.name },
      (ev) => report(ticketId, ev),
    );

    done = true;
    clearInterval(keepalive);
    console.log('[job ' + tag + '] printed via ' + result.driver + (result.jobId ? ' (queue id ' + result.jobId + ')' : ''));
    await finish(ticketId, { ok: true, printerJobId: result.jobId || null, driver: result.driver });
  } catch (err) {
    done = true;
    clearInterval(keepalive);
    console.error('[job ' + tag + '] FAILED: ' + err.message);
    await finish(ticketId, { ok: false, error: err.message });
  } finally {
    clearInterval(keepalive);
    // Zero-trace on this side too: the cloud shreds its copy, we shred ours.
    await fs.rm(file, { force: true }).catch(() => {});
  }
}

/* --------------------------------- the loop ------------------------------- */

async function loop() {
  let backoff = 1000;

  for (;;) {
    try {
      if (!online) {
        const ack = await hello();
        online = true;
        backoff = 1000;
        const p = (await driverInfo().catch(() => ({}))) || {};
        console.log('');
        console.log('  connected to ' + SERVER);
        console.log('  station     ' + LABEL + ' on ' + os.hostname());
        console.log('  driver      ' + p.driver + (p.simulated ? '  (SIMULATION — no paper will move)' : ''));
        console.log('  printer     ' + (p.activePrinter || '(system default)'));
        console.log('  waiting for print jobs...');
        console.log('');
        if (ack.cloud === false) {
          console.log('  note: that server is running in LOCAL mode, so it prints by itself and');
          console.log('        will never hand this agent a job. Set CLOUD=true on the server.');
          console.log('');
        }
      }

      const res = await fetch(api('/api/agent/next?wait=' + WAIT_MS), { headers: headers() });

      if (res.status === 204) { await hello(); continue; }   // idle tick doubles as a heartbeat
      if (res.status === 401) throw new Error('AGENT_TOKEN rejected by the server');
      if (!res.ok) throw new Error('poll failed with HTTP ' + res.status);

      await handle(await res.json());
    } catch (err) {
      online = false;
      console.error('[agent] ' + err.message + ' — retrying in ' + Math.round(backoff / 1000) + 's');
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30000);
    }
  }
}

/* ---------------------------------- boot ---------------------------------- */

await fs.mkdir(spoolDir, { recursive: true });
await resolveDriver();

const info = await driverInfo();
console.log('');
console.log('  PRINTKIOSK  print station agent  v' + VERSION);
console.log('  ' + '-'.repeat(52));
console.log('  server      ' + SERVER);
console.log('  driver      ' + info.driver);
console.log('  printer     ' + (info.activePrinter || '(system default)'));
console.log('  queues      ' + (info.printers.length ? info.printers.join(', ') : '(none detected)'));
console.log('  ' + '-'.repeat(52));

if (info.simulated) {
  console.log('  WARNING: no real printer found, so this agent will only SIMULATE printing.');
  console.log('           Configure CUPS (Pi) or add a Windows printer, then restart.');
}

const bye = () => { console.log('\n[agent] stopped'); process.exit(0); };
process.on('SIGINT', bye);
process.on('SIGTERM', bye);

loop();
