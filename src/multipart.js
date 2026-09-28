/**
 * Binary-safe multipart/form-data parser.
 *
 * The report uses multer; this does the same job in ~90 lines with no
 * dependency, and — like multer's memoryStorage — never writes the upload to
 * disk before it has been validated. Everything is done on Buffers, never
 * strings: decoding a PDF through UTF-8 corrupts it beyond repair.
 */

function parseHeaders(block) {
  const headers = {};
  for (const line of block.toString('latin1').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return headers;
}

function dispositionValue(disposition, key) {
  // filename="report final.pdf"  |  name=file
  const quoted = new RegExp(`${key}="([^"]*)"`).exec(disposition);
  if (quoted) return quoted[1];
  const bare = new RegExp(`${key}=([^;]+)`).exec(disposition);
  return bare ? bare[1].trim() : '';
}

/**
 * @returns {{fields: Object<string,string>, files: Array<{field,filename,contentType,data}>}}
 */
export function parseMultipart(buf, contentType) {
  const bm = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!bm) throw new Error('Missing multipart boundary');
  const boundary = Buffer.from(`--${(bm[1] || bm[2]).trim()}`, 'latin1');

  const fields = {};
  const files = [];

  let pos = buf.indexOf(boundary);
  if (pos < 0) throw new Error('Malformed multipart body');

  while (pos >= 0) {
    let start = pos + boundary.length;

    // Closing boundary is "--boundary--"
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break;
    if (buf[start] === 0x0d) start += 1;
    if (buf[start] === 0x0a) start += 1;

    const headerEnd = buf.indexOf('\r\n\r\n', start, 'latin1');
    if (headerEnd < 0) break;

    const headers = parseHeaders(buf.subarray(start, headerEnd));
    const bodyStart = headerEnd + 4;

    const next = buf.indexOf(boundary, bodyStart);
    if (next < 0) break;

    // Trim the CRLF that precedes the next boundary — it is a delimiter, not data.
    let bodyEnd = next;
    if (buf[bodyEnd - 1] === 0x0a) bodyEnd -= 1;
    if (buf[bodyEnd - 1] === 0x0d) bodyEnd -= 1;

    const disposition = headers['content-disposition'] || '';
    const field = dispositionValue(disposition, 'name');
    const filename = dispositionValue(disposition, 'filename');
    const data = buf.subarray(bodyStart, bodyEnd);

    if (filename) {
      files.push({
        field,
        filename,
        contentType: headers['content-type'] || 'application/octet-stream',
        data,
      });
    } else if (field) {
      fields[field] = data.toString('utf8');
    }

    pos = next;
  }

  return { fields, files };
}

export default parseMultipart;
