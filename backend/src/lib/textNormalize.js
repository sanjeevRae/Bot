/**
 * Text normalisation helpers.
 *
 * fixMojibake() repairs the classic "UTF-8 bytes decoded as Windows-1252"
 * corruption (a-tilde-euro-tm style sequences like the ones produced by many
 * regional e-commerce sites) so the dashboard, knowledge base, bot answers and
 * emails always show the real characters instead of garbled symbols.
 *
 * Safety guarantee: the repair only applies when EVERY character of the input
 * is representable in CP1252 AND the resulting byte sequence is valid UTF-8.
 * Text containing Devanagari, emoji, CJK or other genuine Unicode can never be
 * altered by this function, so Nepali/emoji content is always left untouched.
 */

// CP1252 specials: Unicode code point -> original byte value (0x80..0x9F range).
const CP1252_REVERSE = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f,
};

// Cheap gate: only strings containing these characters can possibly be mojibake.
const SUSPECT = /[\u0080-\u00ff\u0152\u0153\u0160\u0161\u0178\u017d\u017e\u0192\u02c6\u02dc\u2013\u2014\u2018\u2019\u201a\u201c\u201d\u201e\u2020\u2021\u2022\u2026\u2030\u2039\u203a\u2122]/;

const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true });

/** One reverse-CP1252 -> UTF-8 pass. Returns null when the string is not pure mojibake. */
function decodeOnce(str) {
  const bytes = Buffer.allocUnsafe(str.length);
  for (let i = 0; i < str.length; i++) {
    const cp = str.charCodeAt(i);
    if (cp <= 0xff) {
      bytes[i] = cp; // ASCII + Latin-1 pass straight through
      continue;
    }
    const b = CP1252_REVERSE[cp];
    if (b === undefined) return null; // genuine Unicode -> never rewrite
    bytes[i] = b;
  }
  try {
    return UTF8_FATAL.decode(bytes);
  } catch {
    return null; // not valid UTF-8 -> original text was fine
  }
}

/**
 * Repair mojibake in a single string. Non-strings and clean text are returned
 * unchanged. Handles double-encoded text by applying up to `maxPasses` rounds.
 */
function fixMojibake(input, maxPasses = 2) {
  if (typeof input !== 'string' || input.length === 0) return input;
  if (!SUSPECT.test(input)) return input;
  let out = input;
  for (let pass = 0; pass < maxPasses; pass++) {
    const next = decodeOnce(out);
    if (next === null || next === out) break;
    out = next;
  }
  return out;
}

module.exports = { fixMojibake };