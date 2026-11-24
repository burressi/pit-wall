/**
 * Zenith Strategy — optional private proxy (Cloudflare Worker, free plan is enough).
 *
 * Why: browsers cannot read the Al Kamel results files directly from your GitHub Pages site
 * (no CORS headers, and the results site is plain http). This Worker fetches them for you.
 * It also offers a WebSocket relay to the Al Kamel live timing server in case that server
 * refuses direct browser connections from your site.
 *
 * Locked down: only your site's origin, only requests carrying your access key, and only
 * Al Kamel hosts. Nothing is cached or stored.
 *
 * Settings (wrangler.toml [vars] + secret):
 *   ALLOWED_ORIGIN = "https://<you>.github.io"      (your pit wall site origin, no trailing slash)
 *   ACCESS_KEY     = secret (wrangler secret put ACCESS_KEY) — paste the same value in the dashboard Settings
 */
const HOSTS = /^([a-z0-9-]+\.)*(alkamelsystems\.com|alkamelcloud\.com|alkamelna\.com)$/i;

function cors(env, extra) {
  return Object.assign({
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '',
    'Access-Control-Allow-Headers': 'X-Access-Key',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Cache-Control': 'no-store',
    'Vary': 'Origin'
  }, extra || {});
}
function deny(env, code, msg) { return new Response(msg, { status: code, headers: cors(env, { 'Content-Type': 'text/plain' }) }); }
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors(env) });
    const origin = req.headers.get('Origin');
    if (env.ALLOWED_ORIGIN && origin && origin !== env.ALLOWED_ORIGIN) return deny(env, 403, 'origin not allowed');
    const key = req.headers.get('X-Access-Key') || url.searchParams.get('key') || '';
    if (!env.ACCESS_KEY || !timingSafeEqual(key, env.ACCESS_KEY)) return deny(env, 401, 'bad access key');

    let target;
    try { target = new URL(url.searchParams.get('url') || ''); } catch (e) { return deny(env, 400, 'bad url'); }
    if (!HOSTS.test(target.hostname)) return deny(env, 403, 'host not allowed');

    if (url.pathname === '/fetch') {
      const up = await fetch(target.toString(), { headers: { 'User-Agent': 'Mozilla/5.0 (Zenith Strategy proxy)' }, cf: { cacheTtl: 0 } });
      const body = await up.arrayBuffer();
      return new Response(body, { status: up.status, headers: cors(env, { 'Content-Type': up.headers.get('Content-Type') || 'text/plain' }) });
    }

    if (url.pathname === '/ws') {
      if (req.headers.get('Upgrade') !== 'websocket') return deny(env, 426, 'expected websocket');
      target.protocol = target.protocol === 'ws:' ? 'http:' : 'https:';
      const up = await fetch(target.toString(), { headers: { Upgrade: 'websocket', Origin: 'https://' + target.hostname } });
      const server = up.webSocket;
      if (!server) return deny(env, 502, 'upstream refused websocket');
      server.accept();
      const pair = new WebSocketPair();
      const client = pair[1];
      client.accept();
      client.addEventListener('message', e => { try { server.send(e.data); } catch (x) { /* closed */ } });
      server.addEventListener('message', e => { try { client.send(e.data); } catch (x) { /* closed */ } });
      const closeBoth = () => { try { client.close(); } catch (x) {} try { server.close(); } catch (x) {} };
      client.addEventListener('close', closeBoth); server.addEventListener('close', closeBoth);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return deny(env, 404, 'not found');
  }
};
