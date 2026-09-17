/**
 * Text normalisation helpers.
 *
 * fixMojibake() repairs the classic "UTF-8 bytes decoded as Windows-1252"
 * corruption (sequences like the ones produced by many regional e-commerce
 * sites and copy/paste from legacy tools) so the dashboard, knowledge base,
 * bot answers and emails always show real characters instead of garbled ones.
 *
 * How it works: the string is split into runs of characters that could have
 * come from CP1252. Each run is reverse-mapped to bytes and re-decoded as
 * UTF-8. A run is only replaced when the reverse mapping is exact AND the bytes
 * are valid UTF-8, so:
 *   - genuine Unicode (Devanagari, emoji, CJK, real accented Latin) is never
 *     touched, because those characters are not CP1252-representable and
 *     therefore act as boundaries between runs;
 *   - mixed content is handled correctly - mojibake inside a sentence that also
 *     contains real Unicode still gets repaired;
 *   - text that merely looks unusual (e.g. "cafe" with a real e-acute) is left
 *     alone, since its bytes are not valid UTF-8 and the run is kept as-is.
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

// Cheap gate: only strings containing one of these can possibly be mojibake.
const SUSPECT = /[\u0080-\u00ff\u0152\u0153\u0160\u0161\u0178\u017d\u017e\u0192\u02c6\u02dc\u2013\u2014\u2018\u2019\u201a\u201c\u201d\u201e\u2020\u2021\u2022\u2026\u2030\u2039\u203a\u2122]/;

const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true });

/** True when the character can be represented as a single CP1252 byte. */
function isCp1252(cp) {
  return cp <= 0xff || CP1252_REVERSE[cp] !== undefined;
}

/** Repair every CP1252-encoded run in `str`. Returns { out, changed }. */
function repairRuns(str) {
  let out = '';
  let changed = false;
  const n = str.length;
  let i = 0;

  while (i < n) {
    let j = i;
    let hasHigh = false;
    while (j < n) {
      const cp = str.charCodeAt(j);
      if (cp <= 0x7f) { j++; continue; }
      if (isCp1252(cp)) { hasHigh = true; j++; continue; }
      break; // genuine Unicode -> run boundary
    }

    if (j === i) { out += str[i]; i++; continue; } // non-representable char

    const run = str.slice(i, j);
    i = j;

    if (!hasHigh) { out += run; continue; } // pure ASCII -> nothing to fix

    const bytes = Buffer.allocUnsafe(run.length);
    for (let k = 0; k < run.length; k++) {
      const cp = run.charCodeAt(k);
      bytes[k] = cp <= 0xff ? cp : CP1252_REVERSE[cp];
    }

    let decoded = null;
    try { decoded = UTF8_FATAL.decode(bytes); } catch { decoded = null; }

    if (decoded !== null && decoded !== run) { out += decoded; changed = true; }
    else out += run;
  }

  return { out, changed };
}

/**
 * Repair mojibake in a single string. Non-strings and clean text are returned
 * unchanged. Double-encoded text is handled by applying up to `maxPasses` rounds.
 */
function fixMojibake(input, maxPasses = 3) {
  if (typeof input !== 'string' || input.length === 0) return input;
  if (!SUSPECT.test(input)) return input;
  let out = input;
  for (let pass = 0; pass < maxPasses; pass++) {
    const { out: next, changed } = repairRuns(out);
    if (!changed) break;
    out = next;
  }
  return out;
}

/** Convenience: true when fixMojibake would change the string. */
function hasMojibake(input) {
  return fixMojibake(input) !== input;
}

module.exports = { fixMojibake, hasMojibake };