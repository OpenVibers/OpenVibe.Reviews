'use strict';
/**
 * The front page: its own title and description, the numbers (pages, official records, review sites), the latest
 * restaurant inspections (that day's violations and critical ones, the newest grade on record), the buildings with
 * the most open class C violations, the companies with the most CFPB complaints, the questions shown and given as
 * FAQPage, WebSite with its search, and links around the site. An empty site leaves the record sections out.
 */
const assert = require('assert');
const { boot, req, suite, baseItem, importItem } = require('./helpers');

const t = suite('home');
const cfpb = (company, complaints) => baseItem({ source: 'cfpb-complaints-by-company', kind: 'complaint_tally', identity: company, title: company, fields: { company, complaints } });
const nyc = (fields) => baseItem({ source: 'nyc-restaurant-inspections', kind: 'inspection_violation', identity: `row-${Math.random().toString(36).slice(2, 10)}`, title: fields.dba, fields: {
    camis: '50071318', dba: 'THE COFFEE CLUB', boro: 'Brooklyn', building: '9526', street: '4 AVENUE', zipcode: '11209', cuisine: 'Coffee/Tea',
    inspection_type: 'Cycle Inspection / Initial Inspection', action: 'Violations were cited in the following area(s).', critical_flag: 'Not Critical', score: '20', grade: null, ...fields } });
const hpd = (fields) => baseItem({ source: 'nyc-hpd-open-violations', kind: 'housing_violation_tally', identity: fields.buildingid, title: fields.streetname, fields: {
    boro: 'BROOKLYN', zip: '11208', last: '2026-10-12T00:00:00.000', ...fields } });
const ld = (text) => [...text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));

t('an empty site: the hero and its numbers, no record sections', async () => {
    const h = await boot();
    try {
        const text = (await req(h, 'GET', '/')).text;
        assert.match(text, /<title>OpenVibe\.Reviews: reviews, ratings and public records<\/title>/);
        const desc = /<meta name="description" content="([^"]*)"/.exec(text)[1];
        assert.ok(desc.length <= 160 && /employers, landlords, restaurants/.test(desc), desc);
        assert.strictEqual((text.match(/<h1\b/g) || []).length, 1);
        assert.match(text, /<dt>Review sites one search opens<\/dt><dd>16<\/dd>/);
        assert.ok(!text.includes('Latest restaurant inspections') && !text.includes('most CFPB complaints') && !text.includes('most hazardous open violations'));
    } finally { await h.stop(); }
});

t('records: the latest inspections, the most hazardous buildings, the most complaints; questions; structured data', async () => {
    const h = await boot();
    try {
        await importItem(h, nyc({ inspection_date: '2026-09-01T00:00:00.000', violation_code: '10F', violation: 'An older visit.', grade: 'A', score: '9' }));
        await importItem(h, nyc({ inspection_date: '2026-10-01T00:00:00.000', violation_code: '06D', violation: 'Food contact surface not washed.', critical_flag: 'Critical' }));
        await importItem(h, nyc({ inspection_date: '2026-10-01T00:00:00.000', violation_code: '10B', violation: 'Plumbing not properly installed.' }));
        await importItem(h, hpd({ buildingid: '288857', housenumber: '760', streetname: 'ELDERT LANE', open: '1794', c: '423', b: '1118', a: '252' }));
        await importItem(h, hpd({ buildingid: '100', housenumber: '765', streetname: 'LINCOLN AVENUE', open: '900', c: '421', b: '300', a: '179' }));
        await importItem(h, cfpb('CAPITAL ONE FINANCIAL CORPORATION', 34100));
        await importItem(h, cfpb('TRANSUNION INTERMEDIATE HOLDINGS, INC.', 5119486));
        const text = (await req(h, 'GET', '/')).text;

        assert.match(text, /<dt>Official records<\/dt><dd>7<\/dd>/);
        const insp = (/<section class="sc-sec" aria-labelledby="rv-insp-h">[\s\S]*?<\/section>/.exec(text) || [''])[0];
        assert.match(insp, /The Coffee Club/i);
        assert.match(insp, /2 violations, <b class="rv-h-crit">1 critical<\/b>/, 'that day\'s violations, not the older visit\'s');
        assert.match(insp, /Latest grade on record: Grade A/);
        assert.match(insp, /Coffee\/Tea · Brooklyn/);

        const hz = (/<section class="sc-sec" aria-labelledby="rv-hpd-h">[\s\S]*?<\/section>/.exec(text) || [''])[0];
        assert.ok(hz.indexOf('760 Eldert Lane') < hz.indexOf('765 Lincoln Avenue'), 'most class C first');
        assert.match(hz, /423 class C · 1,794 open in all/);
        assert.match(hz, /Open means HPD has not recorded a violation as corrected/);

        const cp = (/<section class="sc-sec" aria-labelledby="rv-cfpb-h">[\s\S]*?<\/section>/.exec(text) || [''])[0];
        assert.ok(cp.indexOf('TransUnion Intermediate Holdings, Inc.') < cp.indexOf('Capital One'), 'most complaints first');
        assert.match(cp, /5,119,486 complaints/);
        assert.match(cp, /They are not findings/);

        const blocks = ld(text);
        assert.ok(/\/search\?q=\{search_term_string\}$/.test(blocks.find((b) => b['@type'] === 'WebSite').potentialAction.target.urlTemplate));
        const faq = blocks.find((b) => b['@type'] === 'FAQPage');
        for (const q of faq.mainEntity) assert.ok(text.includes(`<summary>${q.name.replace(/'/g, '&#39;')}</summary>`), q.name);
        ['/review', '/everywhere', '/about', '/k/restaurant', '/k/landlord', '/updates'].forEach((p) => assert.ok(text.includes(`href="${p}"`), p));
    } finally { await h.stop(); }
});
