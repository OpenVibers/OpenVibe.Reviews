'use strict';
/**
 * Reviews by OpenVibe members (owner, 2026-10-17: "collect reviews for all kinds of things like glassdoor reviews of
 * employers, yelp, server hosting providers, BBB…"): a signed-in person names what to review (found, or added by them),
 * writes one review of it (1–5 stars, a title, text), rewrites or deletes it; editors remove one with a reason. The
 * page shows the members' numbers beside (never inside) the sources' aggregate, links every other review site for that
 * kind, and the home and /k/<kind> list them.
 */
const assert = require('assert');
const { boot, req, suite, userToken, editorToken, cookieFor, subject, outbox } = require('./helpers');

const t = suite('member-reviews');
const BODY = 'Managers listened, the pay was on time, and the on-call rota was fair. Promotions were slow though.';

t('a member adds an employer, reviews it, rewrites it; others see it; the numbers and the other sites are on the page', async () => {
    const h = await boot();
    try {
        const ana = cookieFor(userToken({ subject: subject(), username: 'ana' }));
        const ben = cookieFor(userToken({ subject: subject(), username: 'ben' }));

        // Signed out: the form asks to sign in, posting adds nothing.
        assert.match((await req(h, 'GET', '/review')).text, /Sign in with OpenVibe to write a review/);
        assert.strictEqual((await req(h, 'POST', '/review', { form: { kind: 'employer', name: 'Acme Corp' } })).status, 401);

        // Added once; the same name (or website) finds it again.
        const add = await req(h, 'POST', '/review', { cookie: ana, form: { kind: 'employer', name: 'Acme Corp', url: 'https://www.acme.example/jobs' } });
        assert.strictEqual(add.status, 303, add.text);
        assert.match(add.headers.get('location'), /^\/e\/acme-corp#write$/);
        assert.strictEqual((await req(h, 'POST', '/review', { cookie: ben, form: { kind: 'employer', name: 'acme corp' } })).headers.get('location'), '/e/acme-corp#write', 'the same name finds it');
        assert.strictEqual((await req(h, 'POST', '/review', { cookie: ben, form: { kind: 'employer', name: 'ACME Corporation', url: 'acme.example' } })).headers.get('location'), '/e/acme-corp#write', 'its website finds it');

        // A local business needs its place; the same name elsewhere is another business.
        assert.strictEqual((await req(h, 'POST', '/review', { cookie: ana, form: { kind: 'restaurant', name: "Joe's Pizza" } })).status, 422);
        const nyc = await req(h, 'POST', '/review', { cookie: ana, form: { kind: 'restaurant', name: "Joe's Pizza", place: 'New York, NY' } });
        const atx = await req(h, 'POST', '/review', { cookie: ana, form: { kind: 'restaurant', name: "Joe's Pizza", place: 'Austin, TX' } });
        assert.notStrictEqual(nyc.headers.get('location'), atx.headers.get('location'));

        // Reviews: validation, then posted; one per person, rewritten in place.
        assert.strictEqual((await req(h, 'POST', '/e/acme-corp/reviews', { cookie: ana, form: { rating: '6', title: 'x', body: BODY } })).status, 422);
        assert.strictEqual((await req(h, 'POST', '/e/acme-corp/reviews', { cookie: ana, form: { rating: '4', title: 'Fine', body: 'too short' } })).status, 422);
        const posted = await req(h, 'POST', '/e/acme-corp/reviews', { cookie: ana, form: { rating: '4', title: 'Solid place to work', body: BODY, relation: 'Former employee' } });
        assert.strictEqual(posted.status, 303, posted.text);
        await req(h, 'POST', '/e/acme-corp/reviews', { cookie: ben, form: { rating: '2', title: 'Burned out', body: 'Constant overtime, and the on-call rota was anything but fair to the night team.' } });
        await req(h, 'POST', '/e/acme-corp/reviews', { cookie: ana, form: { rating: '5', title: 'Solid place to work', body: BODY, relation: 'Former employee' } });

        const page = await req(h, 'GET', '/e/acme-corp');
        assert.strictEqual(page.status, 200);
        assert.match(page.text, /Reviews from OpenVibe members \(2\)/);
        assert.match(page.text, /<span class="rv-big">3\.5<\/span>/, 'average of 5 and 2');
        assert.match(page.text, /Solid place to work/);
        assert.match(page.text, /ana · Former employee/);
        assert.match(page.text, /Sign in to review Acme Corp/, 'a signed-out reader is offered sign-in, not the form');
        // Every other review site for an employer, opening its own search.
        for (const site of ['Glassdoor', 'Indeed', 'Blind', 'Reddit']) assert.ok(page.text.includes(`>${site}</a>`), site);
        assert.match(page.text, /https:\/\/www\.glassdoor\.com\/Search\/results\.htm\?keyword=Acme%20Corp/);
        assert.ok(!/Signals from sources/.test(page.text), 'no empty sources section on a members-only page');
        // JSON-LD carries the members' rating (it is on the page).
        assert.match(page.text, /"ratingValue":\s*3\.5/);

        // Ana sees her own review in the form, and can delete it.
        const mine = await req(h, 'GET', '/e/acme-corp', { cookie: ana });
        assert.match(mine.text, /Update your review/);
        const id = /<article class="rv-mr" id="(mrv_[0-9A-Z]{26})">(?:(?!<\/article>)[\s\S])*Delete my review/.exec(mine.text)[1];
        assert.strictEqual((await req(h, 'POST', `/e/acme-corp/reviews/${id}/remove`, { cookie: ben })).status, 403, 'not someone else\'s');
        assert.strictEqual((await req(h, 'POST', `/e/acme-corp/reviews/${id}/remove`, { cookie: ana })).status, 303);
        assert.match((await req(h, 'GET', '/e/acme-corp')).text, /Reviews from OpenVibe members \(1\)/);

        // An editor removes Ben's with a reason (kept in the audit log, not shown as a review).
        const page2 = await req(h, 'GET', '/e/acme-corp', { cookie: cookieFor(editorToken()) });
        const benId = /id="(mrv_[0-9A-Z]{26})"/.exec(page2.text)[1];
        assert.strictEqual((await req(h, 'POST', `/e/acme-corp/reviews/${benId}/remove`, { cookie: cookieFor(editorToken()), form: { reason: 'Not about this employer' } })).status, 303);
        const audit = await h.db.prepare("SELECT detail FROM review_audit WHERE action = 'member_review.removed' ORDER BY id DESC LIMIT 1").get();
        assert.match(audit.detail, /Not about this employer/);

        // Lists: /k/employer and the home's latest reviews; Search gets the members' line.
        await req(h, 'POST', '/e/acme-corp/reviews', { cookie: ana, form: { rating: '4', title: 'Back, and still good', body: BODY } });
        assert.match((await req(h, 'GET', '/k/employer')).text, /Acme Corp[\s\S]*4 from 1 review/);
        const home = await req(h, 'GET', '/');
        assert.match(home.text, /Latest reviews from members[\s\S]*Back, and still good/);
        assert.match(home.text, /href="\/k\/employer"/);
        const docs = (await outbox(h)).filter((x) => x.event_type === 'reviews.index_document.upserted' && x.payload.id && x.payload.title === 'Acme Corp');
        assert.ok(docs.some((d) => /OpenVibe members: 4 out of 5 from 1 review/.test(d.payload.body || '')), 'the Search document says what members gave it');
        assert.strictEqual((await req(h, 'GET', '/k/nonsense')).status, 404);
    } finally { await h.stop(); }
});
