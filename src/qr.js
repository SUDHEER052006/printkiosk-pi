/**
 * Minimal QR encoder — byte mode, error-correction level M, versions 1-10.
 *
 * Exists so the kiosk screen can show a code the student scans with their phone
 * to reach the upload page. A CDN library is not an option: the kiosk must work
 * with the campus network down, and the project carries no dependencies.
 *
 * Enough of ISO/IEC 18004 to encode a LAN URL, and no more.
 */

/* ----------------------------- GF(256) tables ---------------------------- */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // primitive polynomial
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
})();

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/**
 * Generator polynomial for `degree` error-correction codewords.
 * Built constant-term-first, then reversed: rsEncode indexes it with the
 * leading coefficient at [0], and feeding it the other way round yields data
 * that is correct with error-correction bytes that are quietly garbage.
 */
function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= mul(poly[j], EXP[i]);
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  return poly.reverse();
}

function rsEncode(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const res = new Array(ecLen).fill(0);
  for (const byte of data) {
    const factor = byte ^ res[0];
    res.shift();
    res.push(0);
    for (let i = 0; i < ecLen; i += 1) res[i] ^= mul(gen[i + 1], factor);
  }
  return res;
}

/* ------------------------------ version data ----------------------------- */

// [ecCodewordsPerBlock, group1Blocks, group1DataCodewords, group2Blocks, group2DataCodewords]
const EC_M = {
  1:  [10, 1, 16, 0, 0],
  2:  [16, 1, 28, 0, 0],
  3:  [26, 1, 44, 0, 0],
  4:  [18, 2, 32, 0, 0],
  5:  [24, 2, 43, 0, 0],
  6:  [16, 4, 27, 0, 0],
  7:  [18, 4, 31, 0, 0],
  8:  [22, 2, 38, 2, 39],
  9:  [22, 3, 36, 2, 37],
  10: [26, 4, 43, 1, 44],
};

const ALIGNMENT = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

const dataCodewords = (v) => {
  const [, g1b, g1d, g2b, g2d] = EC_M[v];
  return g1b * g1d + g2b * g2d;
};

const countBits = (v) => (v < 10 ? 8 : 16);
const byteCapacity = (v) => Math.floor((dataCodewords(v) * 8 - 4 - countBits(v)) / 8);

function pickVersion(len) {
  for (let v = 1; v <= 10; v += 1) if (byteCapacity(v) >= len) return v;
  throw new Error(`Text too long for this QR encoder (${len} bytes, max ${byteCapacity(10)})`);
}

/* -------------------------------- encoding ------------------------------- */

function buildCodewords(bytes, version) {
  const bits = [];
  const push = (value, n) => {
    for (let i = n - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
  };

  push(0b0100, 4);                       // byte mode
  push(bytes.length, countBits(version));
  for (const b of bytes) push(b, 8);

  const total = dataCodewords(version) * 8;
  push(0, Math.min(4, total - bits.length));       // terminator
  while (bits.length % 8) bits.push(0);            // pad to a byte boundary

  const words = [];
  for (let i = 0; i < bits.length; i += 8) {
    words.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  }
  const pads = [0xec, 0x11];
  let p = 0;
  while (words.length < dataCodewords(version)) { words.push(pads[p % 2]); p += 1; }

  // Split into blocks, compute EC per block, then interleave.
  const [ecLen, g1b, g1d, g2b, g2d] = EC_M[version];
  const blocks = [];
  let at = 0;
  for (let i = 0; i < g1b; i += 1) { blocks.push(words.slice(at, at + g1d)); at += g1d; }
  for (let i = 0; i < g2b; i += 1) { blocks.push(words.slice(at, at + g2d)); at += g2d; }
  const ecBlocks = blocks.map((b) => rsEncode(b, ecLen));

  const out = [];
  const maxData = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < maxData; i += 1) {
    for (const b of blocks) if (i < b.length) out.push(b[i]);
  }
  for (let i = 0; i < ecLen; i += 1) {
    for (const b of ecBlocks) out.push(b[i]);
  }
  return out;
}

/* --------------------------------- matrix -------------------------------- */

function bch(value, generator, bitLen) {
  let v = value << (bitLen - 1);
  const genBits = 32 - Math.clz32(generator);
  while (32 - Math.clz32(v) >= genBits) {
    v ^= generator << (32 - Math.clz32(v) - genBits);
  }
  return v;
}

const FORMAT_MASK = 0x5412;

function place(version, codewords, mask) {
  const size = version * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(null));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

  const setF = (r, c, v) => { m[r][c] = v; reserved[r][c] = true; };

  // Finder patterns + separators
  const finder = (R, C) => {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const rr = R + r; const cc = C + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const on = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                   (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
                   (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        setF(rr, cc, on ? 1 : 0);
      }
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i += 1) {
    setF(6, i, i % 2 === 0 ? 1 : 0);
    setF(i, 6, i % 2 === 0 ? 1 : 0);
  }

  // Alignment patterns
  const centers = ALIGNMENT[version];
  for (const r of centers) {
    for (const c of centers) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          const on = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          setF(r + dr, c + dc, on ? 1 : 0);
        }
      }
    }
  }

  setF(size - 8, 8, 1); // dark module

  // Reserve format areas
  for (let i = 0; i < 9; i += 1) {
    if (m[8][i] === null) setF(8, i, 0);
    if (m[i][8] === null) setF(i, 8, 0);
  }
  for (let i = 0; i < 8; i += 1) {
    if (m[8][size - 1 - i] === null) setF(8, size - 1 - i, 0);
    if (m[size - 1 - i][8] === null) setF(size - 1 - i, 8, 0);
  }

  // Version information (version 7 and up)
  if (version >= 7) {
    const vinfo = (version << 12) | bch(version, 0x1f25, 13);
    for (let i = 0; i < 18; i += 1) {
      const bit = (vinfo >> i) & 1;
      const r = Math.floor(i / 3);
      const c = size - 11 + (i % 3);
      setF(r, c, bit); setF(c, r, bit);
    }
  }

  // Data placement: two-column zigzag, upward then downward, skipping column 6
  const bitsOf = [];
  for (const w of codewords) for (let i = 7; i >= 0; i -= 1) bitsOf.push((w >> i) & 1);

  let idx = 0;
  let up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    for (let i = 0; i < size; i += 1) {
      const row = up ? size - 1 - i : i;
      for (let k = 0; k < 2; k += 1) {
        const c = col - k;
        if (reserved[row][c]) continue;
        let bit = idx < bitsOf.length ? bitsOf[idx] : 0;
        idx += 1;
        if (maskAt(mask, row, c)) bit ^= 1;
        m[row][c] = bit;
      }
    }
    up = !up;
  }

  // Format information: level M is 00, then the 3 mask bits, then 10 BCH bits,
  // the whole thing XOR-ed with 0x5412. Both copies are written LSB-first.
  const fmt = ((0b00 << 3) | mask);
  const fbits = ((fmt << 10) | bch(fmt, 0x537, 11)) ^ FORMAT_MASK;

  // Both copies run MSB-first: the j-th module of each copy carries bit 14-j.
  for (let j = 0; j <= 5; j += 1) setF(8, j, (fbits >> (14 - j)) & 1);
  setF(8, 7, (fbits >> 8) & 1);
  setF(8, 8, (fbits >> 7) & 1);
  setF(7, 8, (fbits >> 6) & 1);
  for (let j = 9; j <= 14; j += 1) setF(14 - j, 8, (fbits >> (14 - j)) & 1);

  for (let j = 0; j <= 7; j += 1) setF(size - 1 - j, 8, (fbits >> (14 - j)) & 1);
  for (let j = 8; j <= 14; j += 1) setF(8, size - 15 + j, (fbits >> (14 - j)) & 1);

  return m;
}

function maskAt(mask, r, c) {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return ((((r + c) % 2) + ((r * c) % 3)) % 2) === 0;
  }
}

function penalty(m) {
  const n = m.length;
  let score = 0;

  // Rule 1: runs of five or more
  const runs = (get) => {
    for (let a = 0; a < n; a += 1) {
      let run = 1;
      for (let b = 1; b < n; b += 1) {
        if (get(a, b) === get(a, b - 1)) run += 1;
        else { if (run >= 5) score += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  };
  runs((a, b) => m[a][b]);
  runs((a, b) => m[b][a]);

  // Rule 2: 2x2 blocks
  for (let r = 0; r < n - 1; r += 1) {
    for (let c = 0; c < n - 1; c += 1) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }

  // Rule 3: finder-like patterns
  const P1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const P2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const match = (arr, p) => p.every((v, i) => arr[i] === v);
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c <= n - 11; c += 1) {
      const row = m[r].slice(c, c + 11);
      if (match(row, P1) || match(row, P2)) score += 40;
      const col = [];
      for (let k = 0; k < 11; k += 1) col.push(m[c + k][r]);
      if (match(col, P1) || match(col, P2)) score += 40;
    }
  }

  // Rule 4: dark/light balance
  let dark = 0;
  for (const row of m) for (const v of row) dark += v;
  const pct = (dark * 100) / (n * n);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;

  return score;
}

/** @returns {number[][]} matrix of 0/1, one entry per module */
export function qrMatrix(text, forceMask = null) {
  const bytes = Array.from(Buffer.from(String(text), 'utf8'));
  const version = pickVersion(bytes.length);
  const codewords = buildCodewords(bytes, version);

  let best = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask += 1) {
    if (forceMask !== null && mask !== forceMask) continue;
    // Mask 2 (every third column dark) stripes the whole symbol vertically.
    // It often wins on the ISO penalty rules, yet several real detectors -
    // OpenCV's among them - then fail to find the finder patterns at all.
    // Every mask is a valid encoding, so skipping this one costs nothing but
    // makes the code scannable by more phones. Still reachable via forceMask.
    if (mask === 2 && forceMask === null) continue;
    const m = place(version, codewords, mask);
    const s = penalty(m);
    if (s < bestScore) { bestScore = s; best = m; }
  }
  return best;
}

/** Renders the matrix as a standalone SVG string. */
export function qrSvg(text, { scale = 6, quiet = 4, dark = '#12161d', light = '#ffffff' } = {}) {
  const m = qrMatrix(text);
  const n = m.length;
  const size = (n + quiet * 2) * scale;

  let path = '';
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) {
      if (m[r][c]) path += `M${(c + quiet) * scale} ${(r + quiet) * scale}h${scale}v${scale}h-${scale}z`;
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
         `viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" ` +
         `aria-label="QR code for ${String(text).replace(/[<>&"]/g, '')}">` +
         `<rect width="${size}" height="${size}" fill="${light}"/>` +
         `<path d="${path}" fill="${dark}"/></svg>`;
}

export default qrSvg;
