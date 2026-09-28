'use strict';
/**
 * Per-actor rate limits (server/http/actor-limits.js, roadmap WS-R task 4): past its limit one caller
 * gets 429 problem+json `rate_limited` with Retry-After, before the route does any work, while
 * another caller still passes; the window reopens on the clock. A person is counted as themselves
 * whether they call directly or a service names them; signed-out reads and a first-party service
 * reading for itself are left to the per-address limit. A write has its own budget, shared by the API
 * and the form that do the same thing. Health, ready, release.json, metrics and the Events deliveries
 * are never limited; refusals are logged (no token) and counted.
 */
const assert = require('assert');
const H = require('./helpers');

(async () => {
    // The limiter's clock: 15 s into a minute, so the minute window has 45 s left. Reads: 3 a minute.
    let clock = Date.UTC(2026, 8, 27, 12, 0, 15);
    const lines = [];
    const log = { ...H.quiet, warn: (m) => lines.push(String(m)) };
    const h = await H.boot({ rateLimits: true, limitsNow: () => clock, log, env: { REVIEWS_LIMITS_MINUTE: '3', REVIEWS_LIMITS_HOUR: '100' } });
    const reader = H.readerToken();
    const other = H.userToken({ subject: H.subject(), username: 'other' });
    const chief = H.userToken({ subject: H.subject(), username: 'chief', role: 'admin' });   // staff: an editor too
    const svc = () => H.serviceToken({ client: 'deals', cap: ['reviews.entity.resolve'] });
    const read = (o) => H.req(h, 'GET', '/api/v1/entities', o);
    try {
        // a read: 3 a minute per person, then 429 rate_limited with Retry-After; another person passes
        for (let i = 0; i < 3; i++) assert.strictEqual((await read({ token: reader })).status, 200, `read ${i + 1}`);
        let r = await read({ token: reader });
        assert.strictEqual(r.status, 429, r.text);
        assert.strictEqual(r.headers.get('retry-after'), '45');
        assert.ok(/^application\/problem\+json/.test(r.headers.get('content-type')), r.headers.get('content-type'));
        assert.deepStrictEqual([r.json.code, r.json.status, r.json.retry_after_seconds], ['rate_limited', 429, 45]);
        assert.ok(r.json.detail.includes('reviews.read'), r.json.detail);
        assert.strictEqual((await read({ token: other })).status, 200, 'another person still passes');
        // POST /resolve only looks up: it shares the read budget
        r = await H.req(h, 'POST', '/api/v1/resolve', { token: reader, body: { name: 'Widget' } });
        assert.deepStrictEqual([r.status, r.json.code], [429, 'rate_limited']);

        // a first-party service naming the person counts against them; reading for itself is not counted
        r = await read({ token: svc(), headers: { 'X-OV-Subject': H.READER } });
        assert.deepStrictEqual([r.status, r.json.code], [429, 'rate_limited']);
        for (let i = 0; i < 6; i++) assert.strictEqual((await read({ token: svc() })).status, 200, `service read ${i + 1}`);

        // signed-out reads keep only the per-address limit (many readers share an address)
        for (let i = 0; i < 8; i++) {
            assert.strictEqual((await read({ headers: { 'X-Forwarded-For': '203.0.113.7' } })).status, 200, `signed-out read ${i + 1}`);
            assert.strictEqual((await H.req(h, 'POST', '/api/v1/resolve', { body: { name: 'Widget' }, headers: { 'X-Forwarded-For': '203.0.113.7' } })).status, 200);
        }

        // the next minute opens the window again
        clock += 45 * 1000;
        assert.strictEqual((await read({ token: reader })).status, 200);

        // entity edits: 30 a minute per editor, shared by the API and the form; nothing is stored past it
        clock = Date.UTC(2026, 8, 27, 12, 5, 0);
        const count = () => h.db.prepare('SELECT COUNT(*) AS n FROM review_entities').get().n;
        for (let i = 0; i < 30; i++) {
            r = await H.req(h, 'POST', '/api/v1/entities', { token: H.editorToken(), body: { name: `Limits entity ${i}`, kind: 'product' } });
            assert.strictEqual(r.status, 201, `entity ${i + 1}: ${r.text}`);
        }
        const before = count();
        r = await H.req(h, 'POST', '/editor/entities/new', { cookie: H.cookieFor(H.editorToken()), form: { name: 'One too many', kind: 'product' } });
        assert.deepStrictEqual([r.status, r.json && r.json.code, r.headers.get('retry-after')], [429, 'rate_limited', '60']);
        assert.strictEqual(count(), before, 'nothing stored');
        r = await H.req(h, 'POST', '/api/v1/entities', { token: chief, body: { name: 'Another editor', kind: 'product' } });
        assert.strictEqual(r.status, 201, `another editor still writes: ${r.text}`);

        // health, ready, release.json, metrics and the Events deliveries are never limited
        for (let i = 0; i < 6; i++) {
            assert.strictEqual((await H.req(h, 'GET', '/api/health')).status, 200);
            assert.notStrictEqual((await H.req(h, 'GET', '/api/ready')).status, 429);
            assert.strictEqual((await H.req(h, 'GET', '/release.json')).status, 200);
            assert.strictEqual((await H.req(h, 'GET', '/metrics')).status, 200);
            const item = H.steamItem();
            h.sources.put(item);
            assert.notStrictEqual((await H.deliver(h, H.sourcesEvent('sources.item.created', item))).status, 429);
        }

        // refusals are logged (the caller, never a token) and counted in reviews_rate_limited_total
        assert.ok(lines.includes(`[Limits] reviews.read: user:${H.READER} refused, over 3 per minute`), lines.join('\n'));
        assert.ok(lines.includes(`[Limits] reviews.entity.manage: user:${H.EDITOR} refused, over 30 per minute`), lines.join('\n'));
        assert.ok(!lines.some((l) => /Bearer|eyJ/.test(l)), 'no token in the log');
        const m = (await H.req(h, 'GET', '/metrics')).text;
        const found = m.split('\n').filter((l) => l.includes('reviews_rate_limited_total')).join('\n');
        assert.ok(/reviews_rate_limited_total\{limit="reviews.read",window="minute"\} 3/.test(m), found);
        assert.ok(/reviews_rate_limited_total\{limit="reviews.entity.manage",window="minute"\} 1/.test(m), found);
        console.log('  ok  actor-limits: reads, services, signed-out reads, shared write budget, never-limited routes, logs and metrics');
    } finally {
        await h.stop();
    }
    process.exit(0);
})().catch((err) => { console.error(`  FAIL actor-limits\n${err && err.stack}`); process.exit(1); });
