'use strict';
/**
 * The sitemaps' entity list (svc.publicEntities): one build serves every reader that asks while it runs; with
 * REVIEWS_SITEMAP_TTL_MS it is reused for that long (production: 10 minutes); and a build reads at most 8 entities'
 * page views at once. On 2026-10-23 each crawler fetch of /sitemap.xml read all 6,138 entities at once: ~30,000
 * queries queued on the pool for a minute, each waiting ~800 ms, while every page waited behind them.
 */
const assert = require('assert');
const { boot, req, suite, createEntity } = require('./helpers');

const t = suite('sitemap-build');

/** Count the merged-into lookups (one per entity view) running at once; prepared statements call db.query. */
function watchViews(h) {
    const seen = { now: 0, max: 0, total: 0 };
    const query = h.db.query.bind(h.db);
    h.db.query = async (text, params) => {
        if (!/merged_into = \$1 AND state = 'merged'/.test(String(text))) return await query(text, params);
        seen.now++; seen.total++; seen.max = Math.max(seen.max, seen.now);
        try { await new Promise((r) => setImmediate(r)); return await query(text, params); } finally { seen.now--; }
    };
    return seen;
}

t('concurrent readers share one build, at most 8 entities at a time; without a TTL the next read rebuilds', async () => {
    const h = await boot();
    try {
        for (let i = 0; i < 20; i++) await createEntity(h, { name: `Game ${i}`, kind: 'game' });
        const seen = watchViews(h);
        const [a, b, c] = await Promise.all([h.svc.publicEntities(), h.svc.publicEntities(), h.svc.publicEntities()]);
        assert.strictEqual(a.length, 20);
        assert.ok(a === b && b === c, 'one build for three readers');
        assert.ok(seen.max >= 1 && seen.max <= 8, `at most 8 at once (saw ${seen.max})`);
        const built = seen.total;
        assert.ok(built >= 20, `each entity read once (${built})`);
        await createEntity(h, { name: 'Game 20', kind: 'game' });
        assert.strictEqual((await h.svc.publicEntities()).length, 21, 'no TTL (tests, development): the next read rebuilds');
        assert.ok((await req(h, 'GET', '/sitemap.xml')).status === 200);
    } finally { await h.stop(); }
});

t('with REVIEWS_SITEMAP_TTL_MS the list is reused until it runs out', async () => {
    let clock = Date.parse('2026-10-23T21:36:00.000Z');
    const h = await boot({ env: { REVIEWS_SITEMAP_TTL_MS: '600000' }, now: () => clock });
    try {
        await createEntity(h, { name: 'Portal 2', kind: 'game' });
        const first = await h.svc.publicEntities();
        await createEntity(h, { name: 'Portal 3', kind: 'game' });
        clock += 9 * 60 * 1000;
        assert.strictEqual(await h.svc.publicEntities(), first, 'reused inside ten minutes');
        clock += 2 * 60 * 1000;
        assert.strictEqual((await h.svc.publicEntities()).length, 2, 'rebuilt after');
    } finally { await h.stop(); }
});
