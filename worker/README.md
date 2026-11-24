# Optional proxy (Cloudflare Worker)

You only need this for two things:

1. **Fetching official results files by address** (the "Fetch" button under Data source → Official results file). Browsers can't read the Al Kamel results site directly from your GitHub Pages site, so the Worker fetches the file for you.
2. **Direct live connection "via proxy"**, if the Al Kamel live server refuses direct browser connections from your site.

The bridge (Data source → Live — bridge) and dropping a downloaded CSV onto the dashboard need **no** proxy.

## Set up (about 10 minutes, free Cloudflare plan)

1. Install Node.js, then in this folder run `npx wrangler login`.
2. Edit `wrangler.toml`: set `ALLOWED_ORIGIN` to your pit wall site origin, e.g. `https://burressi.github.io` (no trailing slash, no path).
3. Make up a long random access key (30+ characters) and store it: `npx wrangler secret put ACCESS_KEY`.
4. Deploy: `npx wrangler deploy`. Note the address it prints (`https://zenith-strategy-proxy.<you>.workers.dev`).
5. In the dashboard: **Settings → Optional proxy** — paste the address and the access key (saved on that device only).

The Worker only answers requests from your site that carry the key, only fetches Al Kamel hosts, and stores nothing.
