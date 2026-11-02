'use strict';
/**
 * The home's "with data" list (svc.entitiesWithData): every active entity with an active signal of its own, or one on
 * an entity merged into it, or a published summary; none without; newest change first. It reads from the signals and
 * summaries to the entities (2.5 ms on production), not a subquery per active entity (178 ms, 2026-11-02).
 */
const assert = require('assert');
const { boot, suite, steamItem, importItem, createEntity, req, editorToken } = require('./helpers');

const t = suite('entities-with-data');

t('the entities with signals, merged signals or a published summary; none without', async () => {
    const h = await boot();
    try {
        const rated = await createEntity(h, { name: 'Portal 2', kind: 'game', aliases: [{ type: 'source', value: 'steam-reviews-portal-2' }] });
        const dup = await createEntity(h, { name: 'Portal Two', kind: 'game', aliases: [{ type: 'source', value: 'steam-reviews-portal-two-dup' }] });
        const keeper = await createEntity(h, { name: 'Portal (the keeper)', kind: 'game' });
        const bare = await createEntity(h, { name: 'No data yet', kind: 'game' });
        const summarised = await createEntity(h, { name: 'Summarised', kind: 'game' });
        await importItem(h, steamItem({ votedUp: true }));
        await importItem(h, steamItem({ votedUp: false, source: 'steam-reviews-portal-two-dup' }));
        // The duplicate merges into the keeper: its signal now counts for the keeper.
        const m = await req(h, 'POST', `/api/v1/entities/${dup.slug}/merge`, { token: editorToken(), body: { into: keeper.slug, note: 'duplicate' } });
        assert.ok(m.status < 300, m.text);
        await h.db.prepare("INSERT INTO review_summaries (id, entity_id, state, created_at, updated_at) VALUES (?, ?, 'published', ?, ?)").run('sum_entities_with_data', summarised.id, Date.now(), Date.now());
        const got = (await h.svc.entitiesWithData(60)).map((x) => x.entity.id);
        assert.ok(got.includes(rated.id), 'its own active signal');
        assert.ok(got.includes(keeper.id), 'a signal on an entity merged into it');
        assert.ok(!got.includes(dup.id), 'the merged entity itself is not active');
        assert.ok(!got.includes(bare.id), 'nothing without data');
        assert.ok(got.includes(summarised.id), 'a published summary');
        const rows = await h.db.prepare('SELECT id, updated_at FROM review_entities WHERE id = ANY(?)').all(got);
        const at = new Map(rows.map((r) => [r.id, String(r.updated_at)]));
        for (let i = 1; i < got.length; i++) assert.ok(at.get(got[i - 1]) >= at.get(got[i]), 'newest change first');
        assert.ok((await h.svc.entitiesWithData(1)).length === 1, 'the limit holds');
    } finally {
        await h.stop();
    }
});

