'use strict';
const showcase = require('openvibe-shared/showcase');
/**
 * Server-rendered pages. Everything a reader or an editor does works with plain links and HTML
 * form posts; the shared navbar is progressive enhancement.
 *
 *   GET  /                              entities with source data
 *   GET  /about                         how signals, the aggregate and summaries work
 *   GET  /search?q=
 *   GET  /e/:slug                       entity page: aggregate with inputs, summary, signals with provenance, discussion
 *   GET  /e/:slug.json                  the same data as JSON
 *   GET  /e/:slug/history               aggregate revisions, summary revisions, merges and splits, every signal, editorial log
 *   GET  /e/:slug/summary/:n            one summary revision (editors: approve / reject); corrections carry their note
 *   GET|POST /e/:slug/correct           a signed-in person sends a correction to the editors
 *   POST /e/:slug/discuss               comment through OpenVibe.Community
 *   Editors: GET /editor, POST /editor/sync, GET|POST /editor/entities/new, GET|POST /e/:slug/edit,
 *            POST /e/:slug/summary, POST /e/:slug/summary/:n/review, POST /e/:slug/merge,
 *            POST /e/:slug/split, GET|POST /editor/items/:id, POST /editor/corrections/:id
 *
 * Caching: an anonymous view of a public page is `public, max-age=60`; everything else is
 * `private, no-store`. A merged entity answers 301 to the entity it was merged into; a deleted
 * one 410; an old slug 301 to the current one.
 */
const express = require('express');
const ovServe = require('openvibe-shared/serve');
const cache = require('openvibe-shared/cache-policy');
const frame = require('openvibe-shared/frame');
const seo = require('openvibe-publishing/seo');
const { renderPage, SITE_SUMMARY } = require('../render/layout');
const views = require('../render/views');
const { ratingForStructuredData } = require('../reviews/aggregate');
const { actorMiddleware, crossSite } = require('./common');

const SCHEMA_TYPE = { product: 'Product', game: 'VideoGame', software: 'SoftwareApplication', service: 'Service', place: 'Place', organization: 'Organization', media: 'CreativeWork', other: 'Thing',
    employer: 'Organization', landlord: 'Organization', restaurant: 'Restaurant', business: 'LocalBusiness', hosting: 'Organization', app: 'SoftwareApplication', vehicle: 'Product' };

/**
 * JSON-LD for an entity page. Product / Thing with an AggregateRating, and a Review for the
 * summary, exist ONLY when the aggregate exists — i.e. when real signals back it. Without
 * signals the page carries breadcrumbs and nothing that could be read as a rating.
 */
function structuredData(p, config, members = null) {
    const en = p.entity;
    const origin = config.baseUrl;
    const out = [seo.structuredData.breadcrumbs([{ name: 'OpenVibe.Reviews', url: `${origin}/` }, { name: en.name, url: en.url }])];
    // The sources' aggregate, else the members' own reviews shown on the page (1–5 stars, their real count).
    const rating = ratingForStructuredData(p.aggregate && p.aggregate.result)
        || (members && members.stats.count ? { value: members.stats.average, best: 5, worst: 1, count: members.stats.count } : null);
    if (!rating) return out;
    const type = SCHEMA_TYPE[en.kind] || 'Thing';
    out.push(type === 'Product'
        ? seo.structuredData.product({ name: en.name, url: en.url, description: en.description, aggregateRating: rating })
        : seo.structuredData.ratedThing({ type, name: en.name, url: en.url, description: en.description, aggregateRating: rating }));
    const pub = p.summary && p.summary.published;
    if (pub && pub.points.some((x) => x.supported)) {
        const text = [pub.overview || '', ...pub.points.filter((x) => x.kind !== 'overview').map((x) => `${x.kind === 'pro' ? 'Pro' : 'Con'}: ${x.text}`)].join('\n').trim();
        const review = seo.structuredData.review({
            url: `${en.url}#summary`, itemReviewed: { type, name: en.name, url: en.url },
            author: { type: 'Organization', name: 'OpenVibe.Reviews editors', url: `${origin}/about` },
            datePublished: p.summary.published_at || p.summary.revision_published_at, body: text.slice(0, 5000),
            publisher: { name: 'OpenVibe', url: 'https://openvibe.network' },
        });
        // A later revision (an update or a correction) is the same review, modified.
        if (review && p.summary.published_at && p.summary.revision_published_at !== p.summary.published_at) review.dateModified = p.summary.revision_published_at;
        out.push(review);
    }
    return out.filter(Boolean);
}

function list(v) { return v == null ? [] : (Array.isArray(v) ? v : [v]).map(String).filter(Boolean); }

/** The no-JS summary form → the summary input shape. */
function summaryFromForm(b) {
    const points = (kind) => {
        const out = [];
        for (let i = 0; i < 12; i++) {
            const text = String(b[`${kind}_text_${i}`] || '').trim();
            if (!text) continue;
            out.push({ text, signals: list(b[`${kind}_signals_${i}`]) });
        }
        return out;
    };
    return {
        overview: String(b.overview || ''), overview_signals: list(b.overview_signals),
        pros: points('pro'), cons: points('con'),
        expected_revision: b.expected_revision != null && b.expected_revision !== '' ? Number(b.expected_revision) : undefined,
        message: b.message || null, publish: b.publish === '1',
        correction_note: b.correction_note || null, correction_id: b.correction_id || null,
    };
}

function createPages({ svc, platform, sync, viewers, config, log = console, limits }) {
    const router = express.Router();
    const form = express.urlencoded({ extended: false, limit: '200kb' });
    router.use(actorMiddleware(viewers, { services: false }));

    const origin = new URL(config.baseUrl).origin;
    // Cross-site form posts are refused (the session cookie is SameSite=Lax as well).
    router.use((req, res, next) => {
        if (req.method !== 'POST' || !crossSite(req, origin)) return next();
        res.status(403).type('text/plain').set('Cache-Control', cache.htmlHeaders({ private: true })).send('Cross-site form posts are not accepted.');
    });

    // Per-actor limits (http/actor-limits.js): each form names its budget, shared with the API route
    // that does the same thing, counted for a signed-in person before the form is read.
    const F = (name) => limits.form(name);

    const send = (req, res, status, body, o = {}) => {
        const cacheable = o.cache === 'public' && req.actor.kind === 'anonymous' && status === 200;
        res.status(status).set('Cache-Control', cacheable ? cache.htmlHeaders({ maxAge: 60 }) : cache.htmlHeaders({ private: true })).set('Vary', 'Cookie, Authorization').type('html')
            .send(renderPage({ config, actor: req.actor, path: o.path || req.path, editor: svc.access.isEditor(req.actor), ...o, body }));
    };
    const errorPage = (req, res, status, title, message) => send(req, res, status, views.errorBody({ status, title, message }), { title, robots: 'noindex, nofollow' });
    const notFound = (req, res) => errorPage(req, res, 404, 'Not found', 'Nothing lives at that address.');
    const gone = (req, res) => errorPage(req, res, 410, 'Gone', 'This entity was deleted. Its history is kept, but it is no longer published.');
    const needSignIn = (req, res, message) => send(req, res, 401, views.signInPage({ next: req.originalUrl, message }), { title: 'Sign in', robots: 'noindex, nofollow' });
    const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => {
        if (err && err.status && err.status < 500) return errorPage(req, res, err.status, 'That did not work', err.message);
        next(err);
    });
    const isEditor = (req) => svc.access.isEditor(req.actor);
    const editorOnly = (req, res) => {
        if (!req.actor.subject) { needSignIn(req, res, 'Sign in with your OpenVibe account. The editor desk is for Reviews editors.'); return false; }
        if (!isEditor(req)) { errorPage(req, res, 403, 'Editors only', 'This page is for OpenVibe.Reviews editors.'); return false; }
        return true;
    };

    /** :slug → an active entity, or the right redirect / 410 / 404. */
    async function locate(req, res, suffix = '') {
        const slug = req.params.slug;
        const e = await svc.findEntity(slug);
        const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
        if (!e) {
            const r = await svc.resolveRedirect(`/e/${slug}`);
            if (r && r.status === 301) { res.set('Cache-Control', cache.htmlHeaders({ maxAge: 300 })).redirect(301, r.location + suffix + query); return null; }
            if (r && r.status === 410) { gone(req, res); return null; }
            notFound(req, res);
            return null;
        }
        if (e.state === 'deleted') { gone(req, res); return null; }
        if (e.state === 'merged') {
            const c = await svc.entityById(await svc.canonicalOf(e.id));
            res.set('Cache-Control', cache.htmlHeaders({ maxAge: 60 })).redirect(301, `${svc.entityPath(c)}${suffix}${query}`);
            return null;
        }
        return e;
    }

    // ── Public ───────────────────────────────────────────────
    router.get('/', async (req, res) => {
        const all = await svc.listEntities({ limit: 1 });
        send(req, res, 200, views.home({ entities: await svc.entitiesWithData(60), total: all.total, editor: isEditor(req), recent: await svc.recentMemberReviews(6), kinds: await svc.kindCounts() }), {
            robots: 'index, follow', cache: 'public', active: 'home', path: '/', summary: SITE_SUMMARY, styles: [showcase.STYLESHEET],
            jsonLd: seo.structuredData.webPage({ url: `${config.baseUrl}/`, name: 'OpenVibe.Reviews', description: 'Review signals from named sources, with provenance and honest aggregates.' }),
        });
    });
    // What shipped on OpenVibe.Reviews: the shared update log every OpenVibe site has.
    router.get('/updates', (req, res) => send(req, res, 200, frame.updatesBody({ service: 'reviews', siteName: 'OpenVibe.Reviews' }) + `<script src="${ovServe.url('shipped.js')}" defer></script>`, { title: 'What shipped on OpenVibe.Reviews', robots: 'index, follow', cache: 'public', path: '/updates' }));
    router.get('/everywhere', (req, res) => {
        const ew = require('../reviews/everywhere');
        const q = ew.clean(req.query.q, 120);
        const kind = ew.KINDS.includes(String(req.query.kind)) ? String(req.query.kind) : 'business';
        const near = ew.clean(req.query.near, 80);
        send(req, res, 200, views.everywherePage({ q, kind, near, links: ew.linksFor(q, { kind, near }), KINDS: ew.KINDS, KIND_TEXT: ew.KIND_TEXT }), {
            title: q ? `“${q}” on every review site` : 'Every review site, one search', robots: q ? 'noindex, follow' : 'index, follow', cache: 'public', active: 'everywhere', localStyles: ['css/everywhere.css'],
        });
    });
    // ── Members' reviews ─────────────────────────────────────
    // /review: name what you want to review (found, or added by you), then write about it on its page.
    router.get('/review', (req, res) => {
        const kind = svc.MEMBER_KINDS.includes(String(req.query.kind)) ? String(req.query.kind) : 'employer';
        send(req, res, 200, views.reviewStartPage({ values: { kind, name: String(req.query.name || '').slice(0, 200) }, kinds: svc.MEMBER_KINDS, local: [...svc.LOCAL_KINDS], actor: req.actor }), {
            title: 'Write a review', robots: 'index, follow', cache: req.actor.kind === 'anonymous' ? 'public' : null, active: 'review',
        });
    });
    router.post('/review', F('reviews.entity.suggest'), form, wrap(async (req, res) => {
        if (!req.actor.subject) return needSignIn(req, res, 'Sign in with your OpenVibe account to write a review.');
        const b = req.body || {};
        try {
            const { entity } = await svc.memberEntity({ kind: b.kind, name: b.name, place: b.place, url: b.url }, req.actor);
            res.redirect(303, `${svc.entityPath(entity)}#write`);
        } catch (err) {
            if (!err.status || err.status >= 500) throw err;
            send(req, res, err.status, views.reviewStartPage({ values: b, kinds: svc.MEMBER_KINDS, local: [...svc.LOCAL_KINDS], actor: req.actor, error: err.message }), { title: 'Write a review', robots: 'noindex, nofollow' });
        }
    }));
    router.post('/e/:slug/reviews', F('reviews.review.write'), form, wrap(async (req, res) => {
        const e = await locate(req, res, '/reviews');
        if (!e) return;
        if (!req.actor.subject) return needSignIn(req, res, 'Sign in with your OpenVibe account to write a review.');
        const b = req.body || {};
        try {
            await svc.writeMemberReview(e.id, { rating: b.rating, title: b.title, body: b.body, relation: b.relation }, req.actor);
            res.redirect(303, `${svc.entityPath(e)}?saved=1#member-reviews`);
        } catch (err) {
            if (!err.status || err.status >= 500) throw err;
            await sendEntity(req, res, e, { status: err.status, reviewError: err.message, reviewValues: b });
        }
    }));
    router.post('/e/:slug/reviews/:id/remove', F('reviews.review.write'), form, wrap(async (req, res) => {
        const e = await locate(req, res, `/reviews/${req.params.id}/remove`);
        if (!e) return;
        if (!req.actor.subject) return needSignIn(req, res, 'Sign in with your OpenVibe account.');
        await svc.removeMemberReview(req.params.id, req.actor, (req.body || {}).reason);
        res.redirect(303, `${svc.entityPath(e)}#member-reviews`);
    }));
    // /k/employer, /k/restaurant…: everything of one kind, the most reviewed by members first.
    router.get('/k/:kind', wrap(async (req, res) => {
        const kind = String(req.params.kind);
        if (!svc.MEMBER_KINDS.includes(kind)) return errorPage(req, res, 404, 'Not found', 'There is no such kind.');
        const page = Math.max(1, Math.min(200, parseInt(req.query.page, 10) || 1));
        const data = await svc.entitiesOfKind(kind, { limit: 60, offset: (page - 1) * 60 });
        send(req, res, 200, views.kindPage({ kind, page, ...data }), {
            title: views.KIND_PLURAL[kind], robots: data.total ? 'index, follow' : 'noindex, follow', cache: 'public', path: `/k/${kind}`,
        });
    }));
    router.get('/about', (req, res) => send(req, res, 200, views.aboutPage(), { title: 'How it works', robots: 'index, follow', cache: 'public', active: 'about' }));
    router.get('/search', async (req, res) => {
        const query = String(req.query.q || '').slice(0, 200);
        send(req, res, 200, views.searchPage({ query, results: query ? await svc.search(query) : [] }), { title: query ? `Search: ${query}` : 'Search', robots: 'noindex, follow', query });
    });

    router.get('/e/:slug.json', async (req, res) => {
        const e = await locate(req, res, '.json');
        if (!e) return;
        const p = await svc.page(e, req.actor);
        res.status(200).set('Cache-Control', req.actor.kind === 'anonymous' ? cache.htmlHeaders({ maxAge: 60 }) : cache.htmlHeaders({ private: true })).set('Vary', 'Cookie, Authorization').set('X-Robots-Tag', p.decision.robots)
            .json({ ...p, decision: { indexable: p.decision.indexable, robots: p.decision.robots, reasons: p.decision.codes } });
    });

    async function discussionFor(e, actor) {
        if (!platform.community.configured) return { state: 'unavailable', reason: 'OpenVibe.Community is not configured on this server' };
        const threadId = await svc.knownThread(e.id);
        if (!threadId) return { state: 'none' };
        try {
            const data = await platform.community.getThread(threadId, { subject: actor.subject });
            return { state: 'ok', threadId, thread: data.thread, comments: data.comments || [] };
        } catch (err) {
            return { state: 'unavailable', reason: err.code === 'thread.not_found' ? 'the thread was removed' : null };
        }
    }

    // The entity page: source signals, the members' reviews (with the viewer's own form) and where else to read about it.
    async function sendEntity(req, res, e, { status = 200, reviewError = null, reviewValues = null } = {}) {
        const p = await svc.page(e, req.actor);
        const discussion = await discussionFor(e, req.actor);
        const members = await svc.memberReviews(e, req.actor);
        const elsewhere = views.elsewhereLinks(e);
        const signedIn = !!req.actor.subject;
        send(req, res, status, views.entityPage(p, { discussion, actor: req.actor, flash: req.query.saved ? 'Saved.' : null, members, elsewhere, reviewError, reviewValues }), {
            decision: p.decision, title: e.name, cache: discussion.state === 'ok' || signedIn ? null : 'public', path: svc.entityPath(e),
            description: e.description && !svc.LOCAL_KINDS.has(e.kind) ? e.description
                : `${e.name}${e.description ? ` (${e.description})` : ''}: ${members.stats.count ? `${members.stats.average} out of 5 from ${members.stats.count} OpenVibe member review${members.stats.count === 1 ? '' : 's'}, ` : ''}review signals${p.sources.length ? ` from ${p.sources.map((s) => s.name || s.key).join(', ')}` : ''}, and every other review site in one place.`,
            canonical: p.entity.url, jsonLd: structuredData(p, config, members),
        });
    }
    router.get('/e/:slug', wrap(async (req, res) => {
        const e = await locate(req, res);
        if (!e) return;
        await sendEntity(req, res, e);
    }));

    router.get('/e/:slug/history', async (req, res) => {
        const e = await locate(req, res, '/history');
        if (!e) return;
        send(req, res, 200, views.historyPage(await svc.history(e, req.actor)), { title: `History of ${e.name}`, robots: 'noindex, follow', cache: 'public' });
    });

    router.get('/e/:slug/summary/:n', wrap(async (req, res) => {
        const e = await locate(req, res, `/summary/${req.params.n}`);
        if (!e) return;
        const r = await svc.summaryRevision(e, req.params.n, req.actor);
        send(req, res, 200, views.summaryRevisionPage(await svc.entityView(e), r, { editor: isEditor(req) }), { title: `${e.name}: summary revision ${r.number}`, robots: 'noindex, follow' });
    }));

    router.get('/e/:slug/correct', async (req, res) => {
        const e = await locate(req, res, '/correct');
        if (!e) return;
        if (!req.actor.subject) return needSignIn(req, res, 'Sign in with your OpenVibe account to send a correction to the editors.');
        send(req, res, 200, views.correctionPage(await svc.entityView(e), { values: { target_type: req.query.target_type, target_id: req.query.target_id } }), { title: `Correction: ${e.name}`, robots: 'noindex, nofollow' });
    });
    router.post('/e/:slug/correct', F('reviews.correction.submit'), form, wrap(async (req, res) => {
        const e = await locate(req, res, '/correct');
        if (!e) return;
        if (!req.actor.subject) return needSignIn(req, res, 'Sign in with your OpenVibe account to send a correction to the editors.');
        const b = req.body || {};
        try {
            await svc.submitCorrection(e.id, { target_type: b.target_type, target_id: b.target_id || null, body: b.body, evidence_url: b.evidence_url || null }, req.actor);
            send(req, res, 201, views.correctionPage(await svc.entityView(e), { done: true }), { title: `Correction: ${e.name}`, robots: 'noindex, nofollow' });
        } catch (err) {
            if (!err.status || err.status >= 500) throw err;
            send(req, res, err.status, views.correctionPage(await svc.entityView(e), { values: b, error: err.message }), { title: `Correction: ${e.name}`, robots: 'noindex, nofollow' });
        }
    }));

    router.post('/e/:slug/discuss', F('reviews.discussion.comment'), form, wrap(async (req, res) => {
        const e = await locate(req, res, '/discuss');
        if (!e) return;
        if (!req.actor.subject) return needSignIn(req, res, 'Sign in with your OpenVibe account to comment.');
        const message = String((req.body || {}).message || '').trim();
        if (!message) return res.redirect(303, `${svc.entityPath(e)}#discussion`);
        if (!platform.community.configured) return errorPage(req, res, 503, 'Discussion unavailable', 'OpenVibe.Community is not configured on this server. Nothing was posted.');
        try {
            const threadId = await svc.discussionThread(e, platform.community);
            await platform.community.addComment(threadId, { subject: req.actor.subject, message });
        } catch (err) {
            log.warn(`[Reviews] comment on ${e.id} failed: ${err.message}`);
            return errorPage(req, res, 503, 'Discussion unavailable', 'The discussion is held by OpenVibe.Community, which could not take the comment right now. Nothing was posted.');
        }
        res.redirect(303, `${svc.entityPath(e)}#discussion`);
    }));

    // ── Editors ──────────────────────────────────────────────
    router.get('/editor', async (req, res) => {
        if (!editorOnly(req, res)) return;
        send(req, res, 200, views.editorHome({
            // Item views are read here (async); the view renders them as they are.
            queue: await Promise.all((await svc.resolutionQueue(100)).map((row) => svc.itemView(row))), pending: await svc.pendingSummaries(), flagged: await svc.flaggedSummaries(),
            corrections: await svc.openCorrections(), stats: await svc.stats(), itemView: (it) => it,
        }), { title: 'Editor desk', robots: 'noindex, nofollow' });
    });

    router.post('/editor/sync', F('reviews.sources.sync'), form, wrap(async (req, res) => {
        if (!editorOnly(req, res)) return;
        const pulled = await sync.pull();
        await sync.drain();
        if (!pulled.ok) return errorPage(req, res, 503, 'Sources unavailable', `Nothing changed: ${pulled.reason}`);
        res.redirect(303, '/editor');
    }));

    router.get('/editor/entities/new', (req, res) => {
        if (!editorOnly(req, res)) return;
        send(req, res, 200, views.newEntityPage({ values: { name: req.query.name || '' } }), { title: 'New entity', robots: 'noindex, nofollow' });
    });
    router.post('/editor/entities/new', F('reviews.entity.manage'), form, wrap(async (req, res) => {
        if (!editorOnly(req, res)) return;
        const b = req.body || {};
        const aliases = ['source', 'url', 'gtin', 'sku', 'external'].map((type) => ({ type, value: String(b[`alias_${type}`] || '').trim() })).filter((a) => a.value);
        try {
            const out = await svc.createEntity({ name: b.name, kind: b.kind, description: b.description || null, aliases }, req.actor);
            res.redirect(303, `${svc.entityPath(out.entity)}/edit`);
        } catch (err) {
            if (!err.status || err.status >= 500) throw err;
            send(req, res, err.status, views.newEntityPage({ values: b, error: err.message }), { title: 'New entity', robots: 'noindex, nofollow' });
        }
    }));

    /** An open correction request about `e` (the summary form then answers it). */
    async function openCorrectionFor(e, id) {
        const c = id ? await svc.correction(String(id)) : null;
        return c && c.status === 'open' && await svc.canonicalOf(c.entity_id) === e.id ? c : null;
    }

    async function editPage(req, res, e, { status = 200, error = null, flash = null, correcting = null } = {}) {
        send(req, res, status, views.editEntityPage({ page: await svc.page(e, req.actor), error, flash, correcting, entities: (await svc.listEntities({ limit: 200 })).entities }), { title: `Edit ${e.name}`, robots: 'noindex, nofollow' });
    }

    router.get('/e/:slug/edit', async (req, res) => {
        if (!editorOnly(req, res)) return;
        const e = await locate(req, res, '/edit');
        if (!e) return;
        await editPage(req, res, e, { flash: req.query.saved ? 'Saved.' : null, correcting: await openCorrectionFor(e, req.query.correction) });
    });
    router.post('/e/:slug/edit', F('reviews.entity.manage'), form, wrap(async (req, res) => {
        if (!editorOnly(req, res)) return;
        let e = await locate(req, res, '/edit');
        if (!e) return;
        const b = req.body || {};
        try {
            switch (b.action) {
            case 'details': e = await svc.updateEntity(e.id, { name: b.name, slug: b.slug, kind: b.kind, description: b.description || null, noindex: b.noindex === '1' }, req.actor); break;
            case 'add_alias': await svc.addAlias(e.id, { type: b.type, value: b.value }, req.actor); break;
            case 'remove_alias': await svc.removeAlias(e.id, b.alias_id, req.actor); break;
            case 'add_link': await svc.addLink(e.id, { type: b.type, to: b.to }, req.actor); break;
            case 'unpublish_summary': await svc.unpublishSummary(e.id, req.actor); break;
            case 'trust': {
                const [scope, ...rest] = String(b.scope_ref || '').split(':');
                await svc.setTrust({ scope, scope_id: rest.join(':'), key: b.key, value: b.value, note: b.note || null }, req.actor);
                break;
            }
            default: return errorPage(req, res, 400, 'Unknown action', 'The form sent an action this page does not know.');
            }
            res.redirect(303, `${svc.entityPath(await svc.entityById(e.id))}/edit?saved=1`);
        } catch (err) {
            if (!err.status || err.status >= 500) throw err;
            await editPage(req, res, await svc.entityById(e.id), { status: err.status, error: err.message });
        }
    }));

    router.post('/e/:slug/summary', F('reviews.summary.publish'), form, wrap(async (req, res) => {
        if (!editorOnly(req, res)) return;
        const e = await locate(req, res, '/summary');
        if (!e) return;
        try {
            await svc.writeSummary(e.id, summaryFromForm(req.body || {}), req.actor);
            res.redirect(303, `${svc.entityPath(e)}/edit?saved=1`);
        } catch (err) {
            if (!err.status || err.status >= 500) throw err;
            await editPage(req, res, e, { status: err.status, error: err.message, correcting: await openCorrectionFor(e, (req.body || {}).correction_id) });
        }
    }));

    router.post('/e/:slug/summary/:n/review', F('reviews.summary.publish'), form, wrap(async (req, res) => {
        if (!editorOnly(req, res)) return;
        const e = await locate(req, res, `/summary/${req.params.n}/review`);
        if (!e) return;
        const b = req.body || {};
        await svc.reviewSummary(e.id, req.params.n, { decision: b.decision, note: b.note || null, publish: true }, req.actor);
        res.redirect(303, `${svc.entityPath(e)}?saved=1`);
    }));

    router.post('/e/:slug/merge', F('reviews.entity.merge'), form, wrap(async (req, res) => {
        if (!editorOnly(req, res)) return;
        const e = await locate(req, res, '/merge');
        if (!e) return;
        const b = req.body || {};
        const out = await svc.merge(e.id, { into: String(b.into || '').trim(), note: b.note || null }, req.actor);
        res.redirect(303, `${svc.entityPath(out.into)}/history#merges`);
    }));

    router.post('/e/:slug/split', F('reviews.entity.merge'), form, wrap(async (req, res) => {
        if (!editorOnly(req, res)) return;
        const e = await svc.findEntity(req.params.slug);
        if (!e) return notFound(req, res);
        const b = req.body || {};
        const out = await svc.split(e.id, { note: b.note || null }, req.actor);
        res.redirect(303, `${svc.entityPath(out.entity)}/history#merges`);
    }));

    router.get('/editor/items/:id', async (req, res) => {
        if (!editorOnly(req, res)) return;
        const row = await svc.item(req.params.id);
        if (!row) return notFound(req, res);
        const item = await svc.itemView(row);
        const candidates = item.candidates.map((c) => c.entity).filter(Boolean);
        send(req, res, 200, views.itemPage({ item, candidates }), { title: `Item ${item.id}`, robots: 'noindex, nofollow' });
    });
    router.post('/editor/items/:id', F('reviews.item.resolve'), form, wrap(async (req, res) => {
        if (!editorOnly(req, res)) return;
        const b = req.body || {};
        if (b.action === 'ignore') await svc.ignoreItem(req.params.id, { note: b.note || null }, req.actor);
        else {
            const target = String(b.entity_other || '').trim() || String(b.entity || '').trim();
            await svc.confirmResolution(req.params.id, { entity: target, add_alias: b.add_alias || null }, req.actor);
        }
        res.redirect(303, '/editor#items');
    }));

    router.post('/editor/corrections/:id', F('reviews.correction.resolve'), form, wrap(async (req, res) => {
        if (!editorOnly(req, res)) return;
        const b = req.body || {};
        await svc.resolveCorrection(req.params.id, { status: b.status, note: b.note || null, correction_note: b.correction_note || null }, req.actor);
        res.redirect(303, '/editor#corrections');
    }));

    return { router, errorPage };
}

module.exports = { createPages, structuredData, summaryFromForm };
