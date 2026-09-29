'use strict';
/**
 * The page shell carries what openvibe-shared/boost needs to move between pages in place (plan T11): an
 * <meta name="ov-boost"> release marker on every page and the boost script with data-main="#main"; the shared
 * navbar's sign-in returns to whatever page is showing ({path} is filled per page).
 */
const assert = require('assert');
const { boot, req, suite } = require('./helpers');

const t = suite('layout');

t('every rendered page carries the boost marker and the boost script (data-main)', async () => {
    const h = await boot();
    try {
        for (const p of ['/', '/about', '/search']) {
            const r = await req(h, 'GET', p);
            assert.strictEqual(r.status, 200);
            assert.match(r.text, /<meta name="ov-boost" content="reviews@[^"]+">/, `${p}: the release marker`);
            assert.match(r.text, /<script src="\/shared\/boost\.js\?v=[0-9a-f]+" data-main="#main" defer><\/script>/, `${p}: the boost script`);
            assert.match(r.text, /<main id="main"/, `${p}: the swapped element is <main id="main">`);
        }
    } finally { await h.stop(); }
});

t('the shared navbar config uses the {path} sign-in template', async () => {
    const h = await boot();
    try {
        const r = await req(h, 'GET', '/about');
        assert.match(r.text, /"loginUrl":"\/auth\/login\?next=\{path\}"/);
        const page = JSON.parse((r.text.match(/window\.__OV_PAGE = (\{[\s\S]*?\});\n/) || [])[1]);
        assert.strictEqual(page.navbar.loginUrl, '/auth/login?next={path}');
    } finally { await h.stop(); }
});
