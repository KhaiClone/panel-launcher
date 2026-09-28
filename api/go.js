// ─────────────────────────────────────────────────────────────────────────────
//  Finds where the panel runs right now and sends the browser there.
//
//  Every panel domain answers GET /api/health. The panel itself answers
//  { state: "active", epoch, url }; a VPS the panel has left redirects there
//  (nginx), or — if its copy was retired — answers { state: "fenced", movedTo }.
//  All domains are asked at once; the active panel with the highest epoch wins,
//  the same rule the agents use to follow a move. So a move, or one VPS being
//  down, changes nothing for whoever opens this address.
// ─────────────────────────────────────────────────────────────────────────────

const PANELS = require("../panels.json");

const TIMEOUT_MS = 3500;
const GRACE_MS = 400;
const CACHE_MS = 15_000; // a warm instance reuses its last answer this long

const seeds = () =>
    (process.env.PANEL_DOMAINS ? process.env.PANEL_DOMAINS.split(",") : PANELS)
        .map((d) => String(d).trim())
        .filter(Boolean)
        .map((d) => (/^https?:\/\//.test(d) ? d : `https://${d}`).replace(/\/+$/, ""));

/** "https://host[:port]" of an absolute http(s) URL, else null. */
const originOf = (u) => {
    try {
        const x = new URL(u);
        return x.protocol === "https:" || x.protocol === "http:" ? x.origin : null;
    } catch {
        return null;
    }
};

const probe = async (base) => {
    const started = Date.now();
    try {
        const res = await fetch(`${base}/api/health`, {
            redirect: "follow",
            headers: { accept: "application/json" },
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const body = await res.json();
        return {
            domain: base,
            ms: Date.now() - started,
            state: typeof body.state === "string" ? body.state : null,
            epoch: Number(body.epoch) || 0,
            // A panel too old to send `url`: the address that answered is it.
            url: originOf(body.url) || originOf(res.url),
            movedTo: originOf(body.movedTo),
        };
    } catch (err) {
        return { domain: base, ms: Date.now() - started, error: err.name === "TimeoutError" ? "no answer" : err.message };
    }
};

/**
 * Ask every domain at once. Once one reports an active panel, the others get
 * GRACE_MS more (a VPS that is down should not hold every visit for the full
 * timeout); `complete` waits for all of them (the /__status view).
 */
const askAll = (domains, complete) =>
    new Promise((resolve) => {
        const out = [];
        let left = domains.length;
        let timer = null;
        const done = () => {
            clearTimeout(timer);
            resolve([...out]);
        };
        for (const d of domains) {
            probe(d).then((r) => {
                out.push(r);
                if (--left === 0) return done();
                if (!complete && r.state === "active" && !timer) timer = setTimeout(done, GRACE_MS);
            });
        }
    });

const locate = async (complete = false) => {
    const results = [];
    const asked = new Set();
    let queue = seeds();
    // The seeds first; if none is active, whatever address a retired panel points to.
    for (let round = 0; round < 2 && queue.length; round++) {
        queue.forEach((d) => asked.add(d));
        results.push(...(await askAll(queue, complete)));
        if (results.some((r) => r.state === "active")) break;
        queue = [...new Set(results.map((r) => r.movedTo).filter((u) => u && !asked.has(u)))];
    }
    const best = results.filter((r) => r.state === "active" && r.url).sort((a, b) => b.epoch - a.epoch)[0];
    return { target: best?.url || null, epoch: best?.epoch ?? null, results, checkedAt: new Date().toISOString() };
};

let cached = null;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const downPage = (found) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="15"><title>Panel unreachable</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--text:#1d2330;--muted:#667085;--bad:#c2410c}
@media (prefers-color-scheme:dark){:root{--bg:#0f1218;--card:#171b23;--text:#e6e8ee;--muted:#8a93a6;--bad:#fb923c}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,sans-serif;padding:16px;box-sizing:border-box}
main{max-width:520px;width:100%;background:var(--card);border-radius:12px;padding:24px}
h1{font-size:18px;margin:0 0 6px}p{margin:0 0 16px;color:var(--muted)}
li{margin:6px 0;overflow-wrap:anywhere}span{color:var(--bad)}a{color:inherit}
</style></head><body><main>
<h1>No panel is answering right now</h1>
<p>Every known address was asked; none reported an active panel. This page retries every 15 seconds.</p>
<ul>${found.results
    .map((r) => `<li><a href="${esc(r.domain)}">${esc(r.domain.replace(/^https?:\/\//, ""))}</a> — <span>${esc(r.error || r.state || "unknown")}</span></li>`)
    .join("")}</ul>
</main></body></html>`;

module.exports = async (req, res) => {
    const u = new URL(req.url, "http://launcher");
    const status = u.pathname === "/__status";
    const fresh = status || u.searchParams.has("fresh");
    u.searchParams.delete("fresh");

    let found = !fresh && cached && Date.now() - cached.at < CACHE_MS ? cached.found : null;
    if (!found) {
        found = await locate(status);
        cached = found.target ? { at: Date.now(), found } : null;
    }

    res.setHeader("cache-control", "no-store");
    if (status) {
        res.statusCode = found.target ? 200 : 503;
        res.setHeader("content-type", "application/json; charset=utf-8");
        return res.end(JSON.stringify(found, null, 2));
    }
    if (found.target) {
        res.statusCode = 302;
        res.setHeader("location", found.target + u.pathname + u.search);
        return res.end();
    }
    res.statusCode = 503;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(downPage(found));
};
