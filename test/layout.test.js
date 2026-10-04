'use strict';
/**
 * The page shell carries what openvibe-shared/boost needs to move between pages in place (plan T11): an
 * <meta name="ov-boost"> release marker on every page and the boost script with data-main="#main"; the shared
 * navbar's sign-in returns to whatever page is showing ({path} is filled per page). The document is
 * openvibe-publishing/layout's (openvibe-shared/shell page()): one title, the canonical and the exact
 * robots the route passed, the JSON-LD, feeds, app icon, stylesheet, the Frame and the footer's init.
 */
const assert = require('assert');
const { boot, req, suite, createEntity, cookieFor, editorToken } = require('./helpers');
const { renderPage } = require('../server/render/layout');

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

const count = (html, re) => (html.match(re) || []).length;

t('a page needs explicit robots: there is no default that makes it indexable', () => {
    assert.throws(() => renderPage({ title: 'x', body: '', config: { baseUrl: 'https://reviews.test' } }), TypeError);
});

t('the document head and frame come from openvibe-publishing/layout, robots exactly as the route passed it', async () => {
    const h = await boot();
    try {
        const e = await createEntity(h, { name: 'Widget 3000', kind: 'product', aliases: [{ type: 'url', value: 'https://shop.example/p/widget' }] });
        const ed = cookieFor(editorToken());
        const pages = [
            [`/e/${e.slug}`, 'noindex, follow', {}],
            ['/about', 'index, follow', {}],
            ['/search?q=widget', 'noindex, follow', {}],
            ['/editor', 'noindex, nofollow', { cookie: ed }],
            [`/e/${e.slug}/correct`, 'noindex, nofollow', { cookie: ed }],
        ];
        for (const [path, robots, opts] of pages) {
            const r = await req(h, 'GET', path, opts);
            assert.strictEqual(r.status, 200, `${path} → ${r.status}`);
            const html = r.text;
            const head = html.slice(0, html.indexOf('</head>'));
            const body = html.slice(html.indexOf('</head>'));
            assert.strictEqual(count(html, /<title>/g), 1, `${path}: exactly one <title>`);
            assert.match(head, /<title>[^<]+ · OpenVibe\.Reviews<\/title>|<title>OpenVibe\.Reviews<\/title>/, `${path}: the composed title`);
            assert.strictEqual(count(head, /<link rel="canonical"/g), 1, `${path}: one canonical`);
            assert.ok(head.includes(`<link rel="canonical" href="http://reviews.test${path.split('?')[0]}">`), `${path}: the canonical`);
            assert.strictEqual(count(head, /<meta name="robots"/g), 1, `${path}: one robots meta`);
            assert.ok(head.includes(`<meta name="robots" content="${robots}">`), `${path}: robots ${robots}`);
            assert.ok(head.includes('<link rel="alternate" type="application/atom+xml" href="/feed.atom" title="OpenVibe.Reviews: published summaries (Atom)">'), `${path}: Atom feed link`);
            assert.ok(head.includes('<link rel="alternate" type="application/feed+json" href="/feed.json" title="OpenVibe.Reviews: published summaries (JSON Feed)">'), `${path}: JSON feed link`);
            assert.match(head, /<link rel="stylesheet" href="\/css\/reviews\.css\?v=[0-9a-f]+">/, `${path}: the reviews stylesheet`);
            assert.match(head, /<meta name="ov-boost" content="reviews@/, `${path}: the boost marker`);
            assert.ok(head.includes('/shared/web-runtime.js'), `${path}: the web runtime`);
            assert.ok(body.includes('<div id="navbar-mount"></div>'), `${path}: the navbar mount`);
            assert.ok(body.includes('<nav aria-label="Site"'), `${path}: the noscript navigation`);
            assert.ok(body.includes('class="rv-bar"'), `${path}: the site header`);
            assert.ok(body.includes('<main id="main" class="rv-main">'), `${path}: the main element`);
            assert.ok(body.includes('id="ov-footer"'), `${path}: the server-rendered footer`);
            assert.ok(body.includes('OpenVibeFooter.init(window.__OV_PAGE.footer)'), `${path}: the footer is initialised`);
        }
        const entity = (await req(h, 'GET', `/e/${e.slug}`)).text;
        assert.strictEqual(count(entity.slice(0, entity.indexOf('</head>')), /<script type="application\/ld\+json">/g), 1, 'the entity page carries its JSON-LD');
        const home = (await req(h, 'GET', '/')).text;
        const homeHead = home.slice(0, home.indexOf('</head>'));
        assert.ok(homeHead.includes('<meta name="robots" content="index, follow">'));
        assert.strictEqual(count(homeHead, /<script type="application\/ld\+json">/g), 1, 'the home page JSON-LD');
        assert.ok(home.includes('Recently shipped on OpenVibe.Reviews'), 'the shipped line stays on the home page');
    } finally { await h.stop(); }
});
