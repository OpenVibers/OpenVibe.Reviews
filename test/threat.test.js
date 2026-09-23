'use strict';
/**
 * The fixes made in the threat review (docs/threat-review.md): cross-site writes (pages and the
 * cookie-authenticated API), the correction queue's per-person allowance and duplicates, bounded
 * audit text, Vary on the entity JSON, editor ids shown to readers only as "an editor", ratings
 * spelled out in words in AI text, out-of-scale source ratings, rel on reader-sent links, and the
 * public revision note labelled as public.
 */
const assert = require('assert');
const {
    boot, req, suite, steamItem, productItem, importItem, createEntity, cookieFor, editorToken, readerToken, userToken, subject, serviceToken,
    EDITOR,
} = require('./helpers');

const t = suite('threat');
const ORIGIN = 'http://reviews.test';
const count = (h, name) => h.db.prepare('SELECT COUNT(*) AS n FROM review_entities WHERE name = ?').get(name).n;

t('cross-site writes are refused on pages and on the cookie-authenticated API; same-origin and Bearer writes are not', async () => {
    const h = await boot();
    try {
        const e = await createEntity(h, { name: 'Portal 2', kind: 'game' });
        const reader = cookieFor(readerToken());
        const post = (headers, body) => req(h, 'POST', `/e/${e.slug}/correct`, { cookie: reader, headers, form: { target_type: 'entity', body } });
        // A sandboxed frame or data: URL sends Origin: null, but the browser still says cross-site.
        assert.strictEqual((await post({ Origin: 'null', 'Sec-Fetch-Site': 'cross-site' }, 'null origin from another site')).status, 403);
        assert.strictEqual((await post({ 'Sec-Fetch-Site': 'same-site' }, 'a sibling subdomain posting')).status, 403);
        assert.strictEqual((await post({ Origin: 'https://evil.example', 'Sec-Fetch-Site': 'same-origin' }, 'a foreign origin whatever else')).status, 403);
        assert.strictEqual(h.db.prepare('SELECT COUNT(*) AS n FROM review_corrections').get().n, 0);
        assert.strictEqual((await post({ Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin' }, 'a same-origin form post')).status, 201);
        assert.strictEqual((await post({ Origin: 'null' }, 'privacy settings, no fetch metadata')).status, 201);

        const ed = cookieFor(editorToken());
        const api = (name, headers, auth) => req(h, 'POST', '/api/v1/entities', { ...auth, headers, body: { name, kind: 'other' } });
        let r = await api('Via cookie from evil', { Origin: 'https://evil.example' }, { cookie: ed });
        assert.strictEqual(r.status, 403, r.text);
        assert.strictEqual(r.json.code, 'request.cross_site');
        r = await api('Via cookie, cross-site fetch', { 'Sec-Fetch-Site': 'cross-site' }, { cookie: ed });
        assert.strictEqual(r.status, 403, r.text);
        assert.strictEqual(count(h, 'Via cookie from evil') + count(h, 'Via cookie, cross-site fetch'), 0);
        assert.strictEqual((await req(h, 'POST', `/api/v1/entities/${e.slug}/summary/unpublish`, { cookie: ed, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403, 'an empty-body write too');
        assert.strictEqual((await api('Via cookie, same origin', { Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin' }, { cookie: ed })).status, 201);
        assert.strictEqual((await api('Via Bearer', { Origin: 'https://tool.example' }, { token: editorToken() })).status, 201, 'a Bearer token is never ambient');
        assert.strictEqual((await req(h, 'GET', `/api/v1/entities/${e.slug}`, { cookie: ed, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 200, 'reads are not writes');
    } finally { await h.stop(); }
});

t('the correction queue: one open copy of a request, a daily allowance per person, bounded fields', async () => {
    const h = await boot();
    try {
        const e = await createEntity(h, { name: 'Portal 2', kind: 'game' });
        const person = subject();
        const tok = userToken({ subject: person, username: 'busy' });
        const send = (body, extra = {}) => req(h, 'POST', `/api/v1/entities/${e.slug}/corrections`, { token: tok, body: { target_type: 'entity', body, ...extra } });
        assert.strictEqual((await send('The release year shown is wrong.')).status, 201);
        const dup = await send('The release year shown is wrong.');
        assert.strictEqual(dup.status, 409);
        assert.strictEqual(dup.json.code, 'correction.duplicate');
        const huge = await send('A very long target id follows.', { target_id: 'x'.repeat(100000) });
        assert.strictEqual(huge.status, 201);
        assert.strictEqual(huge.json.correction.target_id.length, 100);
        const logged = h.db.prepare("SELECT detail FROM review_audit WHERE action = 'correction.submitted' ORDER BY id DESC").get();
        assert.ok(logged.detail.length < 300, 'the audit row holds the capped id, not the request');
        for (let i = 3; i <= 20; i++) assert.strictEqual((await send(`Correction number ${i} about this entity.`)).status, 201, `#${i}`);
        const over = await send('One more than the daily allowance.');
        assert.strictEqual(over.status, 429);
        assert.strictEqual(over.json.code, 'correction.rate_limited');
        // Someone else is not affected.
        assert.strictEqual((await req(h, 'POST', `/api/v1/entities/${e.slug}/corrections`, { token: readerToken(), body: { target_type: 'entity', body: 'The release year shown is wrong.' } })).status, 201);
        // And the page form says so without JavaScript.
        const page = await req(h, 'POST', `/e/${e.slug}/correct`, { cookie: cookieFor(tok), form: { target_type: 'entity', body: 'Sent from the form after the allowance.' } });
        assert.strictEqual(page.status, 429);
        assert.match(page.text, /At most 20 corrections a day/);
    } finally { await h.stop(); }
});

t('audit text is bounded; readers see "an editor", never an editor\'s id; the entity JSON varies by credentials', async () => {
    const h = await boot();
    try {
        const a = await createEntity(h, { name: 'Widget', kind: 'product' });
        const b = await createEntity(h, { name: 'Widget (old listing)', kind: 'product' });
        const m = await req(h, 'POST', `/api/v1/entities/${b.slug}/merge`, { token: editorToken(), body: { into: a.slug, note: 'n'.repeat(50000) } });
        assert.strictEqual(m.status, 200, m.text);
        const row = h.db.prepare("SELECT detail FROM review_audit WHERE action = 'entity.merged'").get();
        assert.ok(row.detail.length < 3000, `audit detail is ${row.detail.length} characters`);

        const e = await createEntity(h, { name: 'Portal 2', kind: 'game', aliases: [{ type: 'source', value: 'steam-reviews-portal-2' }] });
        for (const v of [true, false]) await importItem(h, steamItem({ votedUp: v }));
        const sigs = h.db.prepare("SELECT id FROM review_signals WHERE status = 'active'").all().map((s) => s.id);
        assert.strictEqual((await req(h, 'POST', `/api/v1/entities/${e.slug}/summary/revisions`, { token: editorToken(), body: { overview: 'Opinion in the sample is split.', overview_signals: sigs, publish: true } })).status, 201);
        for (const path of [`/e/${e.slug}.json`, `/api/v1/entities/${e.slug}`, `/api/v1/entities/${e.slug}/history`, `/api/v1/entities/${e.slug}/summary/revisions/1`, `/e/${e.slug}`, `/e/${e.slug}/history`]) {
            const r = await req(h, 'GET', path);
            assert.strictEqual(r.status, 200, path);
            assert.ok(!r.text.includes(EDITOR), `${path} names the editor`);
        }
        const ed = await req(h, 'GET', `/api/v1/entities/${e.slug}/summary/revisions/1`, { token: editorToken() });
        assert.strictEqual(ed.json.revision.author, EDITOR, 'editors see who wrote it');
        const pub = await req(h, 'GET', `/api/v1/entities/${e.slug}/summary/revisions/1`);
        assert.strictEqual(pub.json.revision.author, 'an editor');
        // The revision note is public (the history lists it): the form says so.
        assert.match((await req(h, 'GET', `/e/${e.slug}/edit`, { cookie: cookieFor(editorToken()) })).text, /Revision note \(public: shown in the summary's history\)/);
        const json = await req(h, 'GET', `/e/${e.slug}.json`);
        assert.match(json.headers.get('vary') || '', /Cookie/);
        assert.match(json.headers.get('vary') || '', /Authorization/);
    } finally { await h.stop(); }
});

t('AI text cannot spell a rating out in words; out-of-scale source ratings are not signals', async () => {
    const h = await boot();
    try {
        const e = await createEntity(h, { name: 'Portal 2', kind: 'game', aliases: [{ type: 'source', value: 'steam-reviews-portal-2' }] });
        for (const v of [true, true]) await importItem(h, steamItem({ votedUp: v }));
        const sigs = h.db.prepare("SELECT id FROM review_signals WHERE status = 'active'").all().map((s) => s.id);
        const AI = serviceToken({ client: 'ai', cap: ['reviews.summary.propose'] });
        const wf = { id: 'reviews.summarize_entity', run_id: 'run_01J9ZZZZZZZZZZZZZZZZZZZZZZ' };
        for (const text of ['Easily four and a half stars.', 'A nine out of ten experience.', 'A five-star puzzle game.']) {
            const r = await req(h, 'POST', `/api/v1/entities/${e.slug}/summary/proposals`, { token: AI, body: { overview: text, overview_signals: sigs, workflow: wf } });
            assert.strictEqual(r.status, 422, text);
            assert.strictEqual(r.json.code, 'summary.rating_in_text', text);
        }
        const fine = await req(h, 'POST', `/api/v1/entities/${e.slug}/summary/proposals`, { token: AI, body: { overview: 'Both of the two sampled reviewers recommend it.', overview_signals: sigs, workflow: wf } });
        assert.strictEqual(fine.status, 201, fine.text);

        await createEntity(h, { name: 'Widget 3000', kind: 'product', aliases: [{ type: 'url', value: 'https://shop.example/p/widget' }, { type: 'url', value: 'https://shop.example/p/widget-b' }] });
        const negative = productItem({ value: -4, best: 5, count: 50 });
        const low = productItem({ value: 0.5, best: 5, count: 50, url: 'https://shop.example/p/widget-b' });
        low.fields.aggregate_rating.worst = 1;
        for (const [it, re] of [[negative, /below zero/], [low, /worst 1/]]) {
            const out = await importItem(h, it);
            assert.strictEqual(out.signal, null, JSON.stringify(out));
            assert.strictEqual(out.item.resolution, 'resolved');
            assert.match(out.item.signal_note, re);
        }
        const agg = await req(h, 'GET', '/api/v1/entities/widget-3000/aggregate');
        assert.strictEqual(agg.json.aggregate, null);
    } finally { await h.stop(); }
});

t('a reader-sent evidence link is nofollow ugc noreferrer on the editor desk', async () => {
    const h = await boot();
    try {
        const e = await createEntity(h, { name: 'Portal 2', kind: 'game' });
        await req(h, 'POST', `/api/v1/entities/${e.slug}/corrections`, { token: readerToken(), body: { target_type: 'entity', body: 'See the official page for the year.', evidence_url: 'https://example.org/proof' } });
        await req(h, 'POST', `/api/v1/entities/${e.slug}/corrections`, { token: readerToken(), body: { target_type: 'entity', body: 'A script link as evidence here.', evidence_url: 'javascript:alert(1)' } }).then((r) => assert.strictEqual(r.status, 422));
        const desk = await req(h, 'GET', '/editor', { cookie: cookieFor(editorToken()) });
        assert.match(desk.text, /<a href="https:\/\/example\.org\/proof" rel="nofollow ugc noopener noreferrer">evidence<\/a>/);
        assert.ok(!desk.text.includes('javascript:'));
    } finally { await h.stop(); }
});
