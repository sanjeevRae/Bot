const config = require('../config');

/**
 * Keep-alive: pings this server's own /health endpoint periodically so
 * Render's free tier doesn't spin the instance down after 15 min idle.
 *
 * - Uses PUBLIC_BACKEND_URL (or Render's auto-injected RENDER_EXTERNAL_URL)
 * - Only runs in production by default (set KEEP_ALIVE=true to force locally)
 * - Also optionally pings an external cron URL (e.g. cron-job.org) if provided
 */
function startKeepAlive() {
  const url = config.keepAlive.selfUrl;
  const enabled = config.keepAlive.enabled && (config.env === 'production' || process.env.KEEP_ALIVE === 'true');

  if (!enabled) {
    console.log('[KeepAlive] disabled');
    return;
  }
  if (!url) {
    console.warn('[KeepAlive] enabled but no PUBLIC_BACKEND_URL/RENDER_EXTERNAL_URL set — skipping');
    return;
  }

  const ping = async () => {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(10000) });
      console.log(`[KeepAlive] ping ${url}/health -> ${res.status}`);
    } catch (e) {
      console.warn(`[KeepAlive] ping failed: ${e.message}`);
    }
  };

  // First ping shortly after boot, then on interval
  setTimeout(ping, 30_000);
  setInterval(ping, config.keepAlive.intervalMs);
  console.log(`[KeepAlive] pinging ${url}/health every ${Math.round(config.keepAlive.intervalMs / 60000)} min`);
}

module.exports = { startKeepAlive };
