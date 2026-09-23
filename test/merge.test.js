'use strict';
/**
 * Merges are reversible and audited: a merge rewrites nothing, a split restores the pre-merge
 * signal attribution, aliases and aggregates exactly, and both are recorded with who, when and why.
 */
const assert = require('assert');
const {
    boot, req, suite, steamItem, productItem, importItem, createEntity, outbox, editorToken, readerToken, serviceToken, EDITOR,
} = require('./helpers');

const t = suite('merge');

function snapshot(h, ids) {
    const out = {};
    for (const id of ids) {
        out[id] = {
            entity: h.db.prepare('SELECT id, slug, name, kind, state, merged_into FROM review_entities WHERE id = ?').get(id),
            signals: h.db.prepare('SELECT id, entity_id, source_item_id, status, type, recommended, rating_value FROM review_signals WHERE entity_id = ? ORDER BY id').all(id),
            aliases: h.db.prepare('SELECT id, type, norm, removed_at FROM review_entity_aliases WHERE entity_id = ? ORDER BY id').all(id),
            items: h.db.prepare('SELECT id, entity_id, resolution FROM review_source_items WHERE entity_id = ? ORDER BY id').all(id),
            aggregate: (() => { const r = h.db.prepare('SELECT result FROM review_aggregates WHERE entity_id = ? ORDER BY revision DESC LIMIT 1').get(id); return r ? r.result : null; })(),
        };
    }
    return out;
}

t('merge → split round trip restores attribution, aliases and aggregates exactly', async () => {
    const h = await boot();
    try {
        const a = await createEntity(h, { name: 'Portal 2', kind: 'game', aliases: [{ type: 'source', value: 'steam-reviews-portal-2' }] });
        const b = await createEntity(h, { name: 'Portal Two', kind: 'game', aliases: [{ type: 'source', value: 'steam-reviews-portal-two-dup' }] });
        for (const v of [true, true, false]) await importItem(h, steamItem({ votedUp: v }));
        for (const v of [true, false]) await importItem(h, steamItem({ votedUp: v, source: 'steam-reviews-portal-two-dup' }));
        const before = snapshot(h, [a.id, b.id]);
        assert.strictEqual(before[a.id].signals.length, 3);
        assert.strictEqual(before[b.id].signals.length, 2);

        // Only an editor who is a person can merge.
        const svcOnly = await req(h, 'POST', `/api/v1/entities/${b.slug}/merge`, { token: serviceToken({ cap: ['reviews.entity.merge'] }), body: { into: a.slug } });
        assert.strictEqual(svcOnly.status, 403);
        assert.strictEqual(svcOnly.json.code, 'reviews.person_required');
        const reader = await req(h, 'POST', `/api/v1/entities/${b.slug}/merge`, { token: readerToken(), body: { into: a.slug } });
        assert.strictEqual(reader.status, 403);
        assert.strictEqual(reader.json.code, 'reviews.editor_required');

        const m = await req(h, 'POST', `/api/v1/entities/${b.slug}/merge`, { token: editorToken(), body: { into: a.slug, note: 'Same game, duplicate listing' } });
        assert.strictEqual(m.status, 200, m.text);
        assert.strictEqual(m.json.signals.length, 2);

        // Nothing was rewritten: signals keep their entity; the target's aggregate spans both.
        const during = snapshot(h, [a.id, b.id]);
        assert.deepStrictEqual(during[b.id].signals, before[b.id].signals);
        assert.deepStrictEqual(during[a.id].signals, before[a.id].signals);
        assert.deepStrictEqual(during[b.id].aliases, before[b.id].aliases);
        const aggA = await req(h, 'GET', `/api/v1/entities/${a.slug}/aggregate`, { token: editorToken() });
        assert.deepStrictEqual({ p: aggA.json.aggregate.result.components.recommendation.positive, t: aggA.json.aggregate.result.components.recommendation.total }, { p: 3, t: 5 });
        // The merged entity redirects; its identifiers resolve to the canonical entity.
        const page = await req(h, 'GET', `/e/${b.slug}`);
        assert.strictEqual(page.status, 301);
        assert.strictEqual(page.headers.get('location'), `/e/${a.slug}`);
        const res = await req(h, 'POST', '/api/v1/resolve', { token: editorToken(), body: { source: 'steam-reviews-portal-two-dup' } });
        assert.strictEqual(res.json.match, 'exact');
        assert.strictEqual(res.json.entity.id, a.id);
        assert.strictEqual(res.json.via.id, b.id);
        // A new item for B while merged is still attributed to B (and shown under A).
        await importItem(h, steamItem({ votedUp: true, source: 'steam-reviews-portal-two-dup' }));
        const late = h.db.prepare("SELECT entity_id FROM review_signals WHERE source_key = 'steam-reviews-portal-two-dup' ORDER BY created_at DESC LIMIT 1").get();
        assert.strictEqual(late.entity_id, b.id);

        const s = await req(h, 'POST', `/api/v1/entities/${b.slug}/split`, { token: editorToken(), body: { note: 'Actually two different editions' } });
        assert.strictEqual(s.status, 200, s.text);
        const after = snapshot(h, [a.id, b.id]);
        // A is exactly as before; B is as before plus the signal that arrived for B meanwhile.
        assert.deepStrictEqual(after[a.id], before[a.id]);
        assert.deepStrictEqual(after[b.id].entity, before[b.id].entity);
        assert.deepStrictEqual(after[b.id].aliases, before[b.id].aliases);
        assert.deepStrictEqual(after[b.id].signals.slice(0, 2), before[b.id].signals);
        assert.strictEqual(after[b.id].signals.length, 3);

        // Audited: the link row, the log and the events.
        const link = h.db.prepare("SELECT * FROM review_entity_links WHERE type = 'merged_into'").get();
        assert.strictEqual(link.created_by, EDITOR);
        assert.strictEqual(link.note, 'Same game, duplicate listing');
        assert.strictEqual(link.ended_by, EDITOR);
        assert.strictEqual(link.end_note, 'Actually two different editions');
        const log = h.db.prepare("SELECT action, actor, detail FROM review_audit WHERE action IN ('entity.merged','entity.split') ORDER BY id").all();
        assert.deepStrictEqual(log.map((r) => r.action), ['entity.merged', 'entity.split']);
        assert.deepStrictEqual(JSON.parse(log[0].detail).signals.sort(), before[b.id].signals.map((x) => x.id).sort());
        const ev = outbox(h).filter((x) => /^reviews\.entity\./.test(x.event_type)).map((x) => x.event_type);
        assert.deepStrictEqual(ev, ['reviews.entity.merged', 'reviews.entity.split']);
        const hist = await req(h, 'GET', `/e/${a.slug}/history`);
        assert.match(hist.text, /Portal Two<\/a> merged into/);
        assert.match(hist.text, /split again/);
    } finally { await h.stop(); }
});

t('merge refuses cycles, self-merges and merged targets; split refuses an active entity', async () => {
    const h = await boot();
    try {
        const a = await createEntity(h, { name: 'Alpha', kind: 'product' });
        const b = await createEntity(h, { name: 'Beta', kind: 'product' });
        const c = await createEntity(h, { name: 'Gamma', kind: 'product' });
        const tok = editorToken();
        assert.strictEqual((await req(h, 'POST', `/api/v1/entities/${a.slug}/merge`, { token: tok, body: { into: a.slug } })).status, 422);
        assert.strictEqual((await req(h, 'POST', `/api/v1/entities/${a.slug}/merge`, { token: tok, body: { into: b.slug } })).status, 200);
        const toMerged = await req(h, 'POST', `/api/v1/entities/${c.slug}/merge`, { token: tok, body: { into: a.slug } });
        assert.strictEqual(toMerged.status, 409);
        assert.strictEqual(toMerged.json.canonical_id, b.id);
        const cycle = await req(h, 'POST', `/api/v1/entities/${b.slug}/merge`, { token: tok, body: { into: a.slug } });
        assert.strictEqual(cycle.status, 409);
        assert.strictEqual((await req(h, 'POST', `/api/v1/entities/${c.slug}/split`, { token: tok, body: {} })).status, 409);
    } finally { await h.stop(); }
});

t('a split flags the former target\'s summary when it cited signals that went back', async () => {
    const h = await boot();
    try {
        const a = await createEntity(h, { name: 'Widget', kind: 'product', aliases: [{ type: 'url', value: 'https://shop.example/p/widget' }] });
        const b = await createEntity(h, { name: 'Widget Pro', kind: 'product', aliases: [{ type: 'url', value: 'https://shop.example/p/widget-pro' }] });
        await importItem(h, productItem({ value: 4, best: 5, count: 10 }));
        await importItem(h, productItem({ value: 3, best: 5, count: 10, url: 'https://shop.example/p/widget-pro', title: 'Widget Pro' }));
        const sigB = h.db.prepare('SELECT id FROM review_signals WHERE entity_id = ?').get(b.id).id;
        const sigA = h.db.prepare('SELECT id FROM review_signals WHERE entity_id = ?').get(a.id).id;
        await req(h, 'POST', `/api/v1/entities/${b.slug}/merge`, { token: editorToken(), body: { into: a.slug, note: 'dup' } });
        const w = await req(h, 'POST', `/api/v1/entities/${a.slug}/summary/revisions`, { token: editorToken(), body: {
            overview: 'Two shop listings rate it.', pros: [{ text: 'Rated well at the first shop', signals: [sigA] }], cons: [{ text: 'Rated lower at the second listing', signals: [sigB] }], publish: true,
        } });
        assert.strictEqual(w.status, 201, w.text);
        await req(h, 'POST', `/api/v1/entities/${b.slug}/split`, { token: editorToken(), body: { note: 'different products' } });
        const s = h.db.prepare('SELECT * FROM review_summaries WHERE entity_id = ?').get(a.id);
        assert.strictEqual(s.flagged, 1);
        assert.match(s.flag_reason, /split/);
        const page = await req(h, 'GET', `/api/v1/entities/${a.slug}`, { token: editorToken() });
        assert.strictEqual(page.json.summary.pending.length, 1);
        assert.strictEqual(page.json.summary.pending[0].status, 'pending_system');
        assert.deepStrictEqual(page.json.summary.pending[0].points.map((p) => p.kind), ['pro'], 'the con resting on the split-off signal is dropped');
        assert.ok(page.json.summary.published.points.find((p) => p.kind === 'con').supported === false);
    } finally { await h.stop(); }
});
