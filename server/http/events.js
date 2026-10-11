'use strict';
/**
 * Sources → Reviews: POST /internal/events, the endpoint of Reviews' OpenVibe.Events subscription
 * (topic pattern `sources.item.*`).
 *
 *   sources.item.created|updated   category reviews: the item id is queued and fetched from Sources
 *                                  (the event carries no fields), then applied
 *   sources.item.removed           category reviews: the item's signal is withdrawn at once; the next
 *                                  aggregate revision no longer counts it
 *
 * The signature (X-OpenVibe-Signature v2, ±300 s) and the exactly-once inbox come from the chassis
 * (openvibe-publishing/ingest.createEventConsumer): the receipt (consumer, event_id) claims in the
 * same PostgreSQL transaction as the change, so a redelivery changes nothing. Only events whose
 * source is `sources` are applied.
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { createEventConsumer } = require('openvibe-publishing/ingest');

const CONSUMER = 'reviews-sources';

function createEvents({ db, svc, sync, config, log = console }) {
    const router = express.Router();
    const consumer = createEventConsumer({ db, secrets: config.eventsWebhookSecrets, consumer: CONSUMER, table: 'review_event_inbox' });
    const system = { kind: 'system', service: 'svc:reviews' };

    async function handler(event) {
        if (event.source !== 'sources') return 'ignored:source';
        const p = event.payload && typeof event.payload === 'object' ? event.payload : {};
        if (p.category !== 'reviews') return 'ignored:category';
        if (!/^itm_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(p.item_id || ''))) return 'ignored:no_item';
        if (event.event_type === 'sources.item.created' || event.event_type === 'sources.item.updated') { await sync.enqueue(p.item_id, event.event_type); return 'queued'; }
        if (event.event_type === 'sources.item.removed') return (await svc.removeItem(p.item_id, p.reason || 'removed by its source', system)).outcome;
        return 'ignored:type';
    }

    router.post('/events', express.raw({ type: () => true, limit: '256kb' }), async (req, res) => {
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        let out;
        try {
            out = await consumer.apply(raw, req.headers, handler);
        } catch (err) {
            log.error(`[Reviews] event delivery failed: ${err && err.message}`);
            return http.sendProblem(res, 500, 'reviews.event_failed', { detail: 'processing failed; it will be retried', ctx: req.ov });
        }
        if (out.status === 401) return http.sendProblem(res, 401, 'reviews.bad_signature', { detail: 'X-OpenVibe-Signature does not verify', ctx: req.ov });
        if (out.status === 400) return http.sendProblem(res, 400, 'reviews.bad_delivery', { detail: 'body must be { event: <envelope> }', ctx: req.ov });
        if (out.status === 503) return http.sendProblem(res, 503, 'reviews.webhook_disabled', { detail: 'REVIEWS_EVENTS_SECRET is not set', ctx: req.ov });
        if (out.outcome === 'queued') sync.drain().catch(() => {});
        res.status(200).json({ event_id: out.event_id, duplicate: out.duplicate, outcome: out.outcome });
    });

    return { router, consumer };
}

module.exports = { createEvents, CONSUMER };
