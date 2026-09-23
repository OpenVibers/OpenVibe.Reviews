'use strict';
/**
 * Public routes are useful without JavaScript, editors work with plain form posts, and structured
 * data never claims a rating the signals do not back: AggregateRating (and Product / Review)
 * JSON-LD is absent without signals.
 */
const assert = require('assert');
const {
    boot, req, suite, steamItem, productItem, importItem, createEntity, deliver, sourcesEvent, cookieFor, editorToken, readerToken, fakeCommunity,
} = require('./helpers');

const t = suite('nojs');

const noScripts = (html) => html.replace(/<script[\s\S]*?<\/script>/g, '');
const jsonLd = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
const robots = (html) => (html.match(/<meta name="robots" content="([^"]+)"/) || [])[1];

t('AggregateRating JSON-LD is absent without signals, present only while signals back it', async () => {
    const h = await boot();
    try {
        const e = await createEntity(h, { name: 'Widget 3000', kind: 'product', aliases: [{ type: 'url', value: 'https://shop.example/p/widget' }] });
        let page = await req(h, 'GET', `/e/${e.slug}`);
        assert.strictEqual(page.status, 200);
        let ld = jsonLd(page.text);
        assert.deepStrictEqual(ld.map((x) => x['@type']), ['BreadcrumbList']);
        assert.ok(!/AggregateRating|"Product"|ratingValue|reviewRating/.test(page.text));
        assert.match(noScripts(page.text), /No aggregate\./);
        assert.strictEqual(robots(page.text), 'noindex, follow', 'thin and unsourced');

        const item = productItem({ value: 4.4, best: 5, count: 321 });
        await importItem(h, item);
        page = await req(h, 'GET', `/e/${e.slug}`);
        ld = jsonLd(page.text);
        const product = ld.find((x) => x['@type'] === 'Product');
        assert.ok(product, 'Product with AggregateRating once a signal exists');
        assert.deepStrictEqual(product.aggregateRating, { '@type': 'AggregateRating', ratingValue: 4.4, ratingCount: 321, bestRating: 5 });
        assert.ok(!ld.some((x) => x['@type'] === 'Review'), 'no Review without a published summary');
        const visible = noScripts(page.text);
        assert.match(visible, /4\.4 \/ 5<\/strong> from 321 ratings/);
        assert.match(visible, new RegExp(item.id));

        await deliver(h, sourcesEvent('sources.item.removed', h.sources.remove(item.id, 'takedown'), { reason: 'takedown' }));
        page = await req(h, 'GET', `/e/${e.slug}`);
        assert.ok(!/AggregateRating|"Product"|ratingValue/.test(page.text), 'gone with the signal');
        assert.match(noScripts(page.text), /No aggregate\./);
        const json = await req(h, 'GET', `/e/${e.slug}.json`);
        assert.strictEqual(json.json.aggregate, null);
        assert.strictEqual(json.json.signals.length, 0);
        assert.strictEqual(json.json.inactive_signals[0].status, 'withdrawn');
    } finally { await h.stop(); }
});

t('a recommendation-only entity: AggregateRating is the real share and count, on a 0–100 scale', async () => {
    const h = await boot();
    try {
        const e = await createEntity(h, { name: 'Portal 2', kind: 'game', aliases: [{ type: 'source', value: 'steam-reviews-portal-2' }] });
        for (const v of [true, true, true, false]) await importItem(h, steamItem({ votedUp: v }));
        const page = await req(h, 'GET', `/e/${e.slug}`);
        const game = jsonLd(page.text).find((x) => x['@type'] === 'VideoGame');
        assert.deepStrictEqual(game.aggregateRating, { '@type': 'AggregateRating', ratingValue: 75, ratingCount: 4, bestRating: 100, worstRating: 0 });
        assert.match(noScripts(page.text), /75%<\/strong> recommend: 3 of 4/);
        assert.ok(!/★/.test(page.text));
    } finally { await h.stop(); }
});

t('every public page reads without JavaScript; sitemaps, feeds and robots follow the gate', async () => {
    const h = await boot({ community: fakeCommunity() });
    try {
        const home0 = await req(h, 'GET', '/');
        assert.match(noScripts(home0.text), /Nothing yet\./, 'nothing seeded');
        const e = await createEntity(h, { name: 'Portal 2', kind: 'game', description: 'A puzzle game.', aliases: [{ type: 'source', value: 'steam-reviews-portal-2' }] });
        for (const v of [true, false]) await importItem(h, steamItem({ votedUp: v }));
        const sig = h.db.prepare('SELECT id, recommended FROM review_signals').all();
        let sm = await req(h, 'GET', '/sitemaps/entities-1.xml');
        assert.ok(!sm.text.includes(`/e/${e.slug}`), 'thin: not in the sitemap');
        await req(h, 'POST', `/api/v1/entities/${e.slug}/summary/revisions`, { token: editorToken(), body: {
            overview: 'In the small recent sample Reviews has read, opinion is split evenly between players who recommend it and players who do not, which says more about the sample than the game.',
            overview_signals: sig.map((s) => s.id),
            pros: [{ text: 'Half of the sample recommends it', signals: sig.filter((s) => s.recommended).map((s) => s.id) }],
            cons: [{ text: 'Half does not', signals: sig.filter((s) => !s.recommended).map((s) => s.id) }], publish: true,
        } });
        const page = await req(h, 'GET', `/e/${e.slug}`);
        assert.strictEqual(robots(page.text), 'index, follow');
        assert.strictEqual(page.headers.get('cache-control'), 'public, max-age=60');
        const text = noScripts(page.text);
        for (const needle of ['Portal 2', '50%</strong> recommend', 'Half of the sample recommends it', 'Retrieved', 'steam-reviews-portal-2', 'Computation', '/history', '/correct', 'Discussion']) assert.ok(text.includes(needle), needle);
        assert.ok(jsonLd(page.text).some((x) => x['@type'] === 'Review'));
        sm = await req(h, 'GET', '/sitemaps/entities-1.xml');
        assert.ok(sm.text.includes(`http://reviews.test/e/${e.slug}`));
        const idx = await req(h, 'GET', '/sitemap.xml');
        assert.match(idx.text, /sitemaps\/entities-1\.xml/);
        const atom = await req(h, 'GET', '/feed.atom');
        assert.strictEqual(atom.status, 200);
        assert.match(atom.text, /Portal 2: summary/);
        const feed = await req(h, 'GET', '/feed.json');
        assert.strictEqual(JSON.parse(feed.text).items.length, 1);
        const rb = await req(h, 'GET', '/robots.txt');
        assert.match(rb.text, /Sitemap: http:\/\/reviews\.test\/sitemap\.xml/);
        assert.match(rb.text, /Disallow: \/editor/);
        assert.match((await req(h, 'GET', '/llms.txt')).text, /OpenVibe\.Reviews/);
        for (const p of ['/', '/about', `/e/${e.slug}/history`, `/e/${e.slug}/summary/1`, '/search?q=portal']) {
            const r = await req(h, 'GET', p);
            assert.strictEqual(r.status, 200, p);
            assert.ok(noScripts(r.text).includes('<main id="main"'), p);
        }
        assert.match(noScripts((await req(h, 'GET', '/search?q=portal')).text), /Portal 2/);
        assert.match(noScripts((await req(h, 'GET', '/')).text), /Portal 2/);

        // Discussion through Community: a person comments with a plain form post.
        const c = await req(h, 'POST', `/e/${e.slug}/discuss`, { cookie: cookieFor(readerToken()), form: { message: 'Is the co-op counted here?' } });
        assert.strictEqual(c.status, 303);
        const after = await req(h, 'GET', `/e/${e.slug}`, { cookie: cookieFor(readerToken()) });
        assert.match(after.text, /Is the co-op counted here\?/);
        // Referenced, not duplicated: the comment text exists in Community only.
        for (const { name } of h.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
            for (const row of h.db.prepare(`SELECT * FROM "${name}"`).all()) assert.ok(!JSON.stringify(row).includes('co-op counted'), `comment text copied into ${name}`);
        }
    } finally { await h.stop(); }
});

t('editors work with plain forms: create, resolve an ambiguous item, summarise, merge, split, correct', async () => {
    const h = await boot();
    try {
        const ed = cookieFor(editorToken());
        // Readers do not get the editor desk.
        assert.strictEqual((await req(h, 'GET', '/editor', { cookie: cookieFor(readerToken()) })).status, 403);
        assert.strictEqual((await req(h, 'GET', '/editor')).status, 401);

        const made = await req(h, 'POST', '/editor/entities/new', { cookie: ed, form: { name: 'Widget 3000', kind: 'product', alias_gtin: '0012345678905' } });
        assert.strictEqual(made.status, 303);
        assert.strictEqual(made.headers.get('location'), '/e/widget-3000/edit');
        // A shop item that names the product but carries no identifier Reviews knows: name only → ambiguous.
        const it = productItem({ url: 'https://another.example/w3000', title: 'Widget 3000', source: 'another-shop' });
        const imp = await importItem(h, it);
        assert.strictEqual(imp.item.resolution, 'ambiguous');
        assert.strictEqual(imp.item.resolution_rule, 'name_only');
        const desk = await req(h, 'GET', '/editor', { cookie: ed });
        assert.match(noScripts(desk.text), new RegExp(it.id));
        const form = await req(h, 'GET', `/editor/items/${it.id}`, { cookie: ed });
        assert.match(form.text, /<form method="post" action="\/editor\/items\//);
        const res = await req(h, 'POST', `/editor/items/${it.id}`, { cookie: ed, form: { action: 'resolve', entity: 'widget-3000', add_alias: 'url' } });
        assert.strictEqual(res.status, 303);
        const sig = h.db.prepare("SELECT id FROM review_signals WHERE status = 'active'").get();
        assert.ok(sig, 'confirmed → signal');
        assert.strictEqual(h.db.prepare('SELECT resolution_rule, resolved_by FROM review_source_items WHERE id = ?').get(it.id).resolution_rule, 'editor');

        const edit = await req(h, 'GET', '/e/widget-3000/edit', { cookie: ed });
        assert.match(edit.text, new RegExp(`<option value="${sig.id}"`));
        const saved = await req(h, 'POST', '/e/widget-3000/summary', { cookie: ed, form: { overview: 'One shop listing rates it.', overview_signals: sig.id, pro_text_0: 'Well rated at one shop', pro_signals_0: sig.id, expected_revision: '0', publish: '1' } });
        assert.strictEqual(saved.status, 303, saved.text.slice(0, 300));
        assert.match(noScripts((await req(h, 'GET', '/e/widget-3000')).text), /Well rated at one shop/);

        const other = await createEntity(h, { name: 'Widget 3000 (2024)', kind: 'product' });
        const m = await req(h, 'POST', `/e/${other.slug}/merge`, { cookie: ed, form: { into: 'widget-3000', note: 'same product' } });
        assert.strictEqual(m.status, 303);
        assert.strictEqual((await req(h, 'GET', `/e/${other.slug}`)).status, 301);
        const s = await req(h, 'POST', `/e/${other.slug}/split`, { cookie: ed, form: { note: 'not the same after all' } });
        assert.strictEqual(s.status, 303);
        assert.strictEqual((await req(h, 'GET', `/e/${other.slug}`)).status, 200);

        // Rename keeps the old address working.
        const rn = await req(h, 'POST', '/e/widget-3000/edit', { cookie: ed, form: { action: 'details', name: 'Widget 3000', slug: 'widget-3000-classic', kind: 'product', description: '' } });
        assert.strictEqual(rn.status, 303);
        const old = await req(h, 'GET', '/e/widget-3000/history');
        assert.strictEqual(old.status, 301);
        assert.strictEqual(old.headers.get('location'), '/e/widget-3000-classic/history');

        // A reader sends a correction with a form; anonymous people are asked to sign in.
        assert.strictEqual((await req(h, 'GET', '/e/widget-3000-classic/correct')).status, 401);
        const cor = await req(h, 'POST', '/e/widget-3000-classic/correct', { cookie: cookieFor(readerToken()), form: { target_type: 'signal', target_id: sig.id, body: 'That listing is for the older model.' } });
        assert.strictEqual(cor.status, 201);
        assert.strictEqual(h.db.prepare("SELECT COUNT(*) AS n FROM review_corrections WHERE status = 'open'").get().n, 1);
        // Cross-site posts are refused.
        const xs = await req(h, 'POST', '/e/widget-3000-classic/correct', { cookie: cookieFor(readerToken()), headers: { Origin: 'https://evil.example' }, form: { target_type: 'entity', body: 'cross-site attempt here' } });
        assert.strictEqual(xs.status, 403);
    } finally { await h.stop(); }
});
