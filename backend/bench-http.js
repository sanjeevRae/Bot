/* End-to-end latency of POST /api/chat: cold (first) then warm (repeat) messages. */
const supabaseAdmin = require('./src/lib/supabase');

const BASE = process.env.BENCH_BASE || 'http://localhost:5000';
const now = () => Number(process.hrtime.bigint() / 1000n) / 1000;

(async () => {
  const { data: orgs } = await supabaseAdmin.from('organizations').select('id, name').limit(20);
  let orgId = null;
  for (const o of orgs || []) {
    const { count } = await supabaseAdmin.from('documents').select('id', { count: 'exact', head: true }).eq('organization_id', o.id);
    if (count > 0) { orgId = o.id; console.log('org:', o.name); break; }
  }
  if (!orgId) { console.error('no org with knowledge'); process.exit(1); }

  const s = await fetch(`${BASE}/api/chat/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orgId }),
  });
  const session = await s.json();
  if (!session.sessionId) { console.error('session failed', session); process.exit(1); }

  const ask = async (message) => {
    const t = now();
    const r = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId, sessionId: session.sessionId, sessionToken: session.sessionToken, message }),
    });
    const body = await r.json();
    return { ms: now() - t, status: r.status, body };
  };

  const questions = [
    'What services do you offer?',
    'What services do you offer?',                        // repeat (embedding cache)
    'How much does it cost and what are your hours?',     // new (corpus cache warm)
    'Do you have any offers for new customers?',
    'Can you tell me about your web development work?',
    'What services do you offer?',                        // repeat again
    'How do I contact you?',
    'Do you build mobile apps?',
  ];

  let total = 0;
  for (let i = 0; i < questions.length; i++) {
    const { ms, status, body } = await ask(questions[i]);
    total += ms;
    console.log(`#${i + 1} ${ms.toFixed(0).padStart(6)} ms  status=${status}  sources=${(body.sources || []).length}  reply="${String(body.reply || body.error || '').slice(0, 70).replace(/\n/g, ' ')}"`);
  }
  console.log(`\naverage ${(total / questions.length).toFixed(0)} ms over ${questions.length} messages`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });