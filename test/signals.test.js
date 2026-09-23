'use strict';
/**
 * Signals from OpenVibe.Sources items: provenance on every signal, resolution by source binding,
 * no aggregate without signals, removal and update reflected in the next aggregate revision,
 * the webhook + inbox path and the pull path.
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const {
    boot, req, suite, steamItem, productItem, importItem, createEntity, deliver, sourcesEvent, outbox, serviceToken, editorToken, IMPORT,
} = require('./helpers');

const t = suite('signals');

async function aggregateOf(h, slug) {
    const r = await req(h, 'GET', `/api/v1/entities/${slug}/aggregate`, { token: editorToken() });
    assert.strictEqual(r.status, 200, r.text);
    return r.json;
}

t('items without an entity wait unmatched; a source binding settles them; every signal has provenance', async () => {
    const h = await boot();
    try {
        h.sources.addSource({ key: 'steam-reviews-portal-2', name: 'Steam user review signals: Portal 2 (app 620)', homepage_url: 'https://store.steampowered.com/app/620/', category: 'reviews' });
        const items = [steamItem({ votedUp: true }), steamItem({ votedUp: true }), steamItem({ votedUp: false })];
        for (const it of items) {
            const out = await importItem(h, it);
            assert.strictEqual(out.outcome, 'created');
            assert.strictEqual(out.item.resolution, 'unmatched');
            assert.strictEqual(out.signal, null);
        }
        assert.strictEqual(h.db.prepare('SELECT COUNT(*) AS n FROM review_signals').get().n, 0);

        const e = await createEntity(h, { name: 'Portal 2', kind: 'game', aliases: [{ type: 'source', value: 'steam-reviews-portal-2' }] });
        const agg = await aggregateOf(h, e.slug);
        assert.strictEqual(agg.aggregate.revision, 1);
        assert.deepStrictEqual({ p: agg.aggregate.result.components.recommendation.positive, t: agg.aggregate.result.components.recommendation.total }, { p: 2, t: 3 });

        const page = await req(h, 'GET', `/api/v1/entities/${e.slug}`, { token: editorToken() });
        assert.strictEqual(page.json.signals.length, 3);
        for (const s of page.json.signals) {
            assert.match(s.source_item_id, /^itm_/);
            assert.strictEqual(s.source_key, 'steam-reviews-portal-2');
            assert.ok(s.observed_at && !Number.isNaN(Date.parse(s.observed_at)), 'retrieval time');
            assert.ok(Number.isInteger(s.item_revision));
            assert.strictEqual(s.provenance.source_name, 'Steam user review signals: Portal 2 (app 620)');
            assert.ok(s.provenance.terms_note);
            assert.ok('license_note' in s.provenance);
        }
        // The table itself refuses a signal without provenance.
        assert.throws(() => h.db.prepare("INSERT INTO review_signals (id, entity_id, source_item_id, source_key, item_revision, type, recommended, observed_at, created_by, created_at) VALUES ('sig_x', ?, 'itm_nope', 'steam-reviews-portal-2', 1, 'recommendation', 1, NULL, 'x', 0)").run(e.id));
        // Signal values and provenance are immutable.
        assert.throws(() => h.db.prepare('UPDATE review_signals SET observed_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', page.json.signals[0].signal_id), /immutable/);
        assert.throws(() => h.db.prepare('DELETE FROM review_signals WHERE id = ?').run(page.json.signals[0].signal_id), /never deleted/);
        // Review text is never kept.
        for (const row of h.db.prepare('SELECT fields, title FROM review_source_items').all()) {
            assert.ok(!/summary|review_text|body/.test(row.fields));
            assert.strictEqual(row.title, null);
        }
    } finally { await h.stop(); }
});

t('an entity without signals has no aggregate (null, not 0) and no aggregate row', async () => {
    const h = await boot();
    try {
        const e = await createEntity(h, { name: 'Nothing Known Yet', kind: 'product' });
        const agg = await aggregateOf(h, e.slug);
        assert.strictEqual(agg.aggregate, null);
        assert.strictEqual(agg.aggregate_revision, null);
        assert.strictEqual(h.db.prepare('SELECT COUNT(*) AS n FROM review_aggregates').get().n, 0);
    } finally { await h.stop(); }
});

t('source removal (webhook) withdraws the signal and the next aggregate revision reflects it', async () => {
    const h = await boot();
    try {
        const e = await createEntity(h, { name: 'Widget 3000', kind: 'product', aliases: [{ type: 'url', value: 'https://shop.example/p/widget' }] });
        const a = productItem({ value: 4, best: 5, count: 100 });
        const out = await importItem(h, a);
        assert.strictEqual(out.item.resolution, 'resolved');
        assert.strictEqual(out.item.resolution_rule, 'url');
        const b = productItem({ value: 2, best: 5, count: 100, url: 'https://other.example/widget-3000', source: 'other-shop' });
        await req(h, 'POST', `/api/v1/entities/${e.slug}/aliases`, { token: editorToken(), body: { type: 'url', value: 'https://www.other.example/widget-3000/?utm_source=x' } });
        await importItem(h, b);
        let agg = await aggregateOf(h, e.slug);
        assert.strictEqual(agg.aggregate.result.components.rating.on_scale.value, 3);
        assert.strictEqual(agg.aggregate.result.components.rating.count, 200);
        const rev = agg.aggregate.revision;

        const removed = h.sources.remove(b.id, 'licence withdrawn');
        const r = await deliver(h, sourcesEvent('sources.item.removed', removed, { reason: 'licence withdrawn' }));
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json.outcome, 'removed');
        agg = await aggregateOf(h, e.slug);
        assert.strictEqual(agg.aggregate.revision, rev + 1, 'a new aggregate revision');
        assert.strictEqual(agg.aggregate.result.components.rating.on_scale.value, 4);
        assert.strictEqual(agg.aggregate.result.components.rating.count, 100);
        assert.ok(!agg.aggregate.result.inputs.some((i) => i.source_item_id === b.id));
        const sig = h.db.prepare('SELECT * FROM review_signals WHERE source_item_id = ?').get(b.id);
        assert.strictEqual(sig.status, 'withdrawn');
        assert.match(sig.status_reason, /licence withdrawn/);
        const ev = outbox(h).filter((x) => x.event_type === 'reviews.signal.removed');
        assert.strictEqual(ev.length, 1);
        assert.strictEqual(ev[0].payload.source_item_id, b.id);

        // Redelivery is a no-op (inbox), and removing the last signal leaves no aggregate.
        const again = await deliver(h, sourcesEvent('sources.item.removed', removed, { reason: 'licence withdrawn' }));
        assert.strictEqual(again.status, 200);
        const last = h.sources.remove(a.id, 'takedown');
        await deliver(h, sourcesEvent('sources.item.removed', last, { reason: 'takedown' }));
        agg = await aggregateOf(h, e.slug);
        assert.strictEqual(agg.aggregate, null, 'no qualifying signal → no aggregate');
        assert.strictEqual(agg.aggregate_revision, rev + 2, 'the disappearance is itself a recorded revision');
        const rows = h.db.prepare('SELECT revision, result FROM review_aggregates WHERE entity_id = ? ORDER BY revision').all(e.id);
        assert.strictEqual(rows[rows.length - 1].result, null);
    } finally { await h.stop(); }
});

t('an item update supersedes the signal; the pull path follows Sources in change order', async () => {
    const h = await boot();
    try {
        const e = await createEntity(h, { name: 'Portal 2', kind: 'game', aliases: [{ type: 'source', value: 'steam-reviews-portal-2' }] });
        const a = h.sources.put(steamItem({ votedUp: true }));
        h.sources.put(steamItem({ votedUp: true }));
        h.sources.put(productItem({ url: 'https://unrelated.example/x', title: 'Unrelated' }));
        const sync = await req(h, 'POST', '/api/v1/sources/sync', { token: IMPORT() });
        assert.strictEqual(sync.status, 200, sync.text);
        assert.strictEqual(sync.json.pull.ok, true);
        assert.strictEqual(sync.json.pull.applied, 3);
        let agg = await aggregateOf(h, e.slug);
        assert.strictEqual(agg.aggregate.result.components.recommendation.percent, 100);

        h.sources.revise(a.id, { voted_up: false });
        const again = await req(h, 'POST', '/api/v1/sources/sync', { token: IMPORT() });
        assert.strictEqual(again.json.pull.applied, 1);
        agg = await aggregateOf(h, e.slug);
        assert.strictEqual(agg.aggregate.result.components.recommendation.percent, 50);
        const sigs = h.db.prepare('SELECT * FROM review_signals WHERE source_item_id = ? ORDER BY created_at').all(a.id);
        assert.deepStrictEqual(sigs.map((s) => s.status), ['superseded', 'active']);
        assert.strictEqual(sigs[0].superseded_by, sigs[1].id);
        assert.strictEqual(sigs[1].item_revision, 2);
        // Unchanged items are only refreshed.
        const third = await req(h, 'POST', '/api/v1/sources/sync', { token: IMPORT() });
        assert.strictEqual(third.json.pull.applied, 0);
        // The unrelated product waits for an editor, it is never guessed onto an entity.
        const queue = await req(h, 'GET', '/api/v1/items', { token: editorToken() });
        assert.strictEqual(queue.json.items.length, 1);
        assert.strictEqual(queue.json.items[0].resolution, 'unmatched');
    } finally { await h.stop(); }
});

t('a Sources outage changes nothing and invents nothing', async () => {
    const h = await boot();
    try {
        const e = await createEntity(h, { name: 'Portal 2', kind: 'game', aliases: [{ type: 'source', value: 'steam-reviews-portal-2' }] });
        await importItem(h, steamItem({ votedUp: true }));
        const before = await aggregateOf(h, e.slug);
        h.sources.setDown(true);
        const sync = await req(h, 'POST', '/api/v1/sources/sync', { token: IMPORT() });
        assert.strictEqual(sync.status, 200);
        assert.strictEqual(sync.json.pull.ok, false);
        const imp = await req(h, 'POST', '/api/v1/signals/import', { token: IMPORT(), body: { source_item_id: 'itm_01J00000000000000000000000' } });
        assert.strictEqual(imp.status, 503);
        const after = await aggregateOf(h, e.slug);
        assert.deepStrictEqual(after, before);
        // An event for an item Sources cannot serve right now is queued and retried, not faked.
        const ev = await deliver(h, sourcesEvent('sources.item.created', steamItem()));
        assert.strictEqual(ev.json.outcome, 'queued');
        assert.strictEqual(h.sync.pending(), 1);
    } finally { await h.stop(); }
});

t('every produced event is a valid events.event-envelope@1', async () => {
    const h = await boot();
    try {
        const e = await createEntity(h, { name: 'Portal 2', kind: 'game', aliases: [{ type: 'source', value: 'steam-reviews-portal-2' }] });
        const it = steamItem({ votedUp: true });
        await importItem(h, it);
        await deliver(h, sourcesEvent('sources.item.removed', h.sources.remove(it.id), { reason: 'takedown' }));
        const events = outbox(h);
        assert.ok(events.some((x) => x.event_type === 'reviews.signal.added'));
        assert.ok(events.some((x) => x.event_type === 'reviews.signal.removed'));
        assert.ok(events.some((x) => x.event_type === 'reviews.index_document.upserted'));
        for (const env of events) {
            const v = contracts.validate('events.event-envelope@1', env);
            assert.ok(v.valid, `${env.event_type}: ${JSON.stringify(v.errors)}`);
            assert.strictEqual(env.source, 'reviews');
        }
        for (const env of events.filter((x) => x.event_type === 'reviews.index_document.upserted')) {
            const v = contracts.validate('search.index-document@1', env.payload);
            assert.ok(v.valid, JSON.stringify(v.errors));
        }
        assert.ok(e);
    } finally { await h.stop(); }
});

t('import needs the capability; a bad, v1-only or stale webhook signature is refused', async () => {
    const h = await boot();
    try {
        const it = h.sources.put(steamItem());
        const denied = await req(h, 'POST', '/api/v1/signals/import', { token: serviceToken({ cap: ['reviews.entity.resolve'] }), body: { source_item_id: it.id } });
        assert.strictEqual(denied.status, 403);
        assert.strictEqual(denied.json.code, 'capability.denied');
        const bad = await deliver(h, sourcesEvent('sources.item.created', it), { secret: 'wrong' });
        assert.strictEqual(bad.status, 401);
        const v1only = await deliver(h, sourcesEvent('sources.item.created', it), { v1Only: true });
        assert.strictEqual(v1only.status, 401, 'v1 only (no v2 header): refused');
        const stale = await deliver(h, sourcesEvent('sources.item.created', it), { now: Date.now() - 301000 });
        assert.strictEqual(stale.status, 401, 'stale v2 (outside the 300 s window): refused');
        const other = await deliver(h, { ...sourcesEvent('sources.item.created', it), source: 'news' });
        assert.strictEqual(other.json.outcome, 'ignored:source');
    } finally { await h.stop(); }
});
