# panel-launcher

One address for the bot panel, wherever it runs.

The panel can move between VPS, and every VPS has its own panel domain. This
tiny Vercel function asks all of them `GET /api/health` at once and redirects
the browser to the active panel with the highest epoch — path and query kept,
so bookmarks like `/bots/<id>` keep working.

- `panels.json` — the domains to ask (or set `PANEL_DOMAINS=a.com,b.com` in Vercel).
  Add a new VPS domain here once it is added under Panel → Custom Domains.
- `/__status` — what every domain answered, as JSON (always asks again).
- `?fresh` — skip the 15-second cache of a warm instance.
- If no panel answers, a page lists every domain and retries every 15 s.

Deploy: import this repo in Vercel (framework preset "Other", no build
command), then add the launcher's domain under Settings → Domains.

Test: `node test.js` (stand-in panels on localhost); `LIVE=1 node test.js`
also asks the real domains.
