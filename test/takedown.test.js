'use strict';
/**
 * Source items taken down at their source answer like the other taken-down surfaces: GET
 * /api/v1/items/:id is 410 item.removed (as a deleted entity is 410), for every caller, and the
 * body carries none of the item's content.
 */
const assert = require('assert');
const {
    boot, req, suite, productItem, importItem, deliver, sourcesEvent, serviceToken, editorToken, readerToken,
} = require('./helpers');

const t = suite('takedown');

t('a removed source item is 410 through /api/v1/items/:id, whoever asks', async () => {
    const h = await boot();
    try {
        h.sources.addSource({ key: 'shop-example', name: 'Shop example', homepage_url: 'https://shop.example/', category: 'reviews' });
        const it = productItem({ title: 'Taken Down Widget', url: 'https://shop.example/p/taken-down' });
        await importItem(h, it);
        const resolver = serviceToken({ client: 'tools', cap: ['reviews.entity.resolve'] });
        const callers = [{}, { token: readerToken() }, { token: editorToken() }, { token: resolver }];
        for (const c of callers) {
            const r = await req(h, 'GET', `/api/v1/items/${it.id}`, c);
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.json.item.title, 'Taken Down Widget');
        }

        const removed = h.sources.remove(it.id, 'takedown');
        const d = await deliver(h, sourcesEvent('sources.item.removed', removed, { reason: 'takedown' }));
        assert.strictEqual(d.status, 200, d.text);
        for (const c of callers) {
            const r = await req(h, 'GET', `/api/v1/items/${it.id}`, c);
            assert.strictEqual(r.status, 410, r.text);
            assert.strictEqual(r.json.code, 'item.removed');
            assert.ok(!r.text.includes('Taken Down Widget') && !r.text.includes('shop.example/p/taken-down'), 'no content of the removed item');
        }
    } finally { await h.stop(); }
});

t('an item Reviews first heard of as removed is 410 too; an unknown one stays 404', async () => {
    const h = await boot();
    try {
        const it = productItem({ title: 'Never Seen', url: 'https://shop.example/p/never-seen' });
        h.sources.put(it);
        const removed = h.sources.remove(it.id, 'takedown');
        const out = await importItem(h, removed);
        assert.strictEqual(out.outcome, 'removed:unknown');
        let r = await req(h, 'GET', `/api/v1/items/${it.id}`, { token: editorToken() });
        assert.strictEqual(r.status, 410, r.text);
        assert.strictEqual(r.json.code, 'item.removed');
        r = await req(h, 'GET', '/api/v1/items/itm_01J8Z6Q3KX0000000000000009');
        assert.strictEqual(r.status, 404);
    } finally { await h.stop(); }
});
