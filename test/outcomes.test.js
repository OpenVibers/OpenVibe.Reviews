'use strict';
/**
 * The market research's outcomes for Reviews (2026-10-30), built 2026-10-31: a method box on every entity page, a
 * verified transaction shown as evidence, a rating with its sample, provenance on every card, the checks we really
 * run (and no detection rate we cannot measure), and sources side by side with their own counts.
 *
 * Outcome 5 (a removal changelog) is not here: the database has no removal changelog table.
 */
const assert = require('assert');
const {
    boot, req, suite, steamItem, productItem, baseItem, importItem, createEntity, userToken, cookieFor, subject,
} = require('./helpers');

const t = suite('outcomes');
const BODY = 'The staff were kind and the work was steady, but the rota changed at the last minute more than once.';

function addSteam(h) {
    h.sources.addSource({ key: 'steam-reviews-portal-2', name: 'Steam user review signals: Portal 2 (app 620)', homepage_url: 'https://store.steampowered.com/app/620/', category: 'reviews' });
}
function addShop(h, key = 'shop-example', name = 'Example shop ratings', url = 'https://shop.example/') {
    h.sources.addSource({ key, name, homepage_url: url, category: 'reviews' });
}
function signal(source, identity, fields) {
    return baseItem({ source, kind: 'review_signal', identity, fields });
}
async function portal(h, aliases = [{ type: 'source', value: 'steam-reviews-portal-2' }]) {
    return await createEntity(h, { name: 'Portal 2', kind: 'game', aliases });
}

t('outcome 1: the method box is on every entity page and names that page\'s own sources', async () => {
    const h = await boot();
    try {
        addSteam(h);
        await importItem(h, steamItem({ votedUp: true }));
        const e = await portal(h);
        const page = (await req(h, 'GET', `/e/${e.slug}`)).text;
        assert.match(page, /<details class="ovk-fold" id="method"/, 'the method box');
        assert.match(page, /How this page(?:&#39;|')s numbers are made/);
        assert.match(page, /Where reviews come from/);
        assert.match(page, /1 source on this page: Steam/, 'the source is the page\'s own');
        assert.match(page, /Members(?:&#39;|') reviews are written here and kept apart/);
        assert.match(page, /How we collect them/);
        assert.match(page, /How long we keep them/);
        assert.match(page, /No deletion window is set/);
        assert.match(page, /How we remove one/);
        assert.match(page, /no invitation or import feed/, 'we say which origins we do not have');
        assert.match(page, /href="\/about#checks"/);

        // An entity with no source at all still publishes the method, and says so rather than borrowing a source.
        const empty = await createEntity(h, { name: 'Nothing Yet', kind: 'other' });
        const emptyPage = (await req(h, 'GET', `/e/${empty.slug}`)).text;
        const box = emptyPage.slice(emptyPage.indexOf('id="method"'), emptyPage.indexOf('</details>', emptyPage.indexOf('id="method"')));
        assert.match(box, /No source has stated anything about this entity yet/);
        assert.ok(!box.includes('Steam'), 'no source is named on a page that has none');

        const about = (await req(h, 'GET', '/about')).text;
        assert.match(about, /<h2 id="retention">Retention and removal<\/h2>/);
        assert.match(about, /No deletion window is set/);
        assert.match(about, /<h2 id="checks">What we check<\/h2>/);
    } finally { await h.stop(); }
});

t('outcome 2: a purchase the source recorded is shown as evidence, never as truth', async () => {
    const h = await boot();
    try {
        addSteam(h);
        await importItem(h, steamItem({ votedUp: true }));   // bought on Steam
        await importItem(h, signal('steam-reviews-portal-2', 'not-bought', { voted_up: true, steam_purchase: false, received_for_free: false }));
        await importItem(h, signal('steam-reviews-portal-2', 'free-copy', { voted_up: true, steam_purchase: true, received_for_free: true }));
        const e = await portal(h);
        const page = (await req(h, 'GET', `/e/${e.slug}`)).text;
        assert.strictEqual((page.match(/Verified purchase · Steam/g) || []).length, 1, 'one verified purchase, not the false or free ones');
        assert.match(page, /Received for free/, 'a free copy is labelled as such, not as a purchase');
        assert.match(page, /not bought on Steam/, 'the source\'s no-purchase record stays a fact');
        assert.match(page, /evidence the reviewer bought it, not that the review is true/);
    } finally { await h.stop(); }
});

t('outcome 3: every rating carries its sample, and the purchases inside the sample are counted', async () => {
    const h = await boot();
    try {
        addSteam(h);
        await importItem(h, steamItem({ votedUp: true }));
        await importItem(h, steamItem({ votedUp: true }));
        await importItem(h, signal('steam-reviews-portal-2', 'nay', { voted_up: false, steam_purchase: false, received_for_free: false }));
        const game = await portal(h);
        const page = (await req(h, 'GET', `/e/${game.slug}`)).text;
        assert.match(page, /<strong>66\.7%<\/strong> recommend, from 3 reviews, 2 of them bought on Steam/);

        addShop(h);
        await importItem(h, productItem({ value: 4.2, best: 5, count: 120, url: 'https://shop.example/p/portal-2' }));
        const product = await createEntity(h, { name: 'Widget 3000', kind: 'product', aliases: [{ type: 'source', value: 'shop-example' }] });
        const shopPage = (await req(h, 'GET', `/e/${product.slug}`)).text;
        assert.match(shopPage, /<strong>4\.2 \/ 5<\/strong> from 120 ratings/);

        // A members' rating carries its own sample too.
        const ana = cookieFor(userToken({ subject: subject(), username: 'ana' }));
        const employer = await createEntity(h, { name: 'Acme Corp', kind: 'employer' });
        assert.strictEqual((await req(h, 'POST', `/e/${employer.slug}/reviews`, { cookie: ana, form: { rating: '4', title: 'Steady', body: BODY } })).status, 303);
        assert.match((await req(h, 'GET', `/e/${employer.slug}`)).text, /from 1 review written here by people with an OpenVibe account/);

        // The front page's score cards keep the count too.
        assert.match((await req(h, 'GET', '/')).text, /120 ratings/);
    } finally { await h.stop(); }
});

t('outcome 4: every card says where the review came from and when', async () => {
    const h = await boot();
    try {
        addSteam(h);
        await importItem(h, steamItem({ votedUp: true }));
        const e = await portal(h);
        const ana = cookieFor(userToken({ subject: subject(), username: 'ana' }));
        assert.strictEqual((await req(h, 'POST', `/e/${e.slug}/reviews`, { cookie: ana, form: { rating: 4, title: 'Still good', body: BODY, relation: 'Played it' } })).status, 303);
        const page = (await req(h, 'GET', `/e/${e.slug}`)).text;
        assert.match(page, /Steam · from a source item itm_[0-9A-Z]+ r1 · read/, 'a source review names its source, item, origin and read time');
        assert.match(page, /<time datetime="2026-09-01T00:00:00.000Z">/, 'the source date is on the row');
        assert.match(page, /<article class="rv-mr" id="mrv_[0-9A-Z]{26}">[\s\S]{0,700}Written here by ana · Played it · /, 'a member review keeps its origin, author, relation and date');
        assert.match((await req(h, 'GET', '/')).text, /Written here by ana · /, 'the home card keeps it too');
    } finally { await h.stop(); }
});

t('outcome 6: the checks we use are published, and the detection rate we do not have is not claimed', async () => {
    const h = await boot();
    try {
        addSteam(h);
        await importItem(h, steamItem({ votedUp: true }));
        const e = await portal(h);
        const page = (await req(h, 'GET', `/e/${e.slug}`)).text;
        assert.match(page, /<strong>What we check<\/strong>/);
        assert.match(page, /The source, item and read time on every signal/);
        assert.match(page, /stated scale and count/);
        assert.match(page, /one tally per source/);
        assert.match(page, /the source&#39;s own purchase record/);
        assert.match(page, /No fake-review detection rate: none is measured, so none is published/);
        assert.match(page, /We do not read review text, IP addresses, devices or writing style/);
        assert.ok(!/\d+(?:\.\d+)?% (?:accuracy|precision|recall)/i.test(page), 'no unmeasured detection rate');

        const about = (await req(h, 'GET', '/about')).text;
        assert.match(about, /We do not score how likely a review is to be fake/);
        assert.match(about, /no measured fake-review detection rate: none is published/);
    } finally { await h.stop(); }
});

t('outcome 7: sources sit side by side, each with its own count', async () => {
    const h = await boot();
    try {
        addSteam(h);
        addShop(h);
        await importItem(h, steamItem({ votedUp: true }));
        await importItem(h, steamItem({ votedUp: false }));
        await importItem(h, productItem({ value: 4.2, best: 5, count: 120, url: 'https://shop.example/p/portal-2' }));
        const e = await portal(h, [{ type: 'source', value: 'steam-reviews-portal-2' }, { type: 'source', value: 'shop-example' }]);
        const page = (await req(h, 'GET', `/e/${e.slug}`)).text;
        assert.match(page, /<h2 id="sources-h">Sources side by side<\/h2>/);
        const start = page.indexOf('<ul class="rv-source-cards">');
        const end = page.indexOf('</ul>', start);
        const cards = page.slice(start, end);
        assert.strictEqual((cards.match(/<li class="rv-source-card">/g) || []).length, 2, 'one card per source');
        const shopAt = cards.indexOf('Example shop ratings');
        const steamAt = cards.indexOf('Steam user review signals');
        assert.ok(shopAt >= 0 && steamAt >= 0, 'both sources are named');
        const shopCard = cards.slice(shopAt, steamAt);
        const steamCard = cards.slice(steamAt);
        assert.match(shopCard, /4\.2 \/ 5<\/span> <span class="rv-muted">from 120 ratings/);
        assert.match(steamCard, /50%<\/span> <span class="rv-muted">recommend from 2 reviews/);
        assert.match(page, /<strong>4\.2 \/ 5<\/strong> from 120 ratings/, 'the aggregate keeps the rating sample');
        assert.match(page, /<strong>50%<\/strong> recommend, from 2 reviews/, 'the aggregate keeps the recommendation sample');
    } finally { await h.stop(); }
});
