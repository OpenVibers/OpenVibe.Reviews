'use strict';
// Static assets (WS-P task 10): a ?v= URL is cached for a year only when ?v= is the hash of the bytes
// served. An older page's URL after a deploy or a rollback, or any other ?v=, gets the current file
// with a short cache, so no cache can pin the wrong bytes under that URL.
const assert = require('assert');
const { boot } = require('./helpers');
const { assetVersion } = require('../server/render/layout');

(async () => {
    const h = await boot();
    try {
        const v = assetVersion('css/reviews.css');
        assert.match(v, /^[0-9a-f]{10}$/);
        let r = await fetch(`${h.base}/css/reviews.css?v=${v}`);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=31536000, immutable', 'the current hash is immutable');
        r = await fetch(`${h.base}/css/reviews.css?v=0123456789`);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=300', 'another ?v= is never pinned');
        r = await fetch(`${h.base}/css/reviews.css`);
        assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=300');
        console.log('asset cache: all checks passed');
    } finally { await h.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
