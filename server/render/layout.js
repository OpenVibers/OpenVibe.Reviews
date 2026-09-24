'use strict';
/**
 * Page shell: every page is server-rendered through this. The <head> SEO block comes from
 * openvibe-shared/seo (robots always explicit: from the indexability gate for entity pages,
 * noindex for editing surfaces), the OpenVibe Frame from openvibe-shared (app icon, SSR footer, a
 * <noscript> navigation) plus the Network's navbar.js/footer.js as progressive enhancement.
 * Nothing on the page needs JavaScript to be read, navigated, corrected or edited.
 */
const crypto = require('crypto');
const ovServe = require('openvibe-shared/serve');
const fs = require('fs');
const path = require('path');
const sharedSeo = require('openvibe-shared/seo');
const appIcon = require('openvibe-shared/app-icon');
const frame = require('openvibe-shared/frame');
const { escapeHtml: esc } = require('openvibe-publishing/ssr');

const SITE_NAME = 'OpenVibe.Reviews';
const NETWORK_URL = 'https://openvibe.network';
const DEFAULT_DESCRIPTION = 'OpenVibe.Reviews: review signals gathered from named sources, with provenance for every number and no rating without source data. Part of the OpenVibe network.';
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

const hashes = new Map();
function asset(rel) {
    if (!hashes.has(rel)) {
        let v = 'dev';
        try { v = crypto.createHash('sha256').update(fs.readFileSync(path.join(PUBLIC_DIR, rel))).digest('hex').slice(0, 10); } catch { /* missing asset */ }
        hashes.set(rel, v);
    }
    return `/${rel}?v=${hashes.get(rel)}`;
}

const LINKS = [
    { label: 'Entities', href: '/', key: 'home' },
    { label: 'How it works', href: '/about', key: 'about' },
];

function navConfig(o, config) {
    return {
        service: 'reviews',
        apiBase: NETWORK_URL,
        links: LINKS.map((l) => ({ label: l.label, href: l.href, active: o.active === l.key })),
        history: { type: 'page', title: o.title || SITE_NAME },
        silentLogin: `${config.baseUrl}/auth/login?silent=1&next={url}`,
        sessionUrl: '/auth/me',
        loginUrl: `/auth/login?next=${encodeURIComponent(o.path || '/')}`,
        logoutUrl: '/auth/logout?next={path}',   // Sign out in the shared navbar ends this site's session too
    };
}

/**
 * o: title, description, path (canonical path), robots (required unless head), head (extra head
 * HTML built from the gate), jsonLd, body, active, actor, config, editor
 */
function renderPage(o) {
    const { config } = o;
    if (!o.robots && !o.head) throw new TypeError('renderPage needs explicit robots (or a head block built from the gate)');
    const title = o.title ? `${o.title} · ${SITE_NAME}` : SITE_NAME;
    const head = o.head || sharedSeo.headTags({
        title, description: o.description || DEFAULT_DESCRIPTION, canonical: `${config.baseUrl}${o.path || '/'}`,
        robots: o.robots, siteName: SITE_NAME, type: o.ogType || 'website', jsonLd: o.jsonLd || null,
    });
    const feeds = [
        { type: 'application/atom+xml', title: `${SITE_NAME}: published summaries (Atom)`, href: '/feed.atom' },
        { type: 'application/feed+json', title: `${SITE_NAME}: published summaries (JSON Feed)`, href: '/feed.json' },
    ];
    const actor = o.actor || { kind: 'anonymous' };
    const who = actor.kind === 'user'
        ? `<span class="rv-who">Signed in as ${esc((actor.user && (actor.user.display_name || actor.user.username)) || 'you')}</span>${o.editor ? ' · <a href="/editor">Editor desk</a>' : ''} · <a href="/auth/logout?next=${encodeURIComponent(o.path || '/')}">Sign out</a>`
        : `<a href="/auth/login?next=${encodeURIComponent(o.path || '/')}">Sign in with OpenVibe</a>`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${head}
${appIcon.headTags({ site: 'network' })}
${feeds.map((f) => `<link rel="alternate" type="${f.type}" title="${esc(f.title)}" href="${f.href}">`).join('\n')}
<link rel="stylesheet" href="${asset('css/reviews.css')}">
<script src="${ovServe.url('theme-loader.js')}" defer></script>
<script src="${ovServe.url('navbar.js')}" defer></script>
<script src="${ovServe.url('footer.js')}" defer></script>
</head>
<body>
<a class="rv-skip" href="#main">Skip to content</a>
<div id="navbar-mount"></div>
${frame.noscriptNav({ name: SITE_NAME, home: '/', links: LINKS.map((l) => ({ label: l.label, href: l.href })) })}
<header class="rv-bar"><a class="rv-brand" href="/">${SITE_NAME}</a><form class="rv-search" action="/search" method="get" role="search"><label for="rv-q" class="rv-sr">Search entities</label><input id="rv-q" name="q" type="search" placeholder="Search entities" value="${esc(o.query || '')}"><button type="submit">Search</button></form><noscript><span class="rv-account">${who}</span></noscript></header>
<main id="main" class="rv-main">
${o.body || ''}
${o.path === '/' ? frame.shipped({ service: 'reviews', title: `Recently shipped on ${SITE_NAME}` }) : ''}
</main>
${frame.footer({ service: 'reviews', variant: 'full', updates: '/updates' })}
<script>
window.__OV_PAGE = ${JSON.stringify({ navbar: navConfig(o, config), footer: { service: 'reviews', variant: 'full', mount: '#ov-footer', brandName: SITE_NAME, updates: '/updates' } }).replace(/</g, '\\u003c')};
document.addEventListener('DOMContentLoaded', function () {
  try { if (window.OpenVibeNavbar) OpenVibeNavbar.init(window.__OV_PAGE.navbar); } catch (e) { /* the Frame is optional */ }
  try { if (window.OpenVibeFooter) OpenVibeFooter.init(window.__OV_PAGE.footer); } catch (e) { /* */ }
});
</script>
</body>
</html>`;
}

module.exports = { renderPage, asset, SITE_NAME, DEFAULT_DESCRIPTION, NETWORK_URL };
