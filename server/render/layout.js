'use strict';
/**
 * Page shell: every page is server-rendered through openvibe-publishing/layout (openvibe-shared/shell
 * page()). Robots is always explicit (from the indexability gate for entity pages, noindex for
 * editing surfaces); the document carries the SEO head, the app icon, the feed links, the OpenVibe
 * Frame (SSR footer, a <noscript> navigation) plus the Network's navbar.js/footer.js as progressive
 * enhancement.
 * Nothing on the page needs JavaScript to be read, navigated, corrected or edited.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const layout = require('openvibe-publishing/layout');
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
/** The ?v= this process renders for a public/ file (the static route caches only that one as immutable). */
function assetVersion(rel) { asset(rel); return hashes.get(rel); }

// The deployed release (app.js sets it from openvibe-shared/release): openvibe-shared/boost swaps a page in place only
// between pages of the same release, and does a normal load across a deploy.
let RELEASE = 'dev';
function setRelease(id) { if (id) RELEASE = String(id); }

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
        loginUrl: '/auth/login?next={path}',   // filled from the current page (boost moves between pages)
        logoutUrl: '/auth/logout?next={path}',   // Sign out in the shared navbar ends this site's session too
        notificationsRealtime: true,   // the bell hears new notifications over OpenVibe.Events (Shared 1.22.0)
    };
}

/**
 * o: title, description, path (canonical path), canonical (absolute, defaults to the path on this
 * site), robots or decision (the indexability gate's; one is required, there is no default that makes
 * a page indexable), head (extra head HTML), jsonLd [], body, active, actor, config, editor
 */
function renderPage(o) {
    const { config } = o;
    if (!o.robots && !o.decision) throw new TypeError('renderPage needs explicit robots (or the gate decision)');
    const title = o.title ? `${o.title} · ${SITE_NAME}` : SITE_NAME;
    const feeds = [
        { type: 'atom', title: `${SITE_NAME}: published summaries (Atom)`, href: '/feed.atom' },
        { type: 'json', title: `${SITE_NAME}: published summaries (JSON Feed)`, href: '/feed.json' },
    ];
    const actor = o.actor || { kind: 'anonymous' };
    const who = actor.kind === 'user'
        ? `<span class="rv-who">Signed in as ${esc((actor.user && (actor.user.display_name || actor.user.username)) || 'you')}</span>${o.editor ? ' · <a href="/editor">Editor desk</a>' : ''} · <a href="/auth/logout?next=${encodeURIComponent(o.path || '/')}">Sign out</a>`
        : `<a href="/auth/login?next=${encodeURIComponent(o.path || '/')}">Sign in with OpenVibe</a>`;
    return layout.renderDocument({
        site: 'reviews',
        siteName: SITE_NAME,
        lang: 'en',
        title,
        description: o.description || DEFAULT_DESCRIPTION,
        canonical: o.canonical || `${config.baseUrl}${o.path || '/'}`,
        decision: o.decision,
        robots: o.robots,
        type: o.ogType || 'website',
        jsonLd: [].concat(o.jsonLd || []),
        head: o.head,
        feeds,
        iconSite: 'network',
        navbar: navConfig(o, config),
        footer: { service: 'reviews', variant: 'full', mount: '#ov-footer', brandName: SITE_NAME, updates: '/updates' },
        navLinks: LINKS.map((l) => ({ label: l.label, href: l.href })),
        home: '/',
        css: asset('css/reviews.css'),
        release: RELEASE,
        mainClass: 'rv-main',
        header: `<header class="rv-bar"><a class="rv-brand" href="/">${SITE_NAME}</a><form class="rv-search" action="/search" method="get" role="search"><label for="rv-q" class="rv-sr">Search entities</label><input id="rv-q" name="q" type="search" placeholder="Search entities" value="${esc(o.query || '')}"><button type="submit">Search</button></form><noscript><span class="rv-account">${who}</span></noscript></header>`,
        body: o.body,
        shipped: o.path === '/' ? frame.shipped({ service: 'reviews', title: `Recently shipped on ${SITE_NAME}` }) : '',
    });
}

module.exports = { renderPage, asset, assetVersion, setRelease, SITE_NAME, DEFAULT_DESCRIPTION, NETWORK_URL };
