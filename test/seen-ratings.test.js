'use strict';
/**
 * Ratings other review sites show, as members saw them (owner, 2026-10-17: ".reviews doesn't combine stuff from
 * glassdoor…"): a member brings what a Glassdoor/Yelp/BBB… page states (the Companion fills /save in, or they type
 * it), checks it and saves it; the entity page shows it beside that site's link with the date and how many members
 * saw it, never inside the members' or the sources' numbers; one per member, site and entity; the member or an editor
 * takes it down; Search gets a line for it.
 */
const assert = require('assert');
const { boot, req, suite, userToken, editorToken, cookieFor, subject, outbox } = require('./helpers');

const t = suite('seen-ratings');
const GD = 'https://www.glassdoor.com/Reviews/Acme-Corp-Reviews-E12345.htm';

t('a member saves a Glassdoor rating; it shows beside Glassdoor; a later look replaces theirs; removal', async () => {
    const h = await boot();
    try {
        const ana = cookieFor(userToken({ subject: subject(), username: 'ana' }));
        const ben = cookieFor(userToken({ subject: subject(), username: 'ben' }));

        // Signed out: asked to sign in, and the way back keeps the Companion's values.
        const out = await req(h, 'GET', `/save?site=glassdoor&url=${encodeURIComponent(GD)}&name=Acme%20Corp&rating=3.9&best=5&count=1234`);
        assert.strictEqual(out.status, 401);
        assert.match(out.text, /next=%2Fsave%3F[^"]*rating%3D3\.9/);
        assert.strictEqual((await req(h, 'POST', '/save', { form: { name: 'Acme Corp', url: GD, value: '3.9' } })).status, 401);

        // The Companion's link prefills the confirm form, kind from the site (Glassdoor → employer).
        const form = await req(h, 'GET', `/save?url=${encodeURIComponent(GD)}&name=Acme%20Corp&rating=3.9&best=5&count=1%2C234&via=companion`, { cookie: ana });
        assert.strictEqual(form.status, 200);
        assert.match(form.text, /<option value="employer" selected>/);
        assert.match(form.text, /name="value" required value="3\.9"/);
        assert.match(form.text, /name="via" value="companion"/);

        // Only a page on that site, with a rating on its scale.
        assert.strictEqual((await req(h, 'POST', '/save', { cookie: ana, form: { kind: 'employer', name: 'Acme Corp', url: 'https://evil.example/glassdoor.com', value: '3.9', best: '5' } })).status, 422);
        assert.strictEqual((await req(h, 'POST', '/save', { cookie: ana, form: { kind: 'employer', name: 'Acme Corp', url: 'http://www.glassdoor.com/x', value: '3.9', best: '5' } })).status, 422, 'https only');
        assert.strictEqual((await req(h, 'POST', '/save', { cookie: ana, form: { kind: 'employer', name: 'Acme Corp', url: GD, value: '7', best: '5' } })).status, 422);

        const saved = await req(h, 'POST', '/save', { cookie: ana, form: { kind: 'employer', name: 'Acme Corp', url: GD, value: '3.9', best: '5', count: '1,234', via: 'companion' } });
        assert.strictEqual(saved.status, 303, saved.text);
        assert.strictEqual(saved.headers.get('location'), '/e/acme-corp?saved=1#elsewhere');

        let page = await req(h, 'GET', '/e/acme-corp');
        assert.match(page.text, new RegExp(`<a href="${GD.replace(/[.?]/g, '\\$&')}"[^>]*>Glassdoor</a> <span class="rv-seen"><b>3\\.9</b> <span class="rv-muted">out of 5 from 1,234 ratings · seen`));
        assert.ok(!/Reviews from OpenVibe members \(1\)/.test(page.text), 'not counted as a member review');

        // Ben adds a newer look at the same site through the entity's own link; the page shows the latest, from 2 members.
        assert.match((await req(h, 'GET', '/save?entity=acme-corp', { cookie: ben })).text, /For <a href="\/e\/acme-corp"><b>Acme Corp<\/b><\/a>/);
        assert.strictEqual((await req(h, 'POST', '/save', { cookie: ben, form: { entity: 'acme-corp', url: GD, value: '3.8', best: '5', count: '1300' } })).status, 303);
        page = await req(h, 'GET', '/e/acme-corp');
        assert.match(page.text, /<b>3\.8<\/b> <span class="rv-muted">out of 5 from 1,300 ratings · seen [\s\S]*?\(2 members\)/);

        // Ana's later look replaces hers (still one row each).
        assert.strictEqual((await req(h, 'POST', '/save', { cookie: ana, form: { entity: 'acme-corp', url: GD, value: '4.0', best: '5', count: '1310' } })).status, 303);
        assert.strictEqual(Number((await h.db.prepare('SELECT COUNT(*) AS n FROM review_seen_ratings').get()).n), 2);
        assert.match((await req(h, 'GET', '/e/acme-corp')).text, /<b>4<\/b> <span class="rv-muted">out of 5 from 1,310 ratings/);

        // A Yelp page for a restaurant needs its place, like /review.
        const yelp = 'https://www.yelp.com/biz/joes-pizza-new-york';
        assert.strictEqual((await req(h, 'POST', '/save', { cookie: ana, form: { kind: 'restaurant', name: "Joe's Pizza", url: yelp, value: '4.5', best: '5' } })).status, 422);
        assert.strictEqual((await req(h, 'POST', '/save', { cookie: ana, form: { kind: 'restaurant', name: "Joe's Pizza", place: 'New York, NY', url: yelp, value: '4.5', best: '5', count: '9800' } })).status, 303);

        // Search gets a line for it.
        const docs = (await outbox(h)).filter((x) => x.event_type === 'reviews.index_document.upserted' && x.payload.title === 'Acme Corp');
        assert.ok(docs.some((d) => /Glassdoor: 4 out of 5 from 1310 ratings/.test(d.payload.body || '')), 'the Search document carries it');

        // Ana removes hers: Ben's look stays. Ben cannot remove someone else's; an editor can, with a reason.
        const mine = await req(h, 'GET', '/e/acme-corp', { cookie: ana });
        assert.match(mine.text, /<b>4<\/b>[\s\S]*?Remove mine/, 'the latest look is hers, and she can take it down');
        const rows = await h.db.prepare('SELECT id, rating_value::float8 AS v FROM review_seen_ratings ORDER BY seen_at').all();
        const anaRow = rows.find((r) => Number(r.v) === 4);
        const benRow = rows.find((r) => Number(r.v) === 3.8);
        assert.strictEqual((await req(h, 'POST', `/save/${anaRow.id}/remove`, { cookie: ben })).status, 403);
        assert.strictEqual((await req(h, 'POST', `/save/${anaRow.id}/remove`, { cookie: ana })).status, 303);
        assert.match((await req(h, 'GET', '/e/acme-corp', { cookie: ben })).text, /<b>3\.8<\/b>[\s\S]*?Remove mine/);
        assert.strictEqual((await req(h, 'POST', `/save/${benRow.id}/remove`, { cookie: cookieFor(editorToken()), form: { reason: 'Wrong company' } })).status, 303);
        assert.ok(!/rv-seen/.test((await req(h, 'GET', '/e/acme-corp')).text), 'no rating left beside Glassdoor');
        const audit = await h.db.prepare("SELECT detail FROM review_audit WHERE action = 'seen_rating.removed' ORDER BY id DESC LIMIT 1").get();
        assert.match(audit.detail, /Wrong company/);
    } finally { await h.stop(); }
});
