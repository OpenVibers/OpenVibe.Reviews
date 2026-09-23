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
 */
const express = require('express');
const seo = require('openvibe-publishing/seo');
const sharedSeo = require('openvibe-shared/seo');

const PER_SITEMAP = 45000;

function createMachine({ svc, config }) {
    const router = express.Router();
    const origin = config.baseUrl;
    const cache = (res, s = 300) => res.set('Cache-Control', `public, max-age=${s}`);

    router.get('/robots.txt', (_req, res) => {
        cache(res, 3600).type('text/plain').send(seo.robotsTxt({
            sitemaps: [`${origin}/sitemap.xml`],
            disallow: ['/auth/', '/api/', '/internal/', '/editor', '/search', '/e/*/edit', '/e/*/correct'],
        }));
    });

    function entityEntries() {
        return svc.publicEntities().map(({ entity, decision }) => ({ loc: svc.entityUrl(entity), lastmod: entity.updated_at, decision }));
    }

    router.get('/sitemap.xml', (_req, res) => {
        const pages = seo.sitemap(entityEntries(), { maxUrls: PER_SITEMAP });
        const maps = [{ loc: `${origin}/sitemaps/pages.xml` }];
        pages.files.forEach((_f, i) => maps.push({ loc: `${origin}/sitemaps/entities-${i + 1}.xml` }));
        cache(res).type('application/xml').send(seo.sitemapIndex(maps));
    });
    router.get('/sitemaps/pages.xml', (_req, res) => {
        const policy = { minWords: 0, requireSources: false };
        const entries = ['/', '/about'].map((p) => ({ loc: seo.canonicalUrl(origin, p), decision: seo.evaluate({ state: 'published', visibility: 'public', canonicalUrl: seo.canonicalUrl(origin, p), wordCount: 0 }, { policy, now: Date.now() }) }));
        cache(res).type('application/xml').send(seo.sitemap(entries).files[0]);
    });
    router.get('/sitemaps/entities-:n.xml', (req, res) => {
        const files = seo.sitemap(entityEntries(), { maxUrls: PER_SITEMAP }).files;
        const n = Number(req.params.n);
        if (!Number.isInteger(n) || n < 1 || n > files.length) return res.status(404).type('text/plain').send('Not found');
        cache(res).type('application/xml').send(files[n - 1]);
    });

    function feedItems() {
        return svc.recentSummaries(50).map(({ summary, entity, rev, decision }) => ({
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

    router.get('/feed.atom', (_req, res) => {
        const items = feedItems();
        if (!items.some((i) => i.decision.listable)) return res.status(404).set('Cache-Control', 'public, max-age=60').type('text/plain').send('No summary has been published yet.');
        cache(res).type('application/atom+xml').send(seo.atomFeed({ title: 'OpenVibe.Reviews: published summaries', link: `${origin}/`, feedUrl: `${origin}/feed.atom`, id: `${origin}/feed.atom` }, items));
    });
    router.get('/feed.json', (_req, res) => {
        cache(res).type('application/feed+json').send(JSON.stringify(seo.jsonFeed({ title: 'OpenVibe.Reviews: published summaries', link: `${origin}/`, feedUrl: `${origin}/feed.json`, description: 'Editor-reviewed summaries, by the time their current revision was published.' }, feedItems())));
    });

    router.get('/llms.txt', (_req, res) => {
        cache(res, 3600).type('text/plain').send(sharedSeo.llmsTxt({
            name: 'OpenVibe.Reviews',
            summary: 'Review signals from named sources (via OpenVibe.Sources) resolved to entities, with provenance for every number, aggregates that exist only when signals do, and editor-reviewed summaries.',
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

    return router;
}

module.exports = { createMachine };
