#!/usr/bin/env node
/**
 * Checks for api/go.js against stand-in panels on localhost.
 * Run:  node test.js            (add LIVE=1 to also ask the real domains)
 */
const http = require("http");
const assert = require("assert");

let failures = 0;
const test = async (name, fn) => {
    try {
        await fn();
        console.log(`  ok  ${name}`);
    } catch (err) {
        failures++;
        console.error(`  FAIL ${name}\n       ${err.stack || err.message}`);
    }
};

/** A stand-in panel domain: `answer(self)` → { status, body } | { redirect } | "hang". */
const panel = async (answer) => {
    const srv = http.createServer((req, res) => {
        const a = answer(srv.url);
        if (a === "hang") return; // never answers
        if (a.redirect) {
            res.writeHead(302, { location: a.redirect + req.url });
            return res.end();
        }
        res.writeHead(a.status || 200, { "content-type": "application/json" });
        res.end(JSON.stringify(a.body));
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    srv.url = `http://127.0.0.1:${srv.address().port}`;
    return srv;
};
const deadUrl = "http://127.0.0.1:9"; // nothing listens there

/** Call the handler like Vercel would; returns { status, headers, body, ms }. */
const call = async (path, domains) => {
    process.env.PANEL_DOMAINS = domains.join(",");
    const handler = require("./api/go");
    const started = Date.now();
    return new Promise((resolve) => {
        const headers = {};
        const res = {
            statusCode: 200,
            setHeader: (k, v) => (headers[k.toLowerCase()] = v),
            end: (body) => resolve({ status: res.statusCode, headers, body, ms: Date.now() - started }),
        };
        handler({ url: path }, res);
    });
};

(async () => {
    const active = await panel((self) => ({ body: { ok: true, state: "active", epoch: 2, url: "https://panel1.example.com" } }));
    const redirecting = await panel(() => ({ redirect: active.url }));
    const retired = await panel(() => ({ body: { ok: false, state: "fenced", epoch: 1, movedTo: "https://panel1.example.com" } }));
    const hanging = await panel(() => "hang");

    await test("a redirecting domain, the panel and a dead VPS → the panel's url, path and query kept", async () => {
        const r = await call("/bots/abc?tab=logs&fresh", [redirecting.url, active.url, deadUrl]);
        assert.strictEqual(r.status, 302);
        assert.strictEqual(r.headers.location, "https://panel1.example.com/bots/abc?tab=logs");
        assert.strictEqual(r.headers["cache-control"], "no-store");
    });

    await test("a retired copy is never chosen", async () => {
        const r = await call("/?fresh", [retired.url, active.url]);
        assert.strictEqual(r.headers.location, "https://panel1.example.com/");
    });

    await test("two active answers (mid-move): the higher epoch wins", async () => {
        const older = await panel(() => ({ body: { state: "active", epoch: 1, url: "https://old.example.com" } }));
        const r = await call("/?fresh", [older.url, active.url]);
        assert.strictEqual(r.headers.location, "https://panel1.example.com/");
        older.close();
    });

    await test("no seed active: a retired copy's movedTo is asked next", async () => {
        const moved = await panel(() => ({ body: { state: "active", epoch: 3, url: "https://panel9.example.com" } }));
        const pointer = await panel(() => ({ body: { state: "fenced", epoch: 2, movedTo: moved.url } }));
        const r = await call("/?fresh", [pointer.url, deadUrl]);
        assert.strictEqual(r.headers.location, "https://panel9.example.com/");
        moved.close();
        pointer.close();
    });

    await test("a panel without `url` (older code): the address that answered is used", async () => {
        const old = await panel(() => ({ body: { state: "active", epoch: 1 } }));
        const r = await call("/x?fresh", [old.url]);
        assert.strictEqual(r.headers.location, `${old.url}/x`);
        old.close();
    });

    await test("a VPS that never answers does not hold the visit for the full timeout", async () => {
        const r = await call("/?fresh", [hanging.url, active.url]);
        assert.strictEqual(r.status, 302);
        assert.ok(r.ms < 1500, `took ${r.ms}ms`);
    });

    await test("nothing answers → 503 page that lists every domain", async () => {
        const r = await call("/?fresh", [deadUrl, retired.url.replace(/\d+$/, "1")]);
        assert.strictEqual(r.status, 503);
        assert.match(r.headers["content-type"], /text\/html/);
        assert.match(r.body, /127\.0\.0\.1:9/);
    });

    await test("/__status waits for every domain and returns JSON", async () => {
        const r = await call("/__status", [redirecting.url, active.url, deadUrl]);
        const j = JSON.parse(r.body);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(j.target, "https://panel1.example.com");
        assert.strictEqual(j.results.length, 3);
        assert.ok(j.results.some((x) => x.error));
    });

    await test("a warm instance reuses its answer; ?fresh asks again", async () => {
        await call("/?fresh", [active.url]);
        const cachedCall = await call("/", [deadUrl]); // seeds changed, but the answer is cached
        assert.strictEqual(cachedCall.headers.location, "https://panel1.example.com/");
        const again = await call("/?fresh", [deadUrl]);
        assert.strictEqual(again.status, 503);
    });

    for (const s of [active, redirecting, retired, hanging]) s.close();

    if (process.env.LIVE) {
        console.log("live");
        delete process.env.PANEL_DOMAINS;
        delete require.cache[require.resolve("./api/go")];
        const handler = require("./api/go");
        const r = await new Promise((resolve) => {
            const headers = {};
            const res = { statusCode: 200, setHeader: (k, v) => (headers[k] = v), end: (body) => resolve({ status: res.statusCode, body }) };
            handler({ url: "/__status" }, res);
        });
        console.log(r.body);
    }

    if (failures) {
        console.error(`\n${failures} check(s) failed`);
        process.exit(1);
    }
    console.log("\nall checks passed");
    process.exit(0);
})();
