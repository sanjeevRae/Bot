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
  const cronPing = config.keepAlive.cronPingUrl;
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

  // External cron pinger (e.g. cron-job.org / UptimeRobot). Render free
  // instances that sleep need an OUTSIDE request to wake them — a self-ping
  // can't do that. Set KEEP_ALIVE_CRON_URL to the *external* service's ping
  // URL and we'll trigger it on each cycle (the external service then hits
  // our /health, waking a sleeping instance).
  if (cronPing) {
    const wake = async () => {
      try {
        const res = await fetch(cronPing, { signal: AbortSignal.timeout(10000) });
        console.log(`[KeepAlive] external wake ${cronPing} -> ${res.status}`);
      } catch (e) {
        console.warn(`[KeepAlive] external wake failed: ${e.message}`);
      }
    };
    setTimeout(wake, 60_000);
    setInterval(wake, config.keepAlive.intervalMs);
    console.log(`[KeepAlive] external wake ${cronPing} every ${Math.round(config.keepAlive.intervalMs / 60000)} min`);
  }
}

module.exports = { startKeepAlive };
