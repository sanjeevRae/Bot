const { createClient } = require('@supabase/supabase-js');
const config = require('../config');

// Node <22 has no native WebSocket; provide `ws` for the realtime client.
// (We only use REST queries, but the client initializes realtime eagerly.)
let ws;
try { ws = require('ws'); } catch { /* optional */ }

// Service-role client — bypasses RLS, used ONLY on the trusted backend.
// Tenant isolation is enforced in code by always filtering on organization_id.
const supabaseAdmin = createClient(
  config.supabase.url,
  config.supabase.serviceRoleKey,
  {
    auth: { autoRefreshToken: false, persistSession: false },
    ...(ws ? { realtime: { transport: ws } } : {}),
  }
);

module.exports = supabaseAdmin;
