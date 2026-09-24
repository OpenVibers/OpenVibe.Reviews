'use strict';
/**
 * Resolution is deterministic: strong identifiers resolve, a name alone never does, conflicting
 * identifiers wait for an editor, and every editorial decision is recorded.
 */
const assert = require('assert');
const norm = require('../server/reviews/normalize');
const {
    boot, req, suite, productItem, importItem, createEntity, editorToken, readerToken, serviceToken,
} = require('./helpers');

const t = suite('resolution');

t('normalisation', () => {
    assert.strictEqual(norm.alias('url', 'https://WWW.Shop.example/p/Widget/?utm_source=x&b=2&a=1#top'), 'shop.example/p/Widget?a=1&b=2');
    assert.strictEqual(norm.alias('url', 'http://shop.example/p/Widget'), norm.alias('url', 'https://www.shop.example/p/Widget/'));
    assert.strictEqual(norm.alias('gtin', '012345678905'), '00012345678905');
    assert.strictEqual(norm.alias('gtin', '0012345678905'), '00012345678905');
    assert.strictEqual(norm.alias('name', 'Pokémon  Red & Blue!'), 'pokemon red and blue');
    assert.throws(() => norm.alias('gtin', '12345'), /GTIN/);
    assert.strictEqual(norm.slug('Portal 2: Co-op Édition'), 'portal-2-co-op-edition');
});

t('strong identifiers resolve; names only propose candidates; conflicts wait for an editor', async () => {
    const h = await boot();
    try {
        const w = await createEntity(h, { name: 'Widget 3000', kind: 'product', aliases: [{ type: 'gtin', value: '012345678905' }] });
        const w2 = await createEntity(h, { name: 'Widget 3000', kind: 'product', description: 'A different product with the same name', aliases: [{ type: 'url', value: 'https://b.example/w' }] });

        const byGtin = await importItem(h, productItem({ url: 'https://a.example/w', gtin: '0012345678905', source: 'shop-a' }));
        assert.strictEqual(byGtin.item.resolution, 'resolved');
        assert.strictEqual(byGtin.item.entity_id, w.id);
        assert.strictEqual(byGtin.item.resolution_rule, 'gtin');

        const nameOnly = await importItem(h, productItem({ url: 'https://c.example/w', source: 'shop-c' }));
        assert.strictEqual(nameOnly.item.resolution, 'ambiguous');
        assert.strictEqual(nameOnly.item.candidates.length, 2);
        assert.strictEqual(nameOnly.signal, null, 'no signal until an editor decides');

        const conflict = await importItem(h, productItem({ url: 'https://b.example/w', gtin: '012345678905', source: 'shop-b' }));
        assert.strictEqual(conflict.item.resolution, 'ambiguous');
        assert.strictEqual(conflict.item.resolution_rule, 'conflicting_identifiers');

        const api = await req(h, 'POST', '/api/v1/resolve', { token: serviceToken({ cap: ['reviews.entity.resolve'] }), body: { name: 'widget 3000' } });
        assert.strictEqual(api.json.match, 'ambiguous');
        assert.strictEqual(api.json.entity, null);
        const exact = await req(h, 'POST', '/api/v1/resolve', { token: serviceToken({ cap: ['reviews.entity.resolve'] }), body: { url: 'https://www.b.example/w/' } });
        assert.strictEqual(exact.json.match, 'exact');
        assert.strictEqual(exact.json.entity.id, w2.id);
        assert.strictEqual((await req(h, 'POST', '/api/v1/resolve', { token: serviceToken({ cap: [] }), body: { name: 'x' } })).status, 403);

        // An editor confirms; a reader cannot.
        assert.strictEqual((await req(h, 'POST', `/api/v1/items/${nameOnly.item.id}/resolution`, { token: readerToken(), body: { entity: w2.slug } })).status, 403);
        const ok = await req(h, 'POST', `/api/v1/items/${nameOnly.item.id}/resolution`, { token: editorToken(), body: { entity: w2.slug, add_alias: 'url' } });
        assert.strictEqual(ok.status, 200, ok.text);
        assert.strictEqual(ok.json.item.resolution, 'resolved');
        assert.strictEqual(ok.json.item.resolution_rule, 'editor');
        assert.ok(ok.json.signal);
        // Re-attribution withdraws the old signal and creates a new one for the other entity.
        const moved = await req(h, 'POST', `/api/v1/items/${nameOnly.item.id}/resolution`, { token: editorToken(), body: { entity: w.slug } });
        assert.strictEqual(moved.status, 200, moved.text);
        const sigs = h.db.prepare('SELECT entity_id, status FROM review_signals WHERE source_item_id = ? ORDER BY created_at').all(nameOnly.item.id);
        assert.deepStrictEqual(sigs.map((s) => [s.entity_id, s.status]), [[w2.id, 'withdrawn'], [w.id, 'active']]);
        const log = h.db.prepare("SELECT COUNT(*) AS n FROM review_audit WHERE action = 'item.resolved'").get().n;
        assert.strictEqual(log, 2);

        // Strong identifiers are unique across entities.
        const dup = await req(h, 'POST', `/api/v1/entities/${w2.slug}/aliases`, { token: editorToken(), body: { type: 'gtin', value: '0012345678905' } });
        assert.strictEqual(dup.status, 409);
        assert.strictEqual(dup.json.code, 'alias.taken');
    } finally { await h.stop(); }
});

t('API identity: bad tokens are refused, never downgraded; editor actions need a person', async () => {
    const h = await boot();
    try {
        assert.strictEqual((await req(h, 'GET', '/api/v1/entities', { token: 'not.a.token' })).status, 401);
        assert.strictEqual((await req(h, 'GET', '/api/v1/entities', { token: serviceToken({ aud: 'openvibe.wiki', cap: ['reviews.entity.resolve'] }) })).status, 401);
        const anon = await req(h, 'POST', '/api/v1/entities', { body: { name: 'X' } });
        assert.strictEqual(anon.status, 403);
        const svc = await req(h, 'POST', '/api/v1/entities', { token: serviceToken({ cap: ['reviews.entity.manage'] }), body: { name: 'X' } });
        assert.strictEqual(svc.status, 403);
        const asEditor = await req(h, 'POST', '/api/v1/entities', { token: serviceToken({ cap: ['reviews.entity.manage'] }), headers: { 'X-OV-Subject': require('./helpers').EDITOR }, body: { name: 'Made For An Editor', kind: 'software' } });
        assert.strictEqual(asEditor.status, 201, asEditor.text);
        const staff = await req(h, 'POST', '/api/v1/entities', { token: require('./helpers').userToken({ role: 'admin' }), body: { name: 'Made By Staff' } });
        assert.strictEqual(staff.status, 201, 'staff.editorial.manage (admin) edits');
        const mod = await req(h, 'POST', '/api/v1/entities', { token: require('./helpers').userToken({ role: 'global_mod' }), body: { name: 'Made By A Mod' } });
        assert.strictEqual(mod.status, 403, 'a global_mod moderates, it does not edit');
        const ready = await req(h, 'GET', '/api/ready');
        assert.strictEqual(ready.status, 200);
        assert.strictEqual(ready.json.ready, true);
        assert.strictEqual((await req(h, 'GET', '/api/health')).json.service, 'openvibe-reviews');
        // The release manifest (registry.release-manifest@1) names where open tabs report updates.
        const rel = await req(h, 'GET', '/release.json');
        assert.strictEqual(rel.json.service, 'reviews');
        assert.deepStrictEqual(require('openvibe-contracts').validate('registry.release-manifest@1', rel.json).errors, []);
        assert.strictEqual(rel.json.metrics_url, '/release-metrics');
        const nf = await req(h, 'GET', '/api/v1/nope');
        assert.strictEqual(nf.status, 404);
        assert.match(nf.headers.get('content-type'), /problem\+json/);
    } finally { await h.stop(); }
});
