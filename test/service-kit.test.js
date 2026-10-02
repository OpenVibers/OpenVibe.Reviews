'use strict';
/**
 * openvibe-sdk/service (plan T1): Reviews' error half is the kit's sendError/run with Reviews' options, so a
 * refusal answers its own status/code/detail with `extra` spread into the body (never nested as `details`),
 * a 503 keeps its detail, an unexpected throw answers 500 internal.error with 'Internal error', and a
 * successful run answers `private, no-store`. The entry point's stop runs its stop and close steps in order
 * (timers, outbox, then db) and exits 0; a database a test handed in is left open.
 */
const assert = require('assert');
const http = require('http');
const express = require('express');
const { sendError, run } = require('../server/http/common');
const { createLifecycle } = require('../server/index');

const quiet = { log() {}, warn() {}, error() {} };
const errors = [];
const rec = { log() {}, warn() {}, error(...args) { errors.push(args); } };

(async () => {
    // A service-shaped app on Reviews' run/sendError, the way the API router wires them.
    const app = express();
    app.get('/ok', run(async () => ({ ok: true }), 200, quiet));
    app.post('/refuse', run(async () => { throw Object.assign(new Error('A name is required'), { status: 422, code: 'reviews.name_required', extra: { field: 'name' } }); }, 200, quiet));
    app.post('/gone', run(async () => { throw Object.assign(new Error('Sources is not answering right now'), { status: 503, code: 'sources.unavailable' }); }, 200, rec));
    app.post('/boom', run(async () => { throw new Error('boom'); }, 200, rec));
    app.get('/direct', (req, res) => sendError(res, req, Object.assign(new Error('nope'), { status: 422, code: 'reviews.direct', extra: { n: 1 } }), quiet));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (p) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const read = async (r) => { const text = await r.text(); return { status: r.status, headers: r.headers, json: JSON.parse(text) }; };

    const ok = await read(await fetch(`${base}/ok`));
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.json));
    assert.deepStrictEqual(ok.json, { ok: true });
    assert.strictEqual(ok.headers.get('cache-control'), 'private, no-store');
    assert.match(String(ok.headers.get('vary')), /Cookie/, 'the private policy varies on Cookie/Authorization');

    const refused = await read(await post('/refuse'));
    assert.strictEqual(refused.status, 422, JSON.stringify(refused.json));
    assert.strictEqual(refused.json.code, 'reviews.name_required');
    assert.strictEqual(refused.json.detail, 'A name is required');
    assert.deepStrictEqual(refused.json.field, 'name', 'extra is spread into the body');
    assert.strictEqual(refused.json.details, undefined, 'extra is not nested as { details }');

    const gone = await read(await post('/gone'));
    assert.strictEqual(gone.status, 503, JSON.stringify(gone.json));
    assert.strictEqual(gone.json.code, 'sources.unavailable');
    assert.strictEqual(gone.json.detail, 'Sources is not answering right now');

    const boom = await read(await post('/boom'));
    assert.strictEqual(boom.status, 500, JSON.stringify(boom.json));
    assert.strictEqual(boom.json.code, 'internal.error');
    assert.strictEqual(boom.json.detail, 'Internal error');
    assert.strictEqual(boom.json.error, 'Internal error');
    assert.strictEqual(boom.json.error, boom.json.detail);
    // Only a 5xx that is not 503 is logged, under [Reviews]; the 422 and the 503 above were not.
    assert.strictEqual(errors.length, 1, JSON.stringify(errors));
    assert.strictEqual(errors[0][0], '[Reviews]');
    assert.match(String(errors[0][1]), /^Error: boom/);

    const direct = await read(await fetch(`${base}/direct`));
    assert.strictEqual(direct.status, 422, JSON.stringify(direct.json));
    assert.strictEqual(direct.json.code, 'reviews.direct');
    assert.strictEqual(direct.json.n, 1, 'sendError spreads extra too');

    server.close();

    // The stop path: stop steps in order, then close steps, then exit 0.
    const steps = [];
    const stopServer = await new Promise((resolve) => { const s = http.createServer((_req, res) => res.end('ok')); s.listen(0, '127.0.0.1', () => resolve(s)); });
    const timers = [setInterval(() => {}, 1000)];
    const cleared = [];
    const realClear = global.clearInterval;
    global.clearInterval = (t) => { cleared.push(t); return realClear(t); };
    const exits = [];
    try {
        const lifecycle = createLifecycle({
            server: stopServer,
            db: { close: async () => { steps.push('db.close'); } },
            platform: { outbox: { stop: async () => { steps.push('outbox.stop'); } } },
            timers, closeDb: true, exit: (code) => exits.push(code), signals: false, log: quiet,
        });
        assert.strictEqual(lifecycle.stopping(), false, 'not stopping before the signal');
        const code = await lifecycle.stop('SIGTERM');
        assert.strictEqual(lifecycle.stopping(), true, 'stopping after the signal');
        assert.strictEqual(code, 0);
        assert.deepStrictEqual(exits, [0], 'exits 0, not 1 (the deadlineExitCode is 0)');
        assert.deepStrictEqual(steps, ['outbox.stop', 'db.close'], 'today\'s order');
        assert.ok(cleared.includes(timers[0]), 'the job timer was cleared');
        assert.strictEqual(stopServer.listening, false, 'the HTTP server stopped listening');
    } finally {
        global.clearInterval = realClear;
    }

    // A database handed in stays open (closeDb false) and an absent Valkey has no close step.
    const steps2 = [];
    const lifecycle2 = createLifecycle({
        server: null, db: { close: async () => { steps2.push('db.close'); } }, valkey: null,
        platform: { outbox: { stop: async () => { steps2.push('outbox.stop'); } } },
        closeDb: false, exit: () => {}, signals: false, log: quiet,
    });
    assert.strictEqual(await lifecycle2.stop(), 0);
    assert.deepStrictEqual(steps2, ['outbox.stop']);

    console.log('service-kit ok');
})().catch((err) => { console.error(err); process.exit(1); });
