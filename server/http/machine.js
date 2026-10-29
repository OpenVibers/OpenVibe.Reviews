'use strict';
/**
 * Discovery artifacts (roadmap §32.4). Every list here is built from the indexability gate's
 * decision for each entity page: only indexable pages enter sitemaps; only listable ones enter feeds.
 *
 *   /robots.txt          crawl rules + sitemap location + explicit automated-consumer policy
 *   /sitemap.xml         sitemap index → /sitemaps/pages.xml, /sitemaps/entities-<n>.xml
 *   /feed.atom           published summaries (Atom), /feed.json (JSON Feed 1.1); one entry per published
 *                        revision, so a correction is a new entry that starts with its note
 *   /llms.txt            orientation for language models
 *   /llms-full.txt       the same header plus a short summary of every indexable review page
 */
const express = require('express');
const seo = require('openvibe-publishing/seo');
const sharedSeo = require('openvibe-shared/seo');
const cache = require('openvibe-shared/cache-policy');
const { SITE_SUMMARY } = require('../render/layout');

const PER_SITEMAP = 45000;
const ALL_SUMMARIES = 50000;

/**
 * The public page catalogue: /sitemaps/pages.xml takes the entries marked for the sitemap and
 * /llms-full.txt describes every entry, so the two artifacts cannot drift apart. Dynamic pages
 * (entity pages and /k/:kind) are described by their route pattern; the entity pages themselves
 * are appended from the database below.
 */
const PUBLIC_PAGES = [
    { path: '/', sitemap: true, title: 'OpenVibe.Reviews home', text: 'Review signals from named sources resolved to entities, with provenance for every number; editor-reviewed summaries, members\' reviews, and every other review site in one search.' },
    { path: '/about', sitemap: true, title: 'How it works', text: 'Where the signals come from, how aggregates are computed, what a summary is and how corrections and editor review work.' },
    { path: '/updates', title: 'What shipped on OpenVibe.Reviews', text: 'The shared changelog for OpenVibe.Reviews, newest first.' },
    { path: '/everywhere', title: 'Every review site, one search', text: 'Search an employer, restaurant or other entity across the other review sites OpenVibe.Reviews knows about, without retyping the name.' },
    { path: '/review', title: 'Write a review', text: 'Name what you want to review and write about it on its page; members\' reviews are separate from source signals.' },
    { path: '/e/:slug', title: 'One entity page', text: 'Every signal for one entity (an employer, restaurant, game, product or place), its provenance, member reviews, editor-reviewed summaries and where else to read about it; add .json for the same data as JSON.' },
    { path: '/k/:kind', title: 'Entities of one kind', text: 'Every entity of one kind, the most reviewed by members first.' },
];

/** The legal pages every OpenVibe site serves, named from the shared kit rather than retyped here. */
function legalPages() {
    const labels = { '/terms': 'Terms of use', '/privacy': 'Privacy policy', '/dmca': 'DMCA and takedown policy' };
    return require('openvibe-shared/legal').PATHS.map((path) => ({ path, title: labels[path] || path.slice(1), text: `The ${(labels[path] || path.slice(1)).toLowerCase()} for OpenVibe.Reviews, served by the site itself.` }));
}

function createMachine({ svc, config, releaseLastmod }) {
    const router = express.Router();
    const origin = config.baseUrl;
    const setCache = (res, s = 300) => res.set('Cache-Control', cache.htmlHeaders({ maxAge: s }));

    router.get('/robots.txt', (_req, res) => {
        setCache(res, 3600).type('text/plain').send(seo.robotsTxt({
            sitemaps: [`${origin}/sitemap.xml`],
            disallow: ['/auth/', '/api/', '/internal/', '/editor', '/search', '/e/*/edit', '/e/*/correct'],
        }));
    });

    async function entityEntries() {
        return (await svc.publicEntities()).map(({ entity, decision }) => ({ loc: svc.entityUrl(entity), lastmod: entity.updated_at, decision }));
    }

    router.get('/sitemap.xml', async (_req, res) => {
        const entries = (await entityEntries()).filter((e) => e.decision.indexable);
        const pages = seo.sitemap(entries, { maxUrls: PER_SITEMAP });
        const updated = entries.map((e) => e.lastmod).filter(Boolean);
        const homeLastmod = updated.length ? new Date(Math.max(...updated)).toISOString() : releaseLastmod;
        const pagesLastmod = [homeLastmod, releaseLastmod].filter(Boolean).sort().pop();
        const maps = [{ loc: `${origin}/sitemaps/pages.xml`, lastmod: pagesLastmod }];
        pages.files.forEach((_f, i) => {
            const times = entries.slice(i * PER_SITEMAP, (i + 1) * PER_SITEMAP).map((e) => e.lastmod).filter(Boolean);
            maps.push({ loc: `${origin}/sitemaps/entities-${i + 1}.xml`, lastmod: times.length ? new Date(Math.max(...times)).toISOString() : undefined });
        });
        setCache(res).type('application/xml').send(seo.sitemapIndex(maps));
    });
    router.get('/sitemaps/pages.xml', async (_req, res) => {
        const updated = (await entityEntries()).filter((e) => e.decision.indexable && e.lastmod).map((e) => e.lastmod);
        const homeLastmod = updated.length ? new Date(Math.max(...updated)).toISOString() : releaseLastmod;
        const policy = { minWords: 0, requireSources: false };
        const entries = PUBLIC_PAGES.filter((p) => p.sitemap).map((p) => ({ loc: seo.canonicalUrl(origin, p.path), lastmod: p.path === '/' ? homeLastmod : releaseLastmod, decision: seo.evaluate({ state: 'published', visibility: 'public', canonicalUrl: seo.canonicalUrl(origin, p.path), wordCount: 0 }, { policy, now: Date.now() }) }));
        setCache(res).type('application/xml').send(seo.sitemap(entries).files[0]);
    });
    router.get('/sitemaps/entities-:n.xml', async (req, res) => {
        const files = seo.sitemap(await entityEntries(), { maxUrls: PER_SITEMAP }).files;
        const n = Number(req.params.n);
        if (!Number.isInteger(n) || n < 1 || n > files.length) return res.status(404).type('text/plain').send('Not found');
        setCache(res).type('application/xml').send(files[n - 1]);
    });

    async function feedItems() {
        return (await svc.recentSummaries(50)).map(({ summary, entity, rev, decision }) => ({
            id: `tag:openvibe.reviews,2026:summary/${summary.id}/revision/${summary.published_revision}`,
            url: `${svc.entityUrl(entity)}#summary`,
            title: `${entity.name}: summary`,
            summary: [rev.meta && rev.meta.correction ? `Correction: ${rev.meta.correction.note}` : null, rev.content || '', ...(rev.fields.pros || []).map((p) => `Pro: ${p.text}`), ...(rev.fields.cons || []).map((p) => `Con: ${p.text}`)]
                .filter((x) => x != null).join('\n').slice(0, 1000),
            published: summary.revision_published_at,
            updated: summary.revision_published_at,
            tags: [entity.kind],
            decision,
        }));
    }

    router.get('/feed.atom', async (_req, res) => {
        const items = await feedItems();
        // Every page names this feed, so an empty one is still a valid feed (as News, Trade and Coupons serve): its
        // <updated> is the release's commit time, a real time. Only without one does it answer 404.
        const empty = !items.some((i) => i.decision.listable);
        if (empty && !releaseLastmod) return res.status(404).set('Cache-Control', cache.htmlHeaders({ maxAge: 60 })).type('text/plain').send('No summary has been published yet.');
        setCache(res).type('application/atom+xml').send(seo.atomFeed({ title: 'OpenVibe.Reviews: published summaries', link: `${origin}/`, feedUrl: `${origin}/feed.atom`, id: `${origin}/feed.atom`, ...(empty ? { updated: releaseLastmod } : {}) }, items));
    });
    router.get('/feed.json', async (_req, res) => {
        setCache(res).type('application/feed+json').send(JSON.stringify(seo.jsonFeed({ title: 'OpenVibe.Reviews: published summaries', link: `${origin}/`, feedUrl: `${origin}/feed.json`, description: 'Editor-reviewed summaries, by the time their current revision was published.' }, await feedItems())));
    });

    router.get('/llms.txt', (_req, res) => {
        setCache(res, 3600).type('text/plain').send(sharedSeo.llmsTxt({
            name: 'OpenVibe.Reviews',
            summary: SITE_SUMMARY,
            details: 'Every entity page has a JSON representation at the same address plus ".json" (same content). Each signal names its source item, retrieval time and licence note; the aggregate lists its inputs, exclusions and computation (method reviews-aggregate@1). Summaries never carry a rating; AI-drafted summaries are labelled and published only after a person approves them. Review text is not republished.',
            sections: [
                { title: 'Start here', links: [{ title: 'Entities', url: `${origin}/` }, { title: 'How it works', url: `${origin}/about` }] },
                { title: 'Machine-readable', links: [
                    { title: 'Sitemap', url: `${origin}/sitemap.xml` },
                    { title: 'Published summaries (Atom)', url: `${origin}/feed.atom` },
                    { title: 'Published summaries (JSON Feed)', url: `${origin}/feed.json` },
                ] },
            ],
        }));
    });

    router.get('/llms-full.txt', async (_req, res) => {
        // The /llms.txt header plus a section of only indexable reviews — the same gate the sitemap
        // applies — each as its short summary. Review text is never stored, so no body can appear.
        const reviews = (await svc.recentSummaries(ALL_SUMMARIES)).filter(({ decision }) => decision.indexable).map(({ entity, rev }) => ({
            title: entity.name,
            url: svc.entityUrl(entity),
            text: [rev.content || '', ...(rev.fields.pros || []).map((p) => p.text), ...(rev.fields.cons || []).map((p) => p.text)].join('\n').slice(0, 1000),
        }));
        const pages = [...PUBLIC_PAGES, ...legalPages()].map((p) => ({ url: `${origin}${p.path}`, title: p.title, text: p.text }));
        setCache(res, 3600).type('text/plain').send(sharedSeo.llmsFull({
            site: 'OpenVibe.Reviews',
            summary: SITE_SUMMARY,
            base: origin,
            maxBytes: 512 * 1024,
            sections: [{ title: 'Pages', pages }, { title: 'Reviews', pages: reviews }],
        }));
    });

    return router;
}

module.exports = { createMachine };
