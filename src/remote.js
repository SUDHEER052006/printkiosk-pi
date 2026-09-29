import crypto from 'node:crypto';
import config from './config.js';

/**
 * Cloud-side print queue.
 *
 * On Render (or any host) there is no printer and no route into the campus LAN,
 * so the cloud cannot spool anything itself. What it can do is hold the job and
 * wait for the machine that IS wired to the printer to come and take it.
 *
 * That machine runs `agent.js`. It only ever makes OUTBOUND https requests, so
 * it works from any Wi-Fi, behind any NAT, with no port forwarding and no fixed
 * IP:
 *
 *   kiosk screen --(code)--> cloud --(long poll)-- agent --> CUPS --> paper
 *                              ^                    |
 *                              +---(progress)-------+
 *
 * `remotePrint` is deliberately shaped exactly like `printer.js#printFile`, so
 * jobs.js swaps one for the other and nothing else in the pipeline changes.
 */

const pending = [];              // tickets nobody has claimed yet
const tickets = new Map();       // ticketId -> ticket
const waiters = [];              // parked long-poll resolvers

let agent = { lastSeen: 0, kioskId: null, host: null, printer: null, version: null };

/* ------------------------------ agent presence ---------------------------- */

export function noteAgent(info = {}) {
  agent = {
    lastSeen: Date.now(),
    kioskId: info.kioskId || agent.kioskId,
    host: info.host || agent.host,
    printer: info.printer || agent.printer,
    version: info.version || agent.version,
  };
  return agentStatus();
}

export function agentStatus() {
  const since = Date.now() - agent.lastSeen;
  return {
    online: agent.lastSeen > 0 && since < config.agent.offlineAfterMs,
    lastSeenMsAgo: agent.lastSeen ? since : null,
    kioskId: agent.kioskId,
    host: agent.host,
    printer: agent.printer,
    version: agent.version,
    queued: pending.length,
    inFlight: [...tickets.values()].filter((t) => t.claimedAt && !t.settled).length,
  };
}

/* --------------------------------- queueing ------------------------------- */

function wake() {
  while (waiters.length && pending.length) {
    const resolve = waiters.shift();
    resolve();
  }
}

function settle(ticket, err, result) {
  if (ticket.settled) return;
  ticket.settled = true;
  const at = pending.indexOf(ticket);
  if (at >= 0) pending.splice(at, 1);
  tickets.delete(ticket.id);
  if (err) ticket.reject(err);
  else ticket.resolve(result);
}

/** Same contract as printFile(): resolves once the sheets are out. */
export function remotePrint(file, opts = {}, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const ticket = {
      id: crypto.randomUUID(),
      file,
      opts: {
        copies: opts.copies || 1,
        duplex: Boolean(opts.duplex),
        colourMode: opts.colourMode || 'bw',
        paperSize: opts.paperSize || 'A4',
        totalSheets: opts.totalSheets,
        printerName: opts.printerName || '',
      },
      label: opts.label || '',
      onProgress,
      resolve,
      reject,
      createdAt: Date.now(),
      claimedAt: 0,
      lastBeat: Date.now(),
      requeues: 0,
      settled: false,
    };

    tickets.set(ticket.id, ticket);
    pending.push(ticket);

    onProgress({
      stage: 'QUEUED',
      percent: 18,
      message: agentStatus().online
        ? 'Sending to the print station'
        : 'Waiting for the print station to come online',
    });

    wake();
  });
}

/** Long poll: hands the agent the next job, or null when the wait runs out. */
export function claimNext(timeoutMs = config.agent.longPollMs) {
  return new Promise((resolve) => {
    const take = () => {
      const ticket = pending.shift();
      if (!ticket) return false;
      ticket.claimedAt = Date.now();
      ticket.lastBeat = Date.now();
      ticket.onProgress({ stage: 'SPOOLING', percent: 26, message: 'Print station picked up the job' });
      resolve({
        ticketId: ticket.id,
        opts: ticket.opts,
        label: ticket.label,
        waitedMs: ticket.claimedAt - ticket.createdAt,
      });
      return true;
    };

    if (take()) return;

    const timer = setTimeout(() => {
      const at = waiters.indexOf(onReady);
      if (at >= 0) waiters.splice(at, 1);
      resolve(null);
    }, timeoutMs);

    function onReady() {
      clearTimeout(timer);
      if (!take()) resolve(null);
    }
    waiters.push(onReady);
  });
}

export function ticketFile(ticketId) {
  const t = tickets.get(ticketId);
  return t && !t.settled ? t.file : null;
}

export function progress(ticketId, ev = {}) {
  const t = tickets.get(ticketId);
  if (!t || t.settled) return false;
  t.lastBeat = Date.now();
  t.onProgress({
    stage: ev.stage || 'PRINTING',
    percent: Number(ev.percent) || undefined,
    message: ev.message || '',
  });
  return true;
}

export function finish(ticketId, body = {}) {
  const t = tickets.get(ticketId);
  if (!t || t.settled) return false;
  if (body.ok) {
    settle(t, null, {
      jobId: body.printerJobId || null,
      driver: body.driver || 'agent',
      receipt: body.receipt || '',
    });
  } else {
    settle(t, new Error(body.error || 'The print station reported a failure'));
  }
  return true;
}

/* ------------------------------- housekeeping ----------------------------- */

/**
 * Two ways a remote job can rot: no agent ever takes it, or an agent takes it
 * and then dies mid-print. Both have to end in a definite answer on the kiosk
 * screen rather than a spinner, and the order goes back to READY_FOR_KIOSK so
 * the same code still works on the next attempt.
 */
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const t of [...tickets.values()]) {
    if (t.settled) continue;

    if (!t.claimedAt) {
      if (now - t.createdAt > config.agent.claimWaitMs) {
        settle(t, new Error('No print station collected this job'));
      }
      continue;
    }

    if (now - t.lastBeat > config.agent.beatTimeoutMs) {
      if (t.requeues < 1) {
        t.requeues += 1;
        t.claimedAt = 0;
        t.lastBeat = now;
        t.createdAt = now;                 // fresh claim window
        pending.push(t);
        t.onProgress({ stage: 'QUEUED', percent: 20, message: 'Print station went quiet — requeued' });
        wake();
      } else {
        settle(t, new Error('The print station stopped responding mid-job'));
      }
    }
  }
}, 2000);
sweeper.unref?.();

export default { remotePrint, claimNext, ticketFile, progress, finish, noteAgent, agentStatus };
