import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import config from './config.js';

/**
 * Tiny durable JSON store shaped like the report's Postgres schema
 * (documents + orders). Swap this file for a Supabase/SQLite adapter and
 * nothing else in the agent changes.
 */

const EMPTY = { seq: { document: 0, order: 0 }, documents: [], orders: [] };

let db = structuredClone(EMPTY);
let writeChain = Promise.resolve();

export function ensureDirs() {
  for (const d of [config.dataDir, config.docsDir, config.spoolDir, config.mockDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

export function load() {
  ensureDirs();
  try {
    const raw = fs.readFileSync(config.dbFile, 'utf8');
    const parsed = JSON.parse(raw);
    db = { ...structuredClone(EMPTY), ...parsed };
    db.seq = { ...EMPTY.seq, ...(parsed.seq || {}) };
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[store] unreadable db, starting fresh:', err.message);
    db = structuredClone(EMPTY);
    persist();
  }
  return db;
}

/** Serialised atomic write: tmp file + rename, so a power cut can't truncate the db. */
export function persist() {
  const snapshot = JSON.stringify(db, null, 2);
  writeChain = writeChain.then(async () => {
    const tmp = `${config.dbFile}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, snapshot, 'utf8');
    await fsp.rename(tmp, config.dbFile);
  }).catch((err) => console.error('[store] persist failed:', err.message));
  return writeChain;
}

export const flush = () => writeChain;

export function nextId(kind) {
  db.seq[kind] = (db.seq[kind] || 0) + 1;
  return db.seq[kind];
}

/* ------------------------------- documents ------------------------------- */

export function createDocument(doc) {
  const row = {
    id: nextId('document'),
    stored_filename: doc.stored_filename,
    original_filename: doc.original_filename,
    mime_type: doc.mime_type || 'application/pdf',
    size_bytes: doc.size_bytes || 0,
    page_count: doc.page_count,
    storage_path: doc.storage_path,
    created_at: new Date().toISOString(),
    deleted_at: null,
  };
  db.documents.push(row);
  persist();
  return row;
}

export const getDocument = (id) => db.documents.find((d) => d.id === id) || null;

export function markDocumentShredded(id) {
  const doc = getDocument(id);
  if (!doc) return null;
  doc.deleted_at = new Date().toISOString();
  doc.storage_path = null;
  persist();
  return doc;
}

/* --------------------------------- orders -------------------------------- */

export function createOrder(order) {
  const id = nextId('order');
  const year = new Date().getFullYear();
  const row = {
    id,
    order_id: order.order_id || `PK-${year}-${String(id).padStart(6, '0')}`,
    document_id: order.document_id,
    paper_size: order.paper_size || 'A4',
    colour_mode: order.colour_mode || 'bw',
    duplex: order.duplex ? 1 : 0,
    copies: order.copies || 1,
    amount: order.amount,
    pickup_otp: order.pickup_otp,
    payment_status: order.payment_status || 'PENDING',
    print_status: order.print_status || 'CREATED',
    otp_expires_at: order.otp_expires_at,
    kiosk_id: null,
    printer_job_id: null,
    payment_method: order.payment_method || null,
    payment_ref: null,
    payment_claimed_at: null,
    payment_verified_at: null,
    failure_reason: null,
    created_at: new Date().toISOString(),
    printed_at: null,
  };
  db.orders.push(row);
  persist();
  return row;
}

export const listOrders = () => db.orders.slice().sort((a, b) => b.id - a.id);
export const getOrder = (id) => db.orders.find((o) => o.id === id) || null;
export const getOrderByBusinessId = (oid) => db.orders.find((o) => o.order_id === oid) || null;

/** Every order still eligible for OTP release — the scan set for constant-time matching. */
export const releasableOrders = () =>
  db.orders.filter((o) => o.payment_status === 'PAID' && o.print_status === 'READY_FOR_KIOSK');

export function updateOrder(id, patch) {
  const order = getOrder(id);
  if (!order) return null;
  Object.assign(order, patch);
  persist();
  return order;
}

export const raw = () => db;
