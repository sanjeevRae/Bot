/* Times each phase of a chat turn to find the real bottleneck. */
const supabaseAdmin = require('./src/lib/supabase');
const { retrieveContext } = require('./src/services/rag');
const { embedText, embedBatch } = require('./src/services/embeddings');
const { buildSystemPrompt, getToolSchemas, runChatTurn } = require('./src/services/groq');
const config = require('./src/config');

const now = () => Number(process.hrtime.bigint() / 1000n) / 1000; // ms
const time = async (label, fn) => {
  const t = now();
  try {
    const out = await fn();
    console.log(`${label.padEnd(34)} ${(now() - t).toFixed(0).padStart(6)} ms`);
    return out;
  } catch (e) {
    console.log(`${label.padEnd(34)} FAILED (${(now() - t).toFixed(0)} ms): ${e.message}`);
    return null;
  }
};

(async () => {
  console.log('HF token configured :', !!config.embeddings.hfToken);
  console.log('HF model            :', config.embeddings.hfModel);
  console.log('MAX_CONTEXT_CHARS   :', process.env.MAX_CONTEXT_CHARS || '12000 (default)');
  console.log('rag.topK            :', config.rag.topK);
  console.log('');

  // Pick a real org that actually has knowledge
  const { data: orgs } = await supabaseAdmin.from('organizations').select('id, name').limit(20);
  let target = null;
  for (const o of orgs || []) {
    const { count } = await supabaseAdmin.from('documents').select('id', { count: 'exact', head: true }).eq('organization_id', o.id);
    const { count: secs } = await supabaseAdmin.from('document_sections').select('id', { count: 'exact', head: true }).eq('organization_id', o.id);
    if ((count || 0) > 0) { target = { ...o, docs: count, sections: secs }; break; }
  }
  if (!target) { console.error('No org with documents found — cannot benchmark retrieval.'); process.exit(1); }
  console.log(`Org: ${target.name} (${target.docs} docs, ${target.sections} chunks)\n`);

  const q = 'What time do you open on Saturday and how much is a haircut?';

  await time('embedText (HF, 1 query)', () => embedText(q));
  await time('embedText again', () => embedText(q));
  await time('embedBatch (5 chunks)', () => embedBatch(['a', 'b', 'c', 'd', 'e'].map((x) => `${x} sample chunk text for embedding latency test`)));
  const chunks = await time('retrieveContext (embed+rpc)', () => retrieveContext(target.id, q));
  console.log('   -> chunks returned:', chunks ? chunks.length : 0);
  await time('retrieveContext again', () => retrieveContext(target.id, q));

  const { data: settings } = await supabaseAdmin.from('settings').select('*').eq('organization_id', target.id).maybeSingle();
  const { data: org } = await supabaseAdmin.from('organizations').select('id, name, industry').eq('id', target.id).single();

  const sys = buildSystemPrompt(org, settings, chunks || [], 'web');
  console.log('\nsystem prompt chars :', sys.length, '(~' + Math.round(sys.length / 4) + ' tokens)');

  const messages = [{ role: 'system', content: sys }, { role: 'user', content: q }];
  await time('LLM turn (no tools path)', () => runChatTurn({ messages, tools: getToolSchemas(), executeTool: async () => ({ ok: true }) }));
  await time('LLM turn again', () => runChatTurn({ messages, tools: getToolSchemas(), executeTool: async () => ({ ok: true }) }));

  // DB round-trip costs on the critical path
  await time('chat_history select', () => supabaseAdmin.from('chat_history').select('role, message').eq('organization_id', target.id).eq('session_id', 'x').order('created_at', { ascending: false }).limit(10));
  await time('usage_events count', () => supabaseAdmin.from('usage_events').select('id', { count: 'exact', head: true }).eq('organization_id', target.id).eq('event_type', 'message'));
  await time('organizations select', () => supabaseAdmin.from('organizations').select('id, name, industry').eq('id', target.id).single());
  await time('settings select', () => supabaseAdmin.from('settings').select('*').eq('organization_id', target.id).maybeSingle());
  console.log('\nSupabase URL host:', (config.supabase.url || '').replace(/https:\/\/([^.]+).*/, '$1'));
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });