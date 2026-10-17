'use strict';
/**
 * Official records (migrations/0007): what a public body published about an entity, from OpenVibe.Sources —
 * the CFPB complaint database's count per company (complaint_tally) and NYC Health's inspection results
 * (inspection_violation, one row per violation). A record finds its entity by its external alias, else by name (and
 * place), else adds it (every NYC restaurant; companies with 500 complaints or more). The page shows them in their own
 * section, never as signals or in the aggregate; Search gets a line; a removed item takes its record away.
 */
const assert = require('assert');
const { boot, req, suite, baseItem, importItem, userToken, cookieFor, subject, outbox } = require('./helpers');

const t = suite('official-records');
const cfpb = (company, complaints, extra = {}) => baseItem({ source: 'cfpb-complaints-by-company', kind: 'complaint_tally', identity: company, title: company, fields: { company, complaints }, ...extra });
const nyc = (fields) => baseItem({ source: 'nyc-restaurant-inspections', kind: 'inspection_violation', identity: `row-${Math.random().toString(36).slice(2, 10)}`, title: fields.dba, fields: {
    camis: '50071318', dba: 'THE COFFEE CLUB', boro: 'Brooklyn', building: '9526', street: '4 AVENUE', zipcode: '11209', cuisine: 'Coffee/Tea',
    inspection_type: 'Cycle Inspection / Initial Inspection', action: 'Violations were cited in the following area(s).', critical_flag: 'Not Critical', score: '20', grade: null, ...fields } });

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
        assert.deepStrictEqual(rest.map((e) => [e.slug, e.name, e.description]), [['the-coffee-club-brooklyn-ny', 'The Coffee Club', 'Brooklyn, NY']]);
        const rp = await req(h, 'GET', '/e/the-coffee-club-brooklyn-ny');
        assert.match(rp.text, /NYC Health inspections of The Coffee Club at 9526 4 AVENUE, Brooklyn 11209 \(Coffee\/Tea\), newest first/);
        const firstLi = rp.text.indexOf('rv-grade-a'), olderLi = rp.text.indexOf('Food contact surface not properly washed.');
        assert.ok(firstLi > 0 && olderLi > firstLi, 'the newest inspection (grade A) comes first');
        assert.match(rp.text, /<span class="rv-tag rv-critical">Critical<\/span> Food contact surface not properly washed\./);
        assert.match(rp.text, /score 20/);
        assert.match(rp.text, /No violations were recorded at the time of this inspection\./);

        // Search carries the facts.
        const docs = (await outbox(h)).filter((x) => x.event_type === 'reviews.index_document.upserted');
        assert.ok(docs.some((d) => /CFPB consumer complaints: 34100/.test(d.payload.body || '')));
        assert.ok(docs.some((d) => /NYC Health inspection 2026-10-15: grade A, score 7, 0 violations/.test(d.payload.body || '')));

        // The source removes the clean inspection's row: the page goes back to the older inspection.
        h.sources.put({ ...clean, revision: 2, removed: { at: new Date().toISOString(), reason: 'withdrawn by the city' } });
        assert.strictEqual((await req(h, 'POST', '/api/v1/signals/import', { token: require('./helpers').IMPORT(), body: { source_item_id: clean.id } })).status, 200);
        assert.ok(!/rv-grade-a/.test((await req(h, 'GET', '/e/the-coffee-club-brooklyn-ny')).text));

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
