import config from './config.js';

/**
 * Backend-authoritative pricing (report section 7).
 *   single : P x rate x C
 *   duplex : ceil(P / 2) x rate x C
 * The client never sends a price; it is always recomputed from the stored page count.
 */
export function priceOrder({ pageCount, copies = 1, duplex = false, colourMode = 'bw' }) {
  const pages = Number(pageCount);
  const c = Number(copies);

  if (!Number.isInteger(pages) || pages < 1) throw new Error('pageCount must be a positive integer');
  if (!Number.isInteger(c) || c < 1 || c > 50) throw new Error('copies must be an integer between 1 and 50');
  if (!['bw', 'colour'].includes(colourMode)) throw new Error("colourMode must be 'bw' or 'colour'");

  const isDuplex = Boolean(duplex);
  const rate = config.rates[colourMode][isDuplex ? 'duplex' : 'single'];
  const sheetsPerCopy = isDuplex ? Math.ceil(pages / 2) : pages;
  const totalSheets = sheetsPerCopy * c;

  return {
    pages,
    copies: c,
    duplex: isDuplex,
    colourMode,
    rate,
    sheetsPerCopy,
    totalSheets,
    amount: totalSheets * rate,
  };
}

export default priceOrder;
