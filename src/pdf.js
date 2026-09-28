/**
 * Dependency-free PDF writer. Produces a real, spec-valid multi-page PDF so the
 * simulator can exercise the true CUPS/Windows print path with no sample assets
 * and no npm install on the Pi.
 */

import zlib from 'node:zlib';

const BACKSLASH = String.fromCharCode(92);

const esc = (s) =>
  String(s)
    .split(BACKSLASH).join(BACKSLASH + BACKSLASH)
    .split('(').join(BACKSLASH + '(')
    .split(')').join(BACKSLASH + ')');

function contentStream(lines) {
  const out = ['BT'];
  for (const { text, size = 12, x = 64, y, font = 'F1' } of lines) {
    out.push(`/${font} ${size} Tf`, `1 0 0 1 ${x} ${y} Tm`, `(${esc(text)}) Tj`);
  }
  out.push('ET');
  return out.join('\n');
}

function pageLines({ title, pageNo, pageCount, orderId, note }) {
  const lines = [
    { text: title, size: 22, y: 760 },
    { text: `Page ${pageNo} of ${pageCount}`, size: 11, y: 730 },
    { text: '________________________________________________', size: 12, y: 716 },
  ];

  let y = 676;
  const body = [
    'PRINTKIOSK simulation document.',
    '',
    orderId ? `Order:        ${orderId}` : '',
    `Generated:    ${new Date().toISOString()}`,
    note ? `Note:         ${note}` : '',
    '',
    'If you are holding this sheet, the full release path worked:',
    '  1. Order marked PAID and READY_FOR_KIOSK',
    '  2. 6-digit OTP entered on the kiosk touchscreen',
    '  3. Job handed to the local print spooler',
    '  4. Source file shredded from kiosk storage',
  ];

  for (const text of body) {
    if (text) lines.push({ text, size: 12, y });
    y -= 20;
  }

  lines.push({ text: `sheet marker ${pageNo}/${pageCount}`, size: 9, y: 60 });
  return lines;
}

export function makePdf({
  title = 'PrintKiosk Test Document',
  pageCount = 1,
  orderId = '',
  note = '',
} = {}) {
  const n = Math.max(1, Math.min(200, Number(pageCount) || 1));

  const objects = []; // index === PDF object number
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';

  const kids = [];
  for (let p = 0; p < n; p += 1) kids.push(`${4 + p * 2} 0 R`);
  objects[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${n} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

  for (let p = 0; p < n; p += 1) {
    const pageNum = 4 + p * 2;
    const contentNum = pageNum + 1;
    objects[pageNum] =
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNum} 0 R >>`;
    const stream = contentStream(pageLines({ title, pageNo: p + 1, pageCount: n, orderId, note }));
    objects[contentNum] =
      `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
  }

  const maxObj = 3 + n * 2;
  const chunks = [];
  let offset = 0;
  const push = (buf) => {
    chunks.push(buf);
    offset += buf.length;
  };

  push(Buffer.from('%PDF-1.4\n', 'latin1'));
  push(Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // binary marker

  const offsets = new Array(maxObj + 1).fill(0);
  for (let i = 1; i <= maxObj; i += 1) {
    offsets[i] = offset;
    push(Buffer.from(`${i} 0 obj\n${objects[i]}\nendobj\n`, 'latin1'));
  }

  const startxref = offset;
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= maxObj; i += 1) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  push(Buffer.from(xref, 'latin1'));
  push(
    Buffer.from(
      `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`,
      'latin1',
    ),
  );

  return Buffer.concat(chunks);
}

/* ========================================================================== *
 *  Page counting for real uploads
 * ========================================================================== */

/**
 * Returns [start, end) of the `<< ... >>` dictionary containing `idx`, matching
 * nesting properly. A page-tree node's /Kids array can run for kilobytes, so a
 * fixed character window around /Type /Pages routinely lands in a *neighbouring*
 * node and reads the wrong /Count — which silently prices the wrong page count.
 */
function enclosingDict(text, idx) {
  let depth = 0;
  let start = -1;
  for (let i = idx; i >= 1; i -= 1) {
    if (text[i] === '>' && text[i - 1] === '>') { depth += 1; i -= 1; continue; }
    if (text[i] === '<' && text[i - 1] === '<') {
      if (depth === 0) { start = i - 1; break; }
      depth -= 1; i -= 1;
    }
  }
  if (start < 0) return null;

  depth = 0;
  for (let i = start; i < text.length - 1; i += 1) {
    if (text[i] === '<' && text[i + 1] === '<') { depth += 1; i += 1; continue; }
    if (text[i] === '>' && text[i + 1] === '>') {
      depth -= 1;
      if (depth === 0) return [start, i + 2];
      i += 1;
    }
  }
  return null;
}

/** /Count read from the node's own dictionary — the root holds the largest. */
function scanPageTree(text) {
  const counts = [];
  const re = /\/Type\s*\/Pages\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const span = enclosingDict(text, m.index);
    if (!span) continue;
    // Read /Count at this dict's own depth, not from a nested child dict.
    const dict = text.slice(span[0], span[1]);
    const c = dict.match(/\/Count\s+(\d+)/);
    if (c) counts.push(Number(c[1]));
  }
  return counts.length ? Math.max(...counts) : 0;
}

/**
 * PDF 1.5+ hides the catalog and page tree inside compressed object streams
 * (/Type /ObjStm), so a plain text scan finds nothing in perfectly ordinary
 * files from Word, Chrome or LaTeX. Node ships zlib, so we inflate just those
 * streams — never image data — and scan what comes out.
 */
function inflateObjectStreams(buf) {
  const hay = buf.toString('latin1');
  const out = [];
  const re = /\/ObjStm\b/g;
  let m;

  while ((m = re.exec(hay)) !== null) {
    const span = enclosingDict(hay, m.index);
    if (!span) continue;
    const dict = hay.slice(span[0], span[1]);
    if (!/\/FlateDecode/.test(dict)) continue;

    // The stream keyword follows the dictionary, then a CRLF or LF.
    const kw = hay.indexOf('stream', span[1]);
    if (kw < 0 || kw > span[1] + 40) continue;
    let start = kw + 6;
    if (hay[start] === '\r') start += 1;
    if (hay[start] === '\n') start += 1;

    // Prefer the declared /Length; fall back to the endstream marker.
    const lenMatch = dict.match(/\/Length\s+(\d+)\b/);
    const byLength = lenMatch ? start + Number(lenMatch[1]) : -1;
    const byMarker = hay.indexOf('endstream', start);
    const candidates = [byLength, byMarker].filter((e) => e > start);

    for (const end of candidates) {
      try {
        out.push(zlib.inflateSync(buf.subarray(start, end)).toString('latin1'));
        break;
      } catch {
        try {
          out.push(zlib.inflateRawSync(buf.subarray(start, end)).toString('latin1'));
          break;
        } catch { /* try the next boundary */ }
      }
    }
  }
  return out.join('\n');
}

export function isPdf(buf) {
  return Buffer.isBuffer(buf) && buf.length > 4 && buf.subarray(0, 5).toString('latin1') === '%PDF-';
}

export function isEncrypted(buf) {
  return /\/Encrypt\s+\d+\s+\d+\s+R/.test(buf.toString('latin1', 0, Math.min(buf.length, 4_000_000)));
}

/**
 * Counts pages in a real uploaded PDF. Three passes, cheapest first:
 *   1. page tree in plain text            (most PDFs)
 *   2. page tree inside inflated ObjStms  (PDF 1.5+ / Word / Chrome)
 *   3. count /Type /Page leaves           (last resort, damaged files)
 * Returns 0 when it genuinely cannot tell, so the caller can reject the upload
 * rather than silently charge for the wrong number of sheets.
 */
export function countPdfPages(buf) {
  if (!isPdf(buf)) return 0;
  const text = buf.toString('latin1');

  const direct = scanPageTree(text);
  if (direct > 0) return direct;

  const inflated = inflateObjectStreams(buf);
  if (inflated) {
    const fromStreams = scanPageTree(inflated);
    if (fromStreams > 0) return fromStreams;
  }

  const leaves = (text.match(/\/Type\s*\/Page[^s]/g) || []).length;
  return leaves > 0 ? leaves : 0;
}

export default makePdf;
