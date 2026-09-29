'use strict';
/**
 * IndexNow (openvibe-shared/indexnow): INDEXNOW_KEY unset → the feature is off (no key route, nothing
 * sent). With a key, the key file is served at /<key>.txt as text/plain, and publishing an indexable
 * entity page pings the engines with the entity path and the sitemap. Drafts never ping.
 */
const assert = require('assert');
const { boot, req, suite, editorToken, steamItem, importItem, createEntity } = require('./helpers');

const t = suite('indexnow');
const KEY = 'k'.repeat(32);
const OVERVIEW = 'Most sampled Steam reviewers recommend this game, and the sample here is broad enough to clear the thin-content gate for the entity page in this test without difficulty.';

/** An entity with three live signals and their ids, resolvable through the steam source binding. */
async function entityWithSignals(h) {
    const e = await createEntity(h, { name: 'Portal 2', kind: 'game', aliases: [{ type: 'source', value: 'steam-reviews-portal-2' }] });
    for (let i = 0; i < 3; i++) await importItem(h, steamItem({ votedUp: i < 2 }));
    const sigs = (await h.db.prepare("SELECT id FROM review_signals WHERE entity_id = ? AND status = 'active' ORDER BY id").all(e.id)).map((s) => s.id);
    return { e, sigs };
}

t('without a key IndexNow is off: no key route and nothing sent', async () => {
    const h = await boot();
    try {
        assert.strictEqual(h.indexnow.enabled, false, 'IndexNow is off without a key');
        const res = await req(h, 'GET', `/${KEY}.txt`);
        assert.strictEqual(res.status, 404, res.text);
    } finally { await h.stop(); }
});

t('with a key the key file answers text/plain with the key', async () => {
    const h = await boot({ env: { INDEXNOW_KEY: KEY } });
    try {
        assert.strictEqual(h.indexnow.enabled, true);
        const res = await req(h, 'GET', `/${KEY}.txt`);
        assert.strictEqual(res.status, 200, res.text);
        assert.match(res.headers.get('content-type'), /text\/plain/);
        assert.strictEqual(res.text, KEY);
    } finally { await h.stop(); }
});

t('a draft never pings; a publish pings the page path and the sitemap; a page that only goes noindex is never pinged', async () => {
    // A spy in place of the module's HTTP send: records every pingSoon batch.
    const pings = [];
    const spy = {
        enabled: true,
        keyFile: (_req, _res, next) => next(),
        pingSoon: (urls) => { const a = Array.isArray(urls) ? urls : [urls]; pings.push(...a); return a.length; },
        ping: async () => ({ sent: 0, status: 0 }),
        flush: async () => ({ sent: 0, status: 0 }),
    };
    const h = await boot({ indexnow: spy });
    try {
        const { e, sigs } = await entityWithSignals(h);

        const draft = await req(h, 'POST', `/api/v1/entities/${e.slug}/summary/revisions`, { token: editorToken(), body: { overview: OVERVIEW, overview_signals: sigs } });
        assert.strictEqual(draft.status, 201, draft.text);
        assert.deepStrictEqual(pings, [], 'a draft must not ping');

        const pub = await req(h, 'POST', `/api/v1/entities/${e.slug}/summary/revisions`, { token: editorToken(), body: { overview: OVERVIEW, overview_signals: sigs, publish: true } });
        assert.strictEqual(pub.status, 201, pub.text);
        assert.ok(pings.includes('http://reviews.test/e/portal-2'), JSON.stringify(pings));
        assert.ok(pings.includes('http://reviews.test/sitemap.xml'), JSON.stringify(pings));

        pings.length = 0;
        const unpub = await req(h, 'POST', `/api/v1/entities/${e.slug}/summary/unpublish`, { token: editorToken() });
        assert.strictEqual(unpub.status, 200, unpub.text);
        // The entity page stays (its signals remain) but goes noindex: the chassis pings an indexable
        // page that appeared or changed, or one Search had that went away — never a noindex page.
        assert.deepStrictEqual(pings, [], 'a page that stays but goes noindex is never pinged');
    } finally { await h.stop(); }
});
