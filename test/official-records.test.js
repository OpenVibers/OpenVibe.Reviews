'use strict';
/**
 * Official records (migrations/0007): what a public body published about an entity, from OpenVibe.Sources —
 * the CFPB complaint database's count per company (complaint_tally) and NYC Health's inspection results
 * (inspection_violation, one row per violation), and NYC HPD's open housing-code violations per building
 * (housing_violation_tally). A record finds its entity by its external alias, else by name (and place), else adds it
 * (every NYC restaurant; companies with 500 complaints or more; buildings with 10 or more open class C violations). The page shows them in their own
 * section, never as signals or in the aggregate; Search gets a line; a removed item takes its record away.
 */
const assert = require('assert');
const { boot, req, suite, baseItem, importItem, userToken, cookieFor, subject, outbox } = require('./helpers');

const t = suite('official-records');
const cfpb = (company, complaints, extra = {}) => baseItem({ source: 'cfpb-complaints-by-company', kind: 'complaint_tally', identity: company, title: company, fields: { company, complaints }, ...extra });
const nyc = (fields) => baseItem({ source: 'nyc-restaurant-inspections', kind: 'inspection_violation', identity: `row-${Math.random().toString(36).slice(2, 10)}`, title: fields.dba, fields: {
    camis: '50071318', dba: 'THE COFFEE CLUB', boro: 'Brooklyn', building: '9526', street: '4 AVENUE', zipcode: '11209', cuisine: 'Coffee/Tea',
    inspection_type: 'Cycle Inspection / Initial Inspection', action: 'Violations were cited in the following area(s).', critical_flag: 'Not Critical', score: '20', grade: null, ...fields } });

const hpd = (fields) => baseItem({ source: 'nyc-hpd-open-violations', kind: 'housing_violation_tally', identity: fields.buildingid, title: fields.streetname, fields: {
    boro: 'BROOKLYN', zip: '11208', last: '2026-10-12T00:00:00.000', ...fields } });

t('NYC HPD: a building with open hazardous violations is a landlord page with the counts by class', async () => {
    const h = await boot();
    try {
        const eldert = hpd({ buildingid: '288857', housenumber: '760', streetname: 'ELDERT LANE', open: '1794', c: '423', b: '1118', a: '252' });
        await importItem(h, eldert);
        // Below RECORD_MIN_HAZARDOUS open class C violations, and nobody added the building: nothing is created.
        await importItem(h, hpd({ buildingid: '11', housenumber: '1', streetname: 'QUIET PLACE', open: '12', c: '3', b: '6', a: '3' }));
        const ents = await h.db.prepare("SELECT slug, name, kind, description FROM review_entities WHERE kind = 'landlord'").all();
        assert.deepStrictEqual(ents.map((e) => [e.slug, e.name, e.description]), [['760-eldert-lane-brooklyn-ny', '760 Eldert Lane', 'Brooklyn, NY']]);

        const page = (await req(h, 'GET', '/e/760-eldert-lane-brooklyn-ny')).text;
        assert.match(page, /<span class="rv-big">1,794<\/span> open housing-code violations at 760 Eldert Lane, Brooklyn 11208/);
        assert.match(page, /<b>423<\/b> class C: immediately hazardous<\/li><li><b>1,118<\/b> class B: hazardous<\/li><li><b>252<\/b> class A: non-hazardous/);
        assert.match(page, /href="https:\/\/hpdonline\.nyc\.gov\/hpdonline\/building\/288857"/);
        assert.match(page, /Open means HPD has not recorded the violation as corrected/);
        assert.ok(!/No aggregate/.test(page), 'no empty aggregate section beside the records');

        // A newer week's count replaces the old one; a member's review of the same building lands on the same page.
        await importItem(h, { ...eldert, revision: 2, fields: { ...eldert.fields, open: '1700', c: '400' } });
        assert.match((await req(h, 'GET', '/e/760-eldert-lane-brooklyn-ny')).text, /<span class="rv-big">1,700<\/span> open/);
        const ana = cookieFor(userToken({ subject: subject(), username: 'ana' }));
        const r = await req(h, 'POST', '/review', { cookie: ana, form: { kind: 'landlord', name: '760 Eldert Lane', place: 'Brooklyn, NY' } });
        assert.strictEqual(r.status, 303);
        assert.match(String(r.headers.get('location')), /\/e\/760-eldert-lane-brooklyn-ny#write$/, 'found, not added again');

        // The list and Search say it in a few words.
        assert.match((await req(h, 'GET', '/k/landlord')).text, /760 Eldert Lane[\s\S]*?400 open hazardous HPD violations/);
        const docs = (await outbox(h)).filter((x) => x.event_type === 'reviews.index_document.upserted');
        assert.ok(docs.some((d) => /NYC HPD open housing-code violations: 1700 \(class C immediately hazardous 400, B hazardous 1118, A non-hazardous 252; as of \d{4}-\d{2}-\d{2}, latest inspection 2026-10-12\)/.test(d.payload.body || '')));
    } finally { await h.stop(); }
});

t('a restaurant page with its inspections is indexable on its own; a bare count is not', async () => {
    const h = await boot();
    try {
        // NYC Health's violation texts are the page's own substance (60 words is the gate's floor).
        const cited = [
            ['06D', 'Food contact surface not properly washed, rinsed and sanitized after each use and following any activity when contamination may have occurred.'],
            ['08A', 'Establishment is not free of harborage or conditions conducive to rodents, insects or other pests, including holes, gaps and standing water.'],
            ['02G', 'Cold food item held above 41 degrees Fahrenheit (smoked fish and reduced oxygen packaged foods above 38 degrees) except during necessary preparation.'],
        ];
        await cited.reduce((p, [code, violation]) => p.then(() => importItem(h, nyc({ inspection_date: '2026-10-01T00:00:00.000', violation_code: code, violation, critical_flag: 'Critical' }))), Promise.resolve());
        await importItem(h, cfpb('CAPITAL ONE FINANCIAL CORPORATION', 34100));
        await importItem(h, hpd({ buildingid: '288857', housenumber: '760', streetname: 'ELDERT LANE', open: '1794', c: '423', b: '1118', a: '252' }));
        const index = (await req(h, 'GET', '/sitemap.xml')).text;
        assert.match(index, /\/sitemaps\/entities-1\.xml/);
        const urls = (await req(h, 'GET', '/sitemaps/entities-1.xml')).text;
        assert.match(urls, /\/e\/the-coffee-club-9526-4-avenue-brooklyn-ny</, 'the restaurant, by its inspection');
        assert.ok(!/capital-one/.test(urls) && !/eldert/.test(urls), 'a complaint count or a housing tally alone stays out (thin)');
        assert.ok(!/noindex/.test((await req(h, 'GET', '/e/the-coffee-club-9526-4-avenue-brooklyn-ny')).text), 'and its page says so');
    } finally { await h.stop(); }
});

t('company names read as the companies write them', () => {
    const { recordName } = require('../server/reviews/service');
    assert.strictEqual(recordName('JPMORGAN CHASE & CO.'), 'JPMorgan Chase & Co.');
    assert.strictEqual(recordName('SLM CORPORATION'), 'SLM Corporation');
    assert.strictEqual(recordName('TRANSUNION INTERMEDIATE HOLDINGS, INC.'), 'TransUnion Intermediate Holdings, Inc.');
    assert.strictEqual(recordName('BANK OF AMERICA, NATIONAL ASSOCIATION'), 'Bank of America, National Association');
    assert.strictEqual(recordName("JOE'S PIZZA"), "Joe's Pizza");
    assert.strictEqual(recordName('Experian Information Solutions Inc.'), 'Experian Information Solutions Inc.', 'mixed case stays as written');
});

t('CFPB counts and NYC inspections land on entities, shown as official records, not signals', async () => {
    const h = await boot();
    try {
        // A big company is added with a readable name; a small one with no entity here is left alone.
        await importItem(h, cfpb('CAPITAL ONE FINANCIAL CORPORATION', 34041));
        await importItem(h, cfpb('Small Lender LLC', 3));
        let ents = await h.db.prepare("SELECT slug, name, kind, created_by FROM review_entities ORDER BY created_at").all();
        assert.deepStrictEqual(ents.map((e) => [e.slug, e.name, e.kind, e.created_by]), [['capital-one-financial-corporation', 'Capital One Financial Corporation', 'organization', 'service:reviews']]);

        // A member's entity with the same name gets the record (and the alias), not a second entity.
        const ana = cookieFor(userToken({ subject: subject(), username: 'ana' }));
        await req(h, 'POST', '/review', { cookie: ana, form: { kind: 'employer', name: 'JPMorgan Chase & Co.' } });
        await importItem(h, cfpb('JPMORGAN CHASE & CO.', 26433));
        ents = await h.db.prepare("SELECT slug FROM review_entities ORDER BY created_at").all();
        assert.strictEqual(ents.length, 2, 'matched the member\'s JPMorgan Chase & Co.');

        // A later count replaces the earlier one (a newer revision of the same item).
        const later = cfpb('CAPITAL ONE FINANCIAL CORPORATION', 34100);
        await importItem(h, later);
        const page = await req(h, 'GET', '/e/capital-one-financial-corporation');
        assert.strictEqual(page.status, 200);
        assert.match(page.text, /<h2 id="rec-h">Official records<\/h2>/);
        assert.match(page.text, /<span class="rv-big">34,100<\/span> complaints about CAPITAL ONE FINANCIAL CORPORATION in the Consumer Financial Protection Bureau/);
        assert.match(page.text, /consumerfinance\.gov\/data-research\/consumer-complaints\/search\/\?company=CAPITAL%20ONE%20FINANCIAL%20CORPORATION/);
        assert.match(page.text, /the CFPB does not verify them/);
        assert.ok(!/No aggregate/.test(page.text), 'no empty aggregate section beside the records');
        assert.strictEqual(Number((await h.db.prepare('SELECT COUNT(*) AS n FROM review_signals').get()).n), 0, 'records are never signals');

        // NYC: two violations and a later clean inspection with a grade make one restaurant with two inspections.
        await importItem(h, nyc({ inspection_date: '2026-10-01T00:00:00.000', violation_code: '06D', violation: 'Food contact surface not properly washed.', critical_flag: 'Critical' }));
        await importItem(h, nyc({ inspection_date: '2026-10-01T00:00:00.000', violation_code: '10F', violation: 'Non-food contact surface improperly constructed.' }));
        const clean = nyc({ inspection_date: '2026-10-15T00:00:00.000', inspection_type: 'Cycle Inspection / Re-inspection', action: 'No violations were recorded at the time of this inspection.', score: '7', grade: 'A', critical_flag: 'Not Applicable' });
        await importItem(h, clean);
        const rest = await h.db.prepare("SELECT slug, name, kind, description FROM review_entities WHERE kind = 'restaurant'").all();
        assert.deepStrictEqual(rest.map((e) => [e.slug, e.name, e.description]), [['the-coffee-club-9526-4-avenue-brooklyn-ny', 'The Coffee Club', '9526 4 Avenue, Brooklyn, NY']]);
        const rp = await req(h, 'GET', '/e/the-coffee-club-9526-4-avenue-brooklyn-ny');
        assert.match(rp.text, /NYC Health inspections of The Coffee Club at 9526 4 Avenue, Brooklyn 11209 \(Coffee\/Tea\), newest first/);
        const firstLi = rp.text.indexOf('rv-grade-a'), olderLi = rp.text.indexOf('Food contact surface not properly washed.');
        assert.ok(firstLi > 0 && olderLi > firstLi, 'the newest inspection (grade A) comes first');
        assert.match(rp.text, /<span class="rv-tag rv-critical">Critical<\/span> Food contact surface not properly washed\./);
        assert.match(rp.text, /score 20/);
        assert.match(rp.text, /No violations were recorded at the time of this inspection\./);

        // Two restaurants of one chain in one borough stay two (their own address and inspections each).
        await importItem(h, nyc({ camis: '40000001', dba: 'STARBUCKS', boro: 'Manhattan', building: '38', street: 'PARK ROW', zipcode: '10038', inspection_date: '2026-10-14T00:00:00.000', violation_code: '04N', violation: 'Flies.' }));
        await importItem(h, nyc({ camis: '40000002', dba: 'STARBUCKS', boro: 'Manhattan', building: '1', street: 'BROADWAY', zipcode: '10004', inspection_date: '2026-10-13T00:00:00.000', violation_code: '10F', violation: 'Surface.' }));
        await importItem(h, nyc({ camis: '40000001', dba: 'STARBUCKS', boro: 'Manhattan', building: '38', street: 'PARK ROW', zipcode: '10038', inspection_date: '2026-10-14T00:00:00.000', violation_code: '06C', violation: 'Food not protected.' }));
        const sb = await h.db.prepare("SELECT slug, description FROM review_entities WHERE name = 'Starbucks' ORDER BY slug").all();
        assert.deepStrictEqual(sb.map((e) => e.description), ['1 Broadway, Manhattan, NY', '38 Park Row, Manhattan, NY']);
        const parkRow = (await req(h, 'GET', '/e/starbucks-38-park-row-manhattan-ny')).text;
        assert.ok(parkRow.includes('Flies.') && parkRow.includes('Food not protected.') && !parkRow.includes('Surface.'), 'each keeps its own inspections');

        // Search carries the facts.
        const docs = (await outbox(h)).filter((x) => x.event_type === 'reviews.index_document.upserted');
        assert.ok(docs.some((d) => /CFPB consumer complaints: 34100/.test(d.payload.body || '')));
        assert.ok(docs.some((d) => /NYC Health inspection 2026-10-15: grade A, score 7, 0 violations/.test(d.payload.body || '')));

        // The source removes the clean inspection's row: the page goes back to the older inspection.
        h.sources.put({ ...clean, revision: 2, removed: { at: new Date().toISOString(), reason: 'withdrawn by the city' } });
        assert.strictEqual((await req(h, 'POST', '/api/v1/signals/import', { token: require('./helpers').IMPORT(), body: { source_item_id: clean.id } })).status, 200);
        assert.ok(!/rv-grade-a/.test((await req(h, 'GET', '/e/the-coffee-club-9526-4-avenue-brooklyn-ny')).text));

        // /k/organization and /k/restaurant list them; the home offers both kinds and the new ones.
        // Lists order by members' reviews, then by the records, and say what the record is.
        await importItem(h, cfpb('EQUIFAX, INC.', 1991097));
        const orgs = (await req(h, 'GET', '/k/organization')).text;
        assert.ok(orgs.indexOf('Equifax, Inc.') < orgs.indexOf('Capital One Financial Corporation'), 'more complaints first when nobody reviewed either');
        assert.match(orgs, /Capital One Financial Corporation[\s\S]*?34,100 CFPB complaints/);
        assert.match((await req(h, 'GET', '/k/restaurant')).text, /The Coffee Club[\s\S]*?inspected <time[^>]*>[^<]*<\/time>/);
        const home = (await req(h, 'GET', '/')).text;
        for (const k of ['organization', 'community', 'platform']) assert.ok(home.includes(`href="/k/${k}"`), k);
        assert.strictEqual((await req(h, 'POST', '/review', { cookie: ana, form: { kind: 'community', name: 'r/selfhosted' } })).status, 303, 'a member can review a community');
    } finally { await h.stop(); }
});
