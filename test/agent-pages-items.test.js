'use strict';
// The item pages the sitemap lists have Markdown twins (11-03: each named one that answered 404). Only a 200 page whose
// robots tag says index is twinned; an unknown shape, a missing item and a noindex item have none.
const assert = require('assert');
const { createAgentPages } = require('../server/agent-pages');

const page = (robots) => `<!doctype html><html><head><title>T</title><meta name="robots" content="${robots}"></head><body><main><h1>An item</h1></main></body></html>`;
const router = {
    handle(req, res, next) {
        if (req.path === '/e/alice-126-west-13-street-manhattan-ny') return res.send(page('index, follow'));
        if (req.path === '/e/hidden-place') return res.send(page('noindex, follow'));
        if (req.path === '/e/gone') return res.status(404).send(page('noindex'));
        return next();
    },
};

(async () => {
    const { renderPublicPage } = createAgentPages({ router });
    const got = await renderPublicPage('/e/alice-126-west-13-street-manhattan-ny');
    assert.ok(got && /An item/.test(got.html), 'a public item page is twinned');
    assert.strictEqual(await renderPublicPage('/e/hidden-place'), null, 'a noindex item has no twin');
    assert.strictEqual(await renderPublicPage('/e/gone'), null, 'a missing item (404) has no twin');
    assert.strictEqual(await renderPublicPage('/r/abc'), null, 'a shape the sitemap does not list has no twin');
    console.log('agent pages, items: ok');
})().catch((e) => { console.error(e); process.exit(1); });
