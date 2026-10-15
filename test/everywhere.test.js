'use strict';
/**
 * Every review site, one search (server/reviews/everywhere.js, /everywhere): a name and a kind open each review site's
 * own search, in new tabs (the URL forms checked in a real browser on 2026-10-15), with the place for local businesses
 * and landlords; nothing is fetched or stored; a result page is not indexed; the home and the navigation link it.
 */
const assert = require('assert');
const { boot, req, suite } = require('./helpers');
const ew = require('../server/reviews/everywhere');

const t = suite('everywhere');

t('each kind opens the review sites that cover it, with the place where a site takes one', async () => {
    const urls = (q, o) => Object.fromEntries(ew.linksFor(q, o).map((l) => [l.id, l.url]));
    const biz = urls("Joe's Pizza", { kind: 'business', near: 'Portland, OR' });
    assert.deepStrictEqual(Object.keys(biz), ['google', 'yelp', 'tripadvisor', 'bbb', 'reddit']);
    assert.strictEqual(biz.yelp, "https://www.yelp.com/search?find_desc=Joe's%20Pizza&find_loc=Portland%2C%20OR");
    assert.strictEqual(biz.google, "https://www.google.com/maps/search/Joe's+Pizza+Portland%2C+OR");
    const job = urls('Comcast', { kind: 'employer' });
    assert.deepStrictEqual(Object.keys(job), ['glassdoor', 'indeed', 'blind', 'reddit']);
    assert.strictEqual(job.glassdoor, 'https://www.glassdoor.com/Search/results.htm?keyword=Comcast');
    assert.deepStrictEqual(Object.keys(urls('Hetzner', { kind: 'hosting' })), ['trustpilot', 'lowendtalk', 'reddit']);
    assert.deepStrictEqual(Object.keys(urls('Pixel 9', { kind: 'product' })), ['rtings', 'youtube', 'amazon', 'reddit']);
    assert.strictEqual(urls('Pixel 9', { kind: 'product' }).youtube, 'https://www.youtube.com/results?search_query=Pixel+9+review');
    assert.deepStrictEqual(Object.keys(urls('Slack', { kind: 'software' })), ['youtube', 'g2', 'capterra', 'producthunt', 'reddit']);
    assert.deepStrictEqual(ew.linksFor('   '), []);
    assert.deepStrictEqual(Object.keys(urls('x', { kind: 'boats' })), ['google', 'yelp', 'tripadvisor', 'bbb', 'reddit'], 'an unknown kind is a local business');
    ew.KINDS.forEach((k) => ew.linksFor('a & b', { kind: k, near: 'c' }).forEach((l) => assert.match(l.url, /^https:\/\/[a-z0-9.-]+\//, l.url)));
});

t('/everywhere: the sites in new tabs, the kinds, not indexed with a query; linked from the home', async () => {
    const h = await boot();
    try {
        const r = await req(h, 'GET', '/everywhere?q=Comcast&kind=employer');
        assert.strictEqual(r.status, 200, r.text.slice(0, 200));
        assert.ok(r.text.includes('href="https://www.glassdoor.com/Search/results.htm?keyword=Comcast" target="_blank" rel="noopener nofollow"'));
        assert.ok(r.text.includes('noindex'));
        assert.ok(r.text.includes('/everywhere?q=Comcast&amp;kind=hosting'), 'the other kinds keep the name');
        const blank = await req(h, 'GET', '/everywhere');
        assert.ok(blank.status === 200 && !blank.text.includes('glassdoor.com') && blank.text.includes('Every review site, one search'));
        const home = await req(h, 'GET', '/');
        assert.ok(home.text.includes('href="/everywhere"'));
    } finally { await h.stop(); }
});

