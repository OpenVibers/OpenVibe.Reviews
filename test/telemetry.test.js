'use strict';
/**
 * Request telemetry (openvibe-sdk/service, plan T1 step 10): start() builds one collector for service 'reviews' and
 * createApp mounts it; a page hit five times flushes as ONE aggregated http.request sample (route template, 2xx, count
 * 5); /metrics and /shared files make none; the lifecycle flushes before the database closes; with workers on, a 15 s
 * tick and the 14-day retention run; the retention deletes only rows older than 14 days.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pruneTelemetry } = require('openvibe-sdk/telemetry');
const H = require('./helpers');

(async () => {
    const index = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
    assert.match(index, /timers\.push\(setInterval\(\(\) => \{ telemetry\.flush\(\)/, 'the workers tick flushes the collector');
    assert.match(index, /retention = startTelemetryRetention\(\{ db, log, olderThanDays: 14 \}\)/, 'the workers start the retention');
    assert.match(index, /close: \[\n\s+async \(\) => \{ if \(retention\) await retention\.stop\(\); if \(telemetry\) await telemetry\.stop\(\); \},/, 'the flush runs before the database closes');

    const samples = [];
    const h = await H.boot({ telemetrySink: async (batch) => { samples.push(...batch); } });
    const requests = () => samples.filter((s) => s.operation === 'http.request');
    try {
        for (let i = 0; i < 5; i++) assert.strictEqual((await H.req(h, 'GET', '/')).status, 200);
        await h.telemetry.flush();
        const home = requests().filter((s) => s.resource === '/' && s.status === '2xx');
        assert.strictEqual(home.length, 1, JSON.stringify(requests()));
        assert.strictEqual(home[0].service, 'reviews');
        assert.strictEqual(home[0].extra.count, 5);

        samples.length = 0;
        await H.req(h, 'GET', '/metrics');
        await H.req(h, 'GET', '/shared/navbar.js');
        await h.telemetry.flush();
        assert.deepStrictEqual(requests(), [], '/metrics and /shared make no sample');

        await h.db.query('DELETE FROM telemetry_samples');
        const insert = (days) => h.db.query("INSERT INTO telemetry_samples (at, service, operation) VALUES (now() - make_interval(days => $1), 'reviews', 'http.request')", [days]);
        await insert(20);
        await insert(1);
        assert.strictEqual(await pruneTelemetry({ db: h.db, olderThanDays: 14 }), 1);
        assert.strictEqual((await h.db.query('SELECT count(*)::int AS n FROM telemetry_samples')).rows[0].n, 1);
        console.log('telemetry ok');
    } finally {
        await h.stop();
    }
})().catch((err) => { console.error(err); process.exit(1); });
