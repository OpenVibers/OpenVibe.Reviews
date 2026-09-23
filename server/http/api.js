'use strict';
/**
 * /api/v1 — JSON API for people (Network user JWT as Bearer or the ov_token cookie) and services
 * (Network client-credentials token for audience openvibe.reviews, one capability per route,
 * acting for the person named in X-OV-Subject). Errors are RFC 9457 problem+json. Responses are
 * Cache-Control: private, no-store. Editorial writes need an editor who is a person.
 *
 *   GET    /entities?q=&limit=&offset=               reviews.entity.resolve   list or search active entities
 *   POST   /resolve                                  reviews.entity.resolve   { name?, url?, gtin?, sku?, mpn?, source?, external? }
 *   GET    /entities/:ref                            reviews.entity.resolve   entity page data: aggregate with inputs, signals with provenance, summary
 *   GET    /entities/:ref/history                    reviews.entity.resolve   aggregate revisions, summary revisions, merges, audit
 *   GET    /entities/:ref/aggregate                  reviews.entity.resolve   { aggregate: null | { revision, result } }
 *   POST   /entities                                 reviews.entity.manage    { name, kind?, description?, slug?, aliases? }
 *   PATCH  /entities/:ref                            reviews.entity.manage    { name?, kind?, description?, slug?, noindex? }
 *   DELETE /entities/:ref                            reviews.entity.manage
 *   POST   /entities/:ref/aliases                    reviews.entity.manage    { type, value }
 *   DELETE /entities/:ref/aliases/:id                reviews.entity.manage
 *   POST   /entities/:ref/links                      reviews.entity.manage    { type, to? | ref?, note? }
 *   DELETE /entities/:ref/links/:id                  reviews.entity.manage
 *   POST   /entities/:ref/merge                      reviews.entity.merge     { into, note? }
 *   POST   /entities/:ref/split                      reviews.entity.split     { note? }
 *   POST   /trust                                    reviews.entity.manage    { scope, scope_id, key, value, note? }
 *   GET    /items?resolution=queue                   reviews.entity.resolve   items waiting for an editor
 *   GET    /items/:id                                reviews.entity.resolve   410 item.removed once its source took it down
 *   POST   /items/:id/resolution                     reviews.entity.resolve   { entity, add_alias? } | { ignore: true, note? }   editor
 *   POST   /signals/import                           reviews.signal.import    { source_item_id }   fetch the item from Sources and apply it
 *   POST   /sources/sync                             reviews.signal.import    pull the next pages of review items from Sources
 *   POST   /entities/:ref/summary/revisions          reviews.summary.publish  { overview?, overview_signals?, pros?, cons?, expected_revision?, message?, publish? }
 *   POST   /entities/:ref/summary/proposals          reviews.summary.propose  { overview?, pros?, cons?, workflow: { id, run_id }, stub_provider?, note? }
 *   GET    /entities/:ref/summary/revisions/:n       reviews.entity.resolve
 *   POST   /entities/:ref/summary/revisions/:n/review reviews.summary.publish { decision: approved|rejected, note?, publish? }
 *   POST   /entities/:ref/summary/publish            reviews.summary.publish  { revision? }
 *   POST   /entities/:ref/summary/unpublish          reviews.summary.publish
 *   POST   /entities/:ref/corrections                reviews.correction.submit { target_type, target_id?, body, evidence_url? }   a person
 *   GET    /corrections                              reviews.entity.manage    open corrections (editors)
 *   PATCH  /corrections/:id                          reviews.entity.manage    { status: accepted|rejected, note? }
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const { actorMiddleware, guard, run } = require('./common');

const { http } = contracts;

function createApi({ svc, viewers, platform, sync, config, log = console }) {
    const router = express.Router();
    router.use(http.middleware());
    router.use(express.json({ limit: '256kb' }));
    router.use((err, req, res, next) => (err ? http.sendProblem(res, 400, 'request.invalid_json', { detail: 'Malformed JSON body', ctx: req.ov }) : next()));
    router.use(actorMiddleware(viewers));
    const R = (fn, status) => run(fn, status, log);
    const body = (req) => (req.body && typeof req.body === 'object' ? req.body : {});

    function live(ref) {
        const e = svc.entity(ref);
        if (e.state === 'deleted') throw new svc.ReviewsError(410, 'entity.deleted', 'This entity was deleted');
        if (e.state === 'merged') throw new svc.ReviewsError(409, 'entity.merged', `Merged into ${svc.canonicalOf(e.id)}`, { canonical_id: svc.canonicalOf(e.id) });
        return e;
    }

    router.get('/entities', guard('reviews.entity.resolve'), R((req) => {
        const text = String(req.query.q || '').trim();
        if (text) return { entities: svc.search(text, { limit: Number(req.query.limit) || 30 }).map(svc.entityView) };
        const out = svc.listEntities({ limit: Number(req.query.limit) || 50, offset: Number(req.query.offset) || 0 });
        return { entities: out.entities.map(svc.entityView), total: out.total };
    }));
    router.post('/resolve', guard('reviews.entity.resolve'), R((req) => svc.resolve(body(req))));
    router.get('/entities/:ref', guard('reviews.entity.resolve'), R((req) => {
        const e = svc.entity(req.params.ref);
        if (e.state !== 'active') return { entity: svc.entityView(e), canonical: e.state === 'merged' ? svc.entityView(svc.entityById(svc.canonicalOf(e.id))) : null };
        const p = svc.page(e, req.actor);
        return { ...p, decision: { indexable: p.decision.indexable, robots: p.decision.robots, reasons: p.decision.codes } };
    }));
    router.get('/entities/:ref/history', guard('reviews.entity.resolve'), R((req) => svc.history(svc.entity(req.params.ref), req.actor)));
    router.get('/entities/:ref/aggregate', guard('reviews.entity.resolve'), R((req) => {
        const e = live(req.params.ref);
        const p = svc.page(e, req.actor);
        return { entity_id: e.id, aggregate: p.aggregate, aggregate_revision: p.aggregate_revision };
    }));

    router.post('/entities', guard('reviews.entity.manage'), R((req) => {
        const out = svc.createEntity(body(req), req.actor);
        return { entity: svc.entityView(out.entity), settled_items: out.settled_items };
    }, 201));
    router.patch('/entities/:ref', guard('reviews.entity.manage'), R((req) => ({ entity: svc.entityView(svc.updateEntity(req.params.ref, body(req), req.actor)) })));
    router.delete('/entities/:ref', guard('reviews.entity.manage'), R((req) => ({ entity: svc.entityView(svc.deleteEntity(req.params.ref, body(req), req.actor)) })));
    router.post('/entities/:ref/aliases', guard('reviews.entity.manage'), R((req) => svc.addAlias(req.params.ref, body(req), req.actor), 201));
    router.delete('/entities/:ref/aliases/:id', guard('reviews.entity.manage'), R((req) => ({ alias: svc.removeAlias(req.params.ref, req.params.id, req.actor) })));
    router.post('/entities/:ref/links', guard('reviews.entity.manage'), R((req) => ({ link: svc.addLink(req.params.ref, body(req), req.actor) }), 201));
    router.delete('/entities/:ref/links/:id', guard('reviews.entity.manage'), R((req) => ({ link: svc.endLink(req.params.ref, req.params.id, body(req), req.actor) })));
    router.post('/entities/:ref/merge', guard('reviews.entity.merge'), R((req) => {
        const out = svc.merge(req.params.ref, body(req), req.actor);
        return { link: out.link, entity: svc.entityView(out.entity), into: svc.entityView(out.into), signals: out.signals };
    }));
    router.post('/entities/:ref/split', guard('reviews.entity.split'), R((req) => {
        const out = svc.split(req.params.ref, body(req), req.actor);
        return { link: out.link, entity: svc.entityView(out.entity), from: out.from ? svc.entityView(out.from) : null, signals: out.signals };
    }));
    router.post('/trust', guard('reviews.entity.manage'), R((req) => svc.setTrust(body(req), req.actor)));

    router.get('/items', guard('reviews.entity.resolve'), R((req) => {
        if (!svc.access.isEditor(req.actor)) throw new svc.ReviewsError(403, 'reviews.editor_required', 'The resolution queue is for Reviews editors');
        return { items: svc.resolutionQueue(Number(req.query.limit) || 200).map(svc.itemView) };
    }));
    router.get('/items/:id', guard('reviews.entity.resolve'), R((req) => {
        const row = svc.item(req.params.id);
        if (!row) throw new svc.ReviewsError(404, 'item.not_found', 'Reviews has not read that item');
        // Taken down at its source: gone, like a deleted entity (its record stays for the audit).
        if (row.state !== 'active') throw new svc.ReviewsError(410, 'item.removed', 'Its source removed this item');
        return { item: svc.itemView(row) };
    }));
    router.post('/items/:id/resolution', guard('reviews.entity.resolve'), R((req) => {
        const b = body(req);
        if (b.ignore === true) return { item: svc.itemView(svc.ignoreItem(req.params.id, b, req.actor)) };
        const out = svc.confirmResolution(req.params.id, b, req.actor);
        return { item: svc.itemView(out.item), signal: out.signal ? svc.signalView(out.signal) : null, settled_items: out.settled_items };
    }));

    router.post('/signals/import', guard('reviews.signal.import'), R(async (req) => {
        const a = req.actor;
        if (a.kind === 'anonymous' || (a.kind === 'user' && !svc.access.isEditor(a))) throw new svc.ReviewsError(403, 'reviews.editor_required', 'Importing is for Reviews editors and granted services');
        const b = body(req);
        const out = await svc.importItem(b.source_item_id || b.item_id, platform.sources, a);
        return { outcome: out.outcome, item: svc.itemView(out.item), signal: out.signal ? svc.signalView(out.signal) : null };
    }));
    router.post('/sources/sync', guard('reviews.signal.import'), R(async (req) => {
        const a = req.actor;
        if (a.kind === 'anonymous' || (a.kind === 'user' && !svc.access.isEditor(a))) throw new svc.ReviewsError(403, 'reviews.editor_required', 'Syncing is for Reviews editors and granted services');
        const pulled = await sync.pull();
        const drained = await sync.drain();
        return { pull: pulled, queue: drained };
    }));

    router.post('/entities/:ref/summary/revisions', guard('reviews.summary.publish'), R((req) => svc.writeSummary(req.params.ref, body(req), req.actor), 201));
    router.post('/entities/:ref/summary/proposals', guard('reviews.summary.propose'), R((req) => svc.proposeSummary(req.params.ref, body(req), req.actor), 201));
    router.get('/entities/:ref/summary/revisions/:n', guard('reviews.entity.resolve'), R((req) => ({ revision: svc.summaryRevision(svc.entity(req.params.ref), req.params.n, req.actor) })));
    router.post('/entities/:ref/summary/revisions/:n/review', guard('reviews.summary.publish'), R((req) => svc.reviewSummary(req.params.ref, req.params.n, body(req), req.actor)));
    router.post('/entities/:ref/summary/publish', guard('reviews.summary.publish'), R((req) => ({ summary: svc.publishSummary(req.params.ref, body(req), req.actor) })));
    router.post('/entities/:ref/summary/unpublish', guard('reviews.summary.publish'), R((req) => ({ summary: svc.unpublishSummary(req.params.ref, req.actor) })));

    router.post('/entities/:ref/corrections', guard('reviews.correction.submit'), R((req) => ({ correction: svc.submitCorrection(req.params.ref, body(req), req.actor) }), 201));
    router.get('/corrections', guard('reviews.entity.manage'), R((req) => {
        if (!svc.access.isEditor(req.actor)) throw new svc.ReviewsError(403, 'reviews.editor_required', 'Corrections are read by Reviews editors');
        return { corrections: svc.openCorrections() };
    }));
    router.patch('/corrections/:id', guard('reviews.entity.manage'), R((req) => ({ correction: svc.resolveCorrection(req.params.id, body(req), req.actor) })));

    return router;
}

module.exports = { createApi };
