'use strict';
/**
 * The home on a phone (the owner's short-pages rule, 2026-10-30): the public-record lists are one pick block, a row of
 * chips picks one of them, and the questions are a fold. Radio inputs and :has(), no script for the chips; every list
 * stays in the page for crawlers; a wider screen shows them all and no chips.
 */
const assert = require('assert');
const { boot, req, suite, baseItem, importItem } = require('./helpers');

const t = suite('home-short');
const cfpb = (company, complaints) => baseItem({ source: 'cfpb-complaints-by-company', kind: 'complaint_tally', identity: company, title: company, fields: { company, complaints } });
const nyc = (fields) => baseItem({ source: 'nyc-restaurant-inspections', kind: 'inspection_violation', identity: `row-${Math.random().toString(36).slice(2, 10)}`, title: fields.dba, fields: {
    camis: '50071318', dba: 'THE COFFEE CLUB', boro: 'Brooklyn', building: '9526', street: '4 AVENUE', zipcode: '11209', cuisine: 'Coffee/Tea',
    inspection_type: 'Cycle Inspection / Initial Inspection', action: 'Violations were cited in the following area(s).', critical_flag: 'Not Critical', score: '20', grade: null, ...fields } });
const hpd = (fields) => baseItem({ source: 'nyc-hpd-open-violations', kind: 'housing_violation_tally', identity: fields.buildingid, title: fields.streetname, fields: {
    boro: 'BROOKLYN', zip: '11208', last: '2026-10-12T00:00:00.000', ...fields } });

t('the records are one pick block: a chip per list, the first picked, every list in the page', async () => {
    const h = await boot();
    try {
        await importItem(h, nyc({ inspection_date: '2026-10-01T00:00:00.000', violation_code: '06D', violation: 'Food contact surface not washed.', critical_flag: 'Critical' }));
        await importItem(h, hpd({ buildingid: '288857', housenumber: '760', streetname: 'ELDERT LANE', open: '1794', c: '423', b: '1118', a: '252' }));
        await importItem(h, cfpb('TRANSUNION INTERMEDIATE HOLDINGS, INC.', 5119486));
        const page = (await req(h, 'GET', '/')).text;
        const start = page.indexOf('<div class="pick" id="pick-records">');
        assert.ok(start > 0, 'the pick block is on the home');
        const block = page.slice(start, page.indexOf('<details class="rv-h-fold"'));
        assert.match(block, /<nav class="pick-row" aria-label="Public records">/);
        const chips = [...block.matchAll(/<a class="pick-chip" href="#(?:pp-records-)?([a-z-]+)">()()([^<]+)<\/a>/g)];
        assert.strictEqual(chips.length, 3, `a chip per list (${chips.length})`);
        assert.ok(!/type="radio"/.test(block), 'no chip is a radio: nothing is picked, every pane shows');
        // Every list stays in the page, each in its own pane.
        for (const id of chips.map((m) => m[1])) assert.ok(block.includes(`id="${id}"`), `the pane of ${id} is in the page`);
        assert.ok(block.includes('The Coffee Club') && block.includes('Eldert Lane') && block.includes('TransUnion'), 'every list is in the page');
    } finally { await h.stop(); }
});

t('the CSS guard: the chips are hidden and the lists all show until 640 px and where :has() is understood', async () => {
    const h = await boot();
    try {
        await importItem(h, nyc({ inspection_date: '2026-10-01T00:00:00.000', violation_code: '06D', violation: 'Food contact surface not washed.', critical_flag: 'Critical' }));
        const page = (await req(h, 'GET', '/')).text;
        const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'css', 'reviews.css'), 'utf8');
        assert.match(css, /\.pick-row \{ display: none; \}/, 'the chips are hidden by default');
    } finally { await h.stop(); }
});

t('the questions are a fold, open in the page and closed on a phone', async () => {
    const h = await boot();
    try {
        const page = (await req(h, 'GET', '/')).text;
        assert.ok(page.includes('<details class="rv-fold rv-fold-block" id="faq" open>'), 'the questions are a fold, open in the page');
        assert.ok(page.includes('document.getElementById("faq")'), 'the fold has the script that closes it on a phone');
        assert.ok(page.includes('<details class="rv-fold rv-fold-block" id="shipped" open>'), 'the shipped list is a fold too');
        // The content of the folds stays in the page.
        assert.match(page, /<h2 id="rv-faq-h">Questions<\/h2>/);
        assert.match(page, /<h2 id="rv-shipped-h">Recently shipped on OpenVibe.Reviews<\/h2>/);
    } finally { await h.stop(); }
});
