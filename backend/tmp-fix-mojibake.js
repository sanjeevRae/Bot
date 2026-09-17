// One-off mojibake repair for stored data. Usage:
//   node tmp-fix-mojibake.js            (dry run)
//   node tmp-fix-mojibake.js --apply    (write changes)
const s = require('./src/lib/supabase');
const { fixMojibake } = require('./src/lib/textNormalize');

const APPLY = process.argv.includes('--apply');
const TABLES = ['organizations', 'documents', 'document_sections', 'leads', 'bookings', 'chat_history', 'settings', 'profiles', 'payments', 'api_keys', 'whatsapp_connections', 'usage_events'];
const PAGE = 500;

function keyOf(row) {
  if (row.id !== undefined) return 'id';
  if (row.organization_id !== undefined) return 'organization_id';
  if (row.user_id !== undefined) return 'user_id';
  if (row.org_id !== undefined) return 'org_id';
  return null;
}

(async () => {
  let grandTotal = 0, grandRows = 0;
  for (const t of TABLES) {
    let from = 0, rows = 0, fixedRows = 0, fields = 0;
    const samples = [];
    for (;;) {
      const { data, error } = await s.from(t).select('*').range(from, from + PAGE - 1);
      if (error) { console.log(t.padEnd(22) + ' ERROR: ' + error.message); break; }
      if (!data || data.length === 0) break;
      rows += data.length;
      for (const row of data) {
        const patch = {};
        for (const [k, v] of Object.entries(row)) {
          if (typeof v !== 'string' || v.length === 0) continue;
          const fixed = fixMojibake(v);
          if (fixed !== v) { patch[k] = fixed; fields++; if (samples.length < 3) samples.push([k, v, fixed]); }
        }
        if (Object.keys(patch).length === 0) continue;
        fixedRows++;
        const k = keyOf(row);
        if (APPLY) {
          if (!k) { console.log('  !! no key column for ' + t + ', skipping row'); continue; }
          const { error: upErr } = await s.from(t).update(patch).eq(k, row[k]);
          if (upErr) { console.log('  update error ' + t + '.' + k + '=' + row[k] + ': ' + upErr.message); fixedRows--; }
        }
      }
      if (data.length < PAGE) break;
      from += PAGE;
    }
    grandRows += rows; grandTotal += fields;
    console.log(t.padEnd(22) + ' ' + String(rows).padStart(5) + ' rows, ' + String(fixedRows).padStart(4) + ' row(s) needing repair, ' + fields + ' field(s)' + (APPLY ? ' [APPLIED]' : ' [dry-run]'));
    for (const [k, before, after] of samples) {
      const i = [...before].findIndex(ch => ch.codePointAt(0) > 0xff || ch.codePointAt(0) >= 0x80);
      const a = before.slice(Math.max(0, i - 25), i + 25);
      const j = [...after].findIndex(ch => ch.codePointAt(0) > 0x7f);
      const b2 = after.slice(Math.max(0, j - 25), j + 25);
      console.log('    .' + k + '  BEFORE ' + JSON.stringify(a));
      console.log('    .' + k + '  AFTER  ' + JSON.stringify(b2));
    }
  }
  console.log('\n=== ' + grandRows + ' rows scanned, ' + grandTotal + ' field(s) ' + (APPLY ? 'repaired' : 'would be repaired') + ' ===');
})();