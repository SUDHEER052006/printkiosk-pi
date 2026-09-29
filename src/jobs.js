import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import config from './config.js';
import * as store from './store.js';
import { printFile } from './printer.js';
import { remotePrint, agentStatus } from './remote.js';

/**
 * One line decides where paper comes from. Locally it is this machine's own
 * printer; in cloud mode the job is handed to the print agent over https and
 * the rest of this file — progress, shredding, SSE — is identical.
 */
const spool = config.cloud ? remotePrint : printFile;

/**
 * Job orchestrator: owns the order lifecycle from OTP release through
 * spooling, completion and zero-trace shredding, and broadcasts progress
 * to the kiosk screen over SSE.
 *
 *   READY_FOR_KIOSK -> PRINTING -> COMPLETED
 *                              \-> FAILED (order returns to READY_FOR_KIOSK)
 */

export const bus = new EventEmitter();
bus.setMaxListeners(50);

const jobs = new Map(); // jobId -> job record

export const getJob = (id) => jobs.get(id) || null;

function emit(job, patch) {
  Object.assign(job, patch, { updatedAt: Date.now() });
  job.history.push({ at: Date.now(), stage: job.stage, percent: job.percent, message: job.message });
  bus.emit(`job:${job.id}`, snapshot(job));
  bus.emit('job', snapshot(job));
}

export function snapshot(job) {
  return {
    jobId: job.id,
    orderId: job.order.order_id,
    stage: job.stage,
    percent: job.percent,
    message: job.message,
    done: job.done,
    succeeded: job.succeeded,
    error: job.error,
    driver: job.driver,
    printerJobId: job.printerJobId,
    summary: job.summary,
  };
}

/**
 * Turns an internal error into something a student can act on. Raw messages
 * leak filesystem paths and queue internals onto a public screen, so the
 * technical text goes to the log and only the mapped line reaches the kiosk.
 */
function friendlyError(err) {
  const m = String(err && err.message ? err.message : err);
  if (/ENOENT|no such file/i.test(m)) return 'Your document could not be found. Please contact the desk.';
  if (/timed out/i.test(m)) return 'The printer did not respond in time. Please try again.';
  if (/No (CUPS|Windows) printer/i.test(m)) return 'This kiosk has no printer configured. Please tell the desk staff.';
  if (/No print station collected/i.test(m)) return 'The print station did not respond. Your code still works — please try again or see the desk staff.';
  if (/print station stopped responding/i.test(m)) return 'The print station dropped out mid-job. Please see the desk staff before paying again.';
  if (/print station reported/i.test(m)) return 'The printer could not finish this job. Please see the desk staff.';
  if (/without completing|cancel/i.test(m)) return 'The print job was cancelled at the printer. Please try again.';
  if (/already shredded/i.test(m)) return 'This document has already been printed.';
  if (/paper|jam|toner|ink|offline|busy/i.test(m)) return 'The printer needs attention (paper, toner or jam). Please tell the desk staff.';
  return 'The printer could not complete this job. Please try again or see the desk staff.';
}

/** Shred the document from kiosk storage the moment the sheets are out. */
async function shred(doc) {
  if (!config.shredOnComplete || !doc) return;
  try {
    if (doc.storage_path) await fs.rm(doc.storage_path, { force: true });
  } catch (err) {
    console.warn('[shred] file removal failed:', err.message);
  }
  store.markDocumentShredded(doc.id);
}

/**
 * Starts a print job for an already OTP-verified order. Returns immediately with
 * the job id; progress arrives on the bus.
 */
export function startJob(order, { printerName } = {}) {
  const doc = store.getDocument(order.document_id);
  if (!doc) throw new Error('Document record missing for this order');
  if (!doc.storage_path) throw new Error('Document already shredded');
  // Refuse before the code is spent, rather than after: a student watching a
  // spinner that can never finish is worse than being told to see the desk.
  if (config.cloud && !agentStatus().online) {
    throw new Error('No print station is connected to this kiosk right now');
  }

  const id = crypto.randomUUID();
  const sheetsPerCopy = order.duplex ? Math.ceil(doc.page_count / 2) : doc.page_count;

  const job = {
    id,
    order,
    doc,
    stage: 'VERIFIED',
    percent: 8,
    message: 'OTP accepted',
    done: false,
    succeeded: false,
    error: null,
    driver: null,
    printerJobId: null,
    history: [],
    summary: {
      orderId: order.order_id,
      file: doc.original_filename,
      pages: doc.page_count,
      copies: order.copies,
      duplex: Boolean(order.duplex),
      colourMode: order.colour_mode,
      paperSize: order.paper_size,
      sheets: sheetsPerCopy * order.copies,
      amount: order.amount,
    },
  };

  jobs.set(id, job);

  store.updateOrder(order.id, {
    print_status: 'PRINTING',
    kiosk_id: config.kioskId,
    failure_reason: null,
  });

  // Run detached; the HTTP response for verify-otp must not wait for paper.
  run(job).catch((err) => {
    console.error('[jobs] unexpected failure:', err);
  });

  return job;
}

async function run(job) {
  const { order, doc } = job;

  try {
    emit(job, { stage: 'FETCHING', percent: 14, message: 'Loading document' });

    const result = await spool(
      doc.storage_path,
      {
        copies: order.copies,
        duplex: Boolean(order.duplex),
        colourMode: order.colour_mode,
        paperSize: order.paper_size,
        totalSheets: job.summary.sheets,
        label: order.order_id,
      },
      (ev) => {
        if (ev.jobId) job.printerJobId = ev.jobId;
        emit(job, {
          stage: ev.stage,
          percent: Math.max(job.percent, ev.percent ?? job.percent),
          message: ev.message || job.message,
        });
      },
    );

    job.driver = result.driver;
    job.printerJobId = result.jobId || job.printerJobId;

    emit(job, { stage: 'SHREDDING', percent: 98, message: 'Erasing document from kiosk' });
    await shred(doc);

    store.updateOrder(order.id, {
      print_status: 'COMPLETED',
      printer_job_id: job.printerJobId,
      printed_at: new Date().toISOString(),
    });

    emit(job, {
      stage: 'COMPLETED',
      percent: 100,
      message: 'Collect your printout',
      done: true,
      succeeded: true,
    });
  } catch (err) {
    const shown = friendlyError(err);
    console.error(`[jobs] ${order.order_id} failed:`, err.message);

    // Return the order to the queue so the student can retry with the same OTP.
    store.updateOrder(order.id, {
      print_status: 'READY_FOR_KIOSK',
      failure_reason: err.message,          // technical detail stays in the record
    });
    emit(job, {
      stage: 'FAILED',
      percent: 100,
      message: shown,
      done: true,
      succeeded: false,
      error: shown,                          // only the safe text reaches the screen
    });
  } finally {
    // Keep the record briefly so a reconnecting screen can still read the result.
    setTimeout(() => jobs.delete(job.id), 5 * 60 * 1000).unref?.();
  }
}

export default { startJob, getJob, snapshot, bus };
