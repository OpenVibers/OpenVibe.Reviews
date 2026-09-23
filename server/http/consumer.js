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
 * Exactly once: the openvibe-sdk inbox claims (consumer, event_id) in the same SQLite transaction
 * as the change. The signature (X-OpenVibe-Signature, HMAC-SHA256 of the raw body with
 * REVIEWS_EVENTS_SECRET) is verified with openvibe-sdk's parseDelivery. Only events whose source
 * is `sources` are applied.
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { parseDelivery, createInbox } = require('openvibe-sdk/events');

const CONSUMER = 'reviews-sources';

function consumerRouter({ db, svc, sync, config, log = console }) {
    const router = express.Router();
    const inbox = createInbox(db, { table: 'review_event_inbox' });
    inbox.ensureSchema();
    const system = { kind: 'system', service: 'svc:reviews' };

    function apply(event) {
        return db.transaction(() => {
            const r = inbox.once(CONSUMER, event.event_id, () => {
                if (event.source !== 'sources') return 'ignored:source';
                const p = event.payload && typeof event.payload === 'object' ? event.payload : {};
                if (p.category !== 'reviews') return 'ignored:category';
                if (!/^itm_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(p.item_id || ''))) return 'ignored:no_item';
                if (event.event_type === 'sources.item.created' || event.event_type === 'sources.item.updated') { sync.enqueue(p.item_id, event.event_type); return 'queued'; }
                if (event.event_type === 'sources.item.removed') return svc.removeItem(p.item_id, p.reason || 'removed by its source', system).outcome;
                return 'ignored:type';
            });
            return r.duplicate ? { duplicate: true, outcome: null } : { duplicate: false, outcome: r.result };
        })();
    }

    router.post('/events', express.raw({ type: () => true, limit: '256kb' }), (req, res) => {
        const secrets = config.eventsWebhookSecrets;
        if (!secrets.length) return http.sendProblem(res, 503, 'reviews.webhook_disabled', { detail: 'REVIEWS_EVENTS_SECRET is not set', ctx: req.ov });
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        let delivery = null;
        // Signature v2 only: HMAC over "<t>.<raw body>" with t within ±300 s; a v1-only (v2 stripped) or stale delivery is refused.
        for (const s of secrets) { delivery = parseDelivery(raw, req.headers, s, { requireV2: true }); if (delivery) break; }
        if (!delivery) return http.sendProblem(res, 401, 'reviews.bad_signature', { detail: 'X-OpenVibe-Signature does not verify', ctx: req.ov });
        const event = delivery.event;
        if (!event || typeof event.event_id !== 'string' || !/^evt_[0-9A-HJKMNP-TV-Z]{26}$/.test(event.event_id)) {
            return http.sendProblem(res, 400, 'reviews.bad_delivery', { detail: 'body must be { event: <envelope>, seq }', ctx: req.ov });
        }
        let out;
        try {
            out = apply(event);
        } catch (e) {
            log.error(`[Reviews] event ${event.event_id} (${event.event_type}) failed:`, e.message);
            return http.sendProblem(res, 500, 'reviews.event_failed', { detail: 'processing failed; it will be retried', ctx: req.ov });
        }
        if (out.outcome === 'queued') sync.drain().catch(() => {});
        res.status(200).json({ event_id: event.event_id, duplicate: out.duplicate, outcome: out.outcome });
    });

    return { router, apply };
}

module.exports = { consumerRouter, CONSUMER };
