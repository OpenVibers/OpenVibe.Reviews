'use strict';
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
const seo = require('openvibe-publishing/seo');
const { renderPage } = require('../render/layout');
const views = require('../render/views');
const { ratingForStructuredData } = require('../reviews/aggregate');
const { actorMiddleware, crossSite } = require('./common');

const SCHEMA_TYPE = { product: 'Product', game: 'VideoGame', software: 'SoftwareApplication', service: 'Service', place: 'Place', organization: 'Organization', media: 'CreativeWork', other: 'Thing' };

/**
 * JSON-LD for an entity page. Product / Thing with an AggregateRating, and a Review for the
 * summary, exist ONLY when the aggregate exists — i.e. when real signals back it. Without
 * signals the page carries breadcrumbs and nothing that could be read as a rating.
 */
function structuredData(p, config) {
    const en = p.entity;
    const origin = config.baseUrl;
    const out = [seo.structuredData.breadcrumbs([{ name: 'OpenVibe.Reviews', url: `${origin}/` }, { name: en.name, url: en.url }])];
    const rating = ratingForStructuredData(p.aggregate && p.aggregate.result);
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

function createPages({ svc, platform, sync, viewers, config, log = console }) {
    const router = express.Router();
    const form = express.urlencoded({ extended: false, limit: '200kb' });
    router.use(actorMiddleware(viewers, { services: false }));

    const origin = new URL(config.baseUrl).origin;
    // Cross-site form posts are refused (the session cookie is SameSite=Lax as well).
    router.use((req, res, next) => {
        if (req.method !== 'POST' || !crossSite(req, origin)) return next();
        res.status(403).type('text/plain').set('Cache-Control', 'private, no-store').send('Cross-site form posts are not accepted.');
    });

    const send = (req, res, status, body, o = {}) => {
        const cacheable = o.cache === 'public' && req.actor.kind === 'anonymous' && status === 200;
        res.status(status).set('Cache-Control', cacheable ? 'public, max-age=60' : 'private, no-store').set('Vary', 'Cookie, Authorization').type('html')
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
    function locate(req, res, suffix = '') {
        const slug = req.params.slug;
        const e = svc.findEntity(slug);
        const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
        if (!e) {
            const r = svc.resolveRedirect(`/e/${slug}`);
            if (r && r.status === 301) { res.set('Cache-Control', 'public, max-age=300').redirect(301, r.location + suffix + query); return null; }
            if (r && r.status === 410) { gone(req, res); return null; }
            notFound(req, res);
            return null;
        }
        if (e.state === 'deleted') { gone(req, res); return null; }
        if (e.state === 'merged') {
            const c = svc.entityById(svc.canonicalOf(e.id));
            res.set('Cache-Control', 'public, max-age=60').redirect(301, `${svc.entityPath(c)}${suffix}${query}`);
            return null;
        }
        return e;
    }

    // ── Public ───────────────────────────────────────────────
    router.get('/', (req, res) => {
        const all = svc.listEntities({ limit: 1 });
        send(req, res, 200, views.home({ entities: svc.entitiesWithData(60), total: all.total, editor: isEditor(req) }), {
            robots: 'index, follow', cache: 'public', active: 'home', path: '/',
            jsonLd: seo.structuredData.webPage({ url: `${config.baseUrl}/`, name: 'OpenVibe.Reviews', description: 'Review signals from named sources, with provenance and honest aggregates.' }),
        });
    });
    router.get('/about', (req, res) => send(req, res, 200, views.aboutPage(), { title: 'How it works', robots: 'index, follow', cache: 'public', active: 'about' }));
    router.get('/search', (req, res) => {
        const query = String(req.query.q || '').slice(0, 200);
        send(req, res, 200, views.searchPage({ query, results: query ? svc.search(query) : [] }), { title: query ? `Search: ${query}` : 'Search', robots: 'noindex, follow', query });
    });

    router.get('/e/:slug.json', (req, res) => {
        const e = locate(req, res, '.json');
        if (!e) return;
        const p = svc.page(e, req.actor);
        res.status(200).set('Cache-Control', req.actor.kind === 'anonymous' ? 'public, max-age=60' : 'private, no-store').set('Vary', 'Cookie, Authorization').set('X-Robots-Tag', p.decision.robots)
            .json({ ...p, decision: { indexable: p.decision.indexable, robots: p.decision.robots, reasons: p.decision.codes } });
    });

    async function discussionFor(e, actor) {
        if (!platform.community.configured) return { state: 'unavailable', reason: 'OpenVibe.Community is not configured on this server' };
        const threadId = svc.knownThread(e.id);
        if (!threadId) return { state: 'none' };
        try {
            const data = await platform.community.getThread(threadId, { subject: actor.subject });
            return { state: 'ok', threadId, thread: data.thread, comments: data.comments || [] };
        } catch (err) {
            return { state: 'unavailable', reason: err.code === 'thread.not_found' ? 'the thread was removed' : null };
        }
    }

    router.get('/e/:slug', wrap(async (req, res) => {
        const e = locate(req, res);
        if (!e) return;
        const p = svc.page(e, req.actor);
        const discussion = await discussionFor(e, req.actor);
        const head = seo.metaTags({
            decision: p.decision, title: `${e.name} · OpenVibe.Reviews`, siteName: 'OpenVibe.Reviews', type: 'website',
            description: e.description || `${e.name}: review signals from ${p.sources.length ? p.sources.map((s) => s.name || s.key).join(', ') : 'no source yet'}, with provenance.`,
            canonical: p.entity.url, jsonLd: structuredData(p, config),
        });
        send(req, res, 200, views.entityPage(p, { discussion, actor: req.actor, flash: req.query.saved ? 'Saved.' : null }), {
            head, title: e.name, cache: discussion.state === 'ok' ? null : 'public', path: svc.entityPath(e),
        });
    }));

    router.get('/e/:slug/history', (req, res) => {
        const e = locate(req, res, '/history');
        if (!e) return;
        send(req, res, 200, views.historyPage(svc.history(e, req.actor)), { title: `History of ${e.name}`, robots: 'noindex, follow', cache: 'public' });
    });

    router.get('/e/:slug/summary/:n', wrap(async (req, res) => {
        const e = locate(req, res, `/summary/${req.params.n}`);
        if (!e) return;
        const r = svc.summaryRevision(e, req.params.n, req.actor);
        send(req, res, 200, views.summaryRevisionPage(svc.entityView(e), r, { editor: isEditor(req) }), { title: `${e.name}: summary revision ${r.number}`, robots: 'noindex, follow' });
    }));

    router.get('/e/:slug/correct', (req, res) => {
        const e = locate(req, res, '/correct');
        if (!e) return;
        if (!req.actor.subject) return needSignIn(req, res, 'Sign in with your OpenVibe account to send a correction to the editors.');
        send(req, res, 200, views.correctionPage(svc.entityView(e), { values: { target_type: req.query.target_type, target_id: req.query.target_id } }), { title: `Correction: ${e.name}`, robots: 'noindex, nofollow' });
    });
    router.post('/e/:slug/correct', form, wrap(async (req, res) => {
        const e = locate(req, res, '/correct');
        if (!e) return;
        if (!req.actor.subject) return needSignIn(req, res, 'Sign in with your OpenVibe account to send a correction to the editors.');
        const b = req.body || {};
        try {
            svc.submitCorrection(e.id, { target_type: b.target_type, target_id: b.target_id || null, body: b.body, evidence_url: b.evidence_url || null }, req.actor);
            send(req, res, 201, views.correctionPage(svc.entityView(e), { done: true }), { title: `Correction: ${e.name}`, robots: 'noindex, nofollow' });
        } catch (err) {
            if (!err.status || err.status >= 500) throw err;
            send(req, res, err.status, views.correctionPage(svc.entityView(e), { values: b, error: err.message }), { title: `Correction: ${e.name}`, robots: 'noindex, nofollow' });
        }
    }));

    router.post('/e/:slug/discuss', form, wrap(async (req, res) => {
        const e = locate(req, res, '/discuss');
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
    router.get('/editor', (req, res) => {
        if (!editorOnly(req, res)) return;
        send(req, res, 200, views.editorHome({
            queue: svc.resolutionQueue(100), pending: svc.pendingSummaries(), flagged: svc.flaggedSummaries(),
            corrections: svc.openCorrections(), stats: svc.stats(), itemView: svc.itemView,
        }), { title: 'Editor desk', robots: 'noindex, nofollow' });
    });

    router.post('/editor/sync', form, wrap(async (req, res) => {
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
    router.post('/editor/entities/new', form, wrap(async (req, res) => {
        if (!editorOnly(req, res)) return;
        const b = req.body || {};
        const aliases = ['source', 'url', 'gtin', 'sku', 'external'].map((type) => ({ type, value: String(b[`alias_${type}`] || '').trim() })).filter((a) => a.value);
        try {
            const out = svc.createEntity({ name: b.name, kind: b.kind, description: b.description || null, aliases }, req.actor);
            res.redirect(303, `${svc.entityPath(out.entity)}/edit`);
        } catch (err) {
            if (!err.status || err.status >= 500) throw err;
            send(req, res, err.status, views.newEntityPage({ values: b, error: err.message }), { title: 'New entity', robots: 'noindex, nofollow' });
        }
    }));

    /** An open correction request about `e` (the summary form then answers it). */
    function openCorrectionFor(e, id) {
        const c = id ? svc.correction(String(id)) : null;
        return c && c.status === 'open' && svc.canonicalOf(c.entity_id) === e.id ? c : null;
    }

    function editPage(req, res, e, { status = 200, error = null, flash = null, correcting = null } = {}) {
        send(req, res, status, views.editEntityPage({ page: svc.page(e, req.actor), error, flash, correcting, entities: svc.listEntities({ limit: 200 }).entities }), { title: `Edit ${e.name}`, robots: 'noindex, nofollow' });
    }

    router.get('/e/:slug/edit', (req, res) => {
        if (!editorOnly(req, res)) return;
        const e = locate(req, res, '/edit');
        if (!e) return;
        editPage(req, res, e, { flash: req.query.saved ? 'Saved.' : null, correcting: openCorrectionFor(e, req.query.correction) });
    });
    router.post('/e/:slug/edit', form, wrap(async (req, res) => {
        if (!editorOnly(req, res)) return;
        let e = locate(req, res, '/edit');
        if (!e) return;
        const b = req.body || {};
        try {
            switch (b.action) {
            case 'details': e = svc.updateEntity(e.id, { name: b.name, slug: b.slug, kind: b.kind, description: b.description || null, noindex: b.noindex === '1' }, req.actor); break;
            case 'add_alias': svc.addAlias(e.id, { type: b.type, value: b.value }, req.actor); break;
            case 'remove_alias': svc.removeAlias(e.id, b.alias_id, req.actor); break;
            case 'add_link': svc.addLink(e.id, { type: b.type, to: b.to }, req.actor); break;
            case 'unpublish_summary': svc.unpublishSummary(e.id, req.actor); break;
            case 'trust': {
                const [scope, ...rest] = String(b.scope_ref || '').split(':');
                svc.setTrust({ scope, scope_id: rest.join(':'), key: b.key, value: b.value, note: b.note || null }, req.actor);
                break;
            }
            default: return errorPage(req, res, 400, 'Unknown action', 'The form sent an action this page does not know.');
            }
            res.redirect(303, `${svc.entityPath(svc.entityById(e.id))}/edit?saved=1`);
        } catch (err) {
            if (!err.status || err.status >= 500) throw err;
            editPage(req, res, svc.entityById(e.id), { status: err.status, error: err.message });
        }
    }));

    router.post('/e/:slug/summary', form, wrap(async (req, res) => {
        if (!editorOnly(req, res)) return;
        const e = locate(req, res, '/summary');
        if (!e) return;
        try {
            svc.writeSummary(e.id, summaryFromForm(req.body || {}), req.actor);
            res.redirect(303, `${svc.entityPath(e)}/edit?saved=1`);
        } catch (err) {
            if (!err.status || err.status >= 500) throw err;
            editPage(req, res, e, { status: err.status, error: err.message, correcting: openCorrectionFor(e, (req.body || {}).correction_id) });
        }
    }));

    router.post('/e/:slug/summary/:n/review', form, wrap(async (req, res) => {
        if (!editorOnly(req, res)) return;
        const e = locate(req, res, `/summary/${req.params.n}/review`);
        if (!e) return;
        const b = req.body || {};
        svc.reviewSummary(e.id, req.params.n, { decision: b.decision, note: b.note || null, publish: true }, req.actor);
        res.redirect(303, `${svc.entityPath(e)}?saved=1`);
    }));

    router.post('/e/:slug/merge', form, wrap(async (req, res) => {
        if (!editorOnly(req, res)) return;
        const e = locate(req, res, '/merge');
        if (!e) return;
        const b = req.body || {};
        const out = svc.merge(e.id, { into: String(b.into || '').trim(), note: b.note || null }, req.actor);
        res.redirect(303, `${svc.entityPath(out.into)}/history#merges`);
    }));

    router.post('/e/:slug/split', form, wrap(async (req, res) => {
        if (!editorOnly(req, res)) return;
        const e = svc.findEntity(req.params.slug);
        if (!e) return notFound(req, res);
        const b = req.body || {};
        const out = svc.split(e.id, { note: b.note || null }, req.actor);
        res.redirect(303, `${svc.entityPath(out.entity)}/history#merges`);
    }));

    router.get('/editor/items/:id', (req, res) => {
        if (!editorOnly(req, res)) return;
        const row = svc.item(req.params.id);
        if (!row) return notFound(req, res);
        const item = svc.itemView(row);
        const candidates = item.candidates.map((c) => c.entity).filter(Boolean);
        send(req, res, 200, views.itemPage({ item, candidates }), { title: `Item ${item.id}`, robots: 'noindex, nofollow' });
    });
    router.post('/editor/items/:id', form, wrap(async (req, res) => {
        if (!editorOnly(req, res)) return;
        const b = req.body || {};
        if (b.action === 'ignore') svc.ignoreItem(req.params.id, { note: b.note || null }, req.actor);
        else {
            const target = String(b.entity_other || '').trim() || String(b.entity || '').trim();
            svc.confirmResolution(req.params.id, { entity: target, add_alias: b.add_alias || null }, req.actor);
        }
        res.redirect(303, '/editor#items');
    }));

    router.post('/editor/corrections/:id', form, wrap(async (req, res) => {
        if (!editorOnly(req, res)) return;
        const b = req.body || {};
        svc.resolveCorrection(req.params.id, { status: b.status, note: b.note || null, correction_note: b.correction_note || null }, req.actor);
        res.redirect(303, '/editor#corrections');
    }));

    return { router, errorPage };
}

module.exports = { createPages, structuredData, summaryFromForm };
