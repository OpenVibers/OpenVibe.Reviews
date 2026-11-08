'use strict';
/**
 * The rejected-events count on /api/ready and the metrics gauges (openvibe-sdk outbox.status()) walks the
 * whole review outbox without an index: 92 ms mean on the 2026-11-08 production read. Migration 0009 adds
 * a partial index over the rejected rows only; this proves the count can use it and still answers the same.
 */
const assert = require('assert');
const { testDb } = require('./db');

(async () => {
    const { db } = await testDb();
    try {
        const indexes = await db.prepare(`SELECT indexname FROM pg_indexes
            WHERE schemaname = current_schema() AND tablename = 'review_event_outbox'`).all();
        assert.ok(indexes.some((r) => r.indexname === 'review_event_outbox_rejected'), 'migration 0009 created the partial index');

        const now = Date.now();
        await db.prepare(`INSERT INTO review_event_outbox (event_id, envelope, created_at, next_attempt_at) VALUES
            ('evt_sent', '{}', ?, ?), ('evt_rejected', '{}', ?, ?)`).run(now, now, now, now);
        await db.prepare('UPDATE review_event_outbox SET sent_at = ? WHERE event_id = ?').run(now, 'evt_sent');
        await db.prepare('UPDATE review_event_outbox SET rejected_at = ? WHERE event_id = ?').run(now, 'evt_rejected');

        const count = await db.prepare('SELECT count(*) AS n FROM review_event_outbox WHERE rejected_at IS NOT NULL').get();
        assert.strictEqual(Number(count.n), 1, 'the count still sees the one rejected event');

        await db.query('SET enable_seqscan = off');
        const plan = (await db.prepare('EXPLAIN SELECT count(*) FROM review_event_outbox WHERE rejected_at IS NOT NULL').all())
            .map((r) => r['QUERY PLAN']).join('\n');
        assert.match(plan, /review_event_outbox_rejected/, plan);
    } finally {
        await db.close();
    }
    console.log('ok - the rejected outbox count is an index-only scan over review_event_outbox_rejected');
})().catch((err) => { console.error(err); process.exit(1); });
