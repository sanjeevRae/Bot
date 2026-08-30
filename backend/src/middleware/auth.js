const { createClient } = require('@supabase/supabase-js');
const config = require('../config');

let ws;
try { ws = require('ws'); } catch { /* optional */ }

// Cache the anon client — creating one per request added 1.5-3s of latency
let cachedAnonClient = null;
function anonClient() {
  if (cachedAnonClient) return cachedAnonClient;
  cachedAnonClient = createClient(config.supabase.url, config.supabase.anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    ...(ws ? { realtime: { transport: ws } } : {}),
  });
  return cachedAnonClient;
}

/**
 * Auth middleware — verifies the Supabase JWT from the
 * `Authorization: Bearer <token>` header and attaches:
 *   req.user  -> { id, email }
 *   req.orgId -> organization_id of the user (tenant isolation)
 */
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      return res.status(401).json({ error: 'Missing authorization token' });
    }

    // Verify token against Supabase using an anon client
    const anon = anonClient();
    const { data, error } = await anon.auth.getUser(token);
    if (error || !data?.user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    req.user = { id: data.user.id, email: data.user.email };

    // Resolve tenant org + role for this user
    const supabaseAdmin = require('../lib/supabase');
    const { data: profile, error: pErr } = await supabaseAdmin
      .from('profiles')
      .select('organization_id, role')
      .eq('id', data.user.id)
      .single();

    if (pErr || !profile?.organization_id) {
      return res.status(403).json({ error: 'No organization found for user' });
    }
    req.orgId = profile.organization_id;
    req.role = profile.role || 'owner';

    next();
  } catch (err) {
    console.error('Auth middleware error:', err.message);
    res.status(401).json({ error: 'Authentication failed' });
  }
}

module.exports = { requireAuth };
