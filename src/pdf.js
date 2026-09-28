/**
 * Dependency-free PDF writer. Produces a real, spec-valid multi-page PDF so the
 * simulator can exercise the true CUPS/Windows print path with no sample assets
 * and no npm install on the Pi.
 */

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

/** Page counter for PDFs arriving from the web app (mirrors what pdf-parse does). */
export function countPdfPages(buf) {
  const s = buf.toString('latin1');
  const counts = [...s.matchAll(/\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
  if (counts.length) return Math.max(...counts);
  const pages = (s.match(/\/Type\s*\/Page[^s]/g) || []).length;
  return pages || 1;
}

export default makePdf;
