'use strict';
/**
 * Clients for the services Reviews composes (roadmap §29): Events (outbox relay), Sources (review
 * items with provenance) and Community (discussion threads). Each call uses a Network
 * client-credentials token for svc:reviews, minted per audience by the SDK token client.
 *
 * Every integration is optional. Missing configuration or an unreachable service is an explicit
 * failure (an error with a stable code, or `configured: false`), never invented data.
 */
const { createClient } = require('openvibe-sdk/core');
const { createServiceTokenClient } = require('openvibe-sdk/auth');
const { createEventsClient, createOutbox } = require('openvibe-sdk/events');
const { createDiscussionClient } = require('openvibe-publishing/discussion');

class IntegrationError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const SUBJECT_RE = /^(usr|gst)_[0-9A-HJKMNP-TV-Z]{26}$/;
const ITEM_RE = /^itm_[0-9A-HJKMNP-TV-Z]{26}$/;
const SOURCE_KEY_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

function createPlatform({ config, db, fetchImpl = globalThis.fetch, tokens = null, now = () => Date.now(), log = console } = {}) {
    const tokenClient = tokens || (config.oauth.clientSecret
        ? createServiceTokenClient({ network: config.networkInternalUrl || config.networkUrl, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, fetch: fetchImpl })
        : null);
    const forAudience = (audience) => ({
        authHeaders: () => {
            if (!tokenClient) throw new IntegrationError(503, 'reviews.principal_unconfigured', 'OV_OAUTH_CLIENT_SECRET is not set: Reviews has no service token');
            return tokenClient.authHeaders({ audience });
        },
        invalidate: () => tokenClient && tokenClient.invalidate({ audience }),
    });

    // ── Events: the outbox always records; the relay runs only with EVENTS_URL ──
    const sdk = createClient({
        fetch: fetchImpl,
        network: config.networkUrl,
        autoDiscover: false,
        ...(tokenClient ? { tokenProvider: tokenClient } : {}),
        baseUrls: config.eventsUrl ? { events: config.eventsUrl } : {},
        onWarning: (msg) => log.warn(`[Reviews] ${msg}`),
    });
    const events = createEventsClient(sdk, { source: 'reviews' });
    const outbox = createOutbox(db, {
        events, table: 'review_event_outbox', intervalMs: config.eventsRelayIntervalMs, now,
        onError: (err) => log.warn(`[Reviews] event relay: ${err && err.message}`),
    });
    outbox.ensureSchema();

    async function getJson(url, audience, { headers = {}, timeoutMs = 8000 } = {}) {
        let res;
        try {
            res = await fetchImpl(url, { headers: { Accept: 'application/json', ...(await forAudience(audience).authHeaders()), ...headers }, signal: AbortSignal.timeout(timeoutMs) });
        } catch (err) {
            if (err instanceof IntegrationError) throw err;
            throw new IntegrationError(503, 'upstream.unavailable', `${new URL(url).host} did not answer: ${err && err.name === 'TimeoutError' ? 'timeout' : err && err.message}`);
        }
        const body = await res.json().catch(() => null);
        if (res.status === 401) forAudience(audience).invalidate();
        return { status: res.status, body };
    }

    // ── Sources: review items (sources.item.read) and source records (sources.source.read) ──
    const sources = {
        configured: !!(tokenClient && config.sourcesInternalUrl),
        requireConfigured() {
            if (!sources.configured) throw new IntegrationError(503, 'sources.unavailable', 'OpenVibe.Sources is not configured (OV_SOURCES_INTERNAL_URL and the service principal)');
        },
        /** One item with its provenance. → { item, source } */
        async getItem(id) {
            if (!ITEM_RE.test(String(id || ''))) throw new IntegrationError(422, 'signal.invalid_source_item', 'A Sources item id looks like itm_<ULID>');
            sources.requireConfigured();
            const r = await getJson(`${config.sourcesInternalUrl}/api/v1/items/${encodeURIComponent(id)}`, 'openvibe.sources');
            if (r.status === 404) throw new IntegrationError(404, 'signal.source_item_not_found', `Sources has no item ${id}`);
            if (r.status !== 200 || !r.body || !r.body.item) throw new IntegrationError(503, 'sources.unavailable', `Sources answered ${r.status}`);
            return { item: r.body.item, source: r.body.source || null };
        },
        /** Items of category `reviews` in change order (creations, revisions, removals). */
        async listItems({ after = 0, limit = 200 } = {}) {
            sources.requireConfigured();
            const u = new URL(`${config.sourcesInternalUrl}/api/v1/items`);
            u.searchParams.set('category', 'reviews');
            u.searchParams.set('include_removed', '1');
            u.searchParams.set('after', String(after));
            u.searchParams.set('limit', String(limit));
            const r = await getJson(u.toString(), 'openvibe.sources');
            if (r.status !== 200 || !r.body || !Array.isArray(r.body.items)) throw new IntegrationError(503, 'sources.unavailable', `Sources answered ${r.status}`);
            return r.body;
        },
        /** The source record (name, homepage, notes). null when Sources does not know it. */
        async getSource(key) {
            if (!SOURCE_KEY_RE.test(String(key || ''))) return null;
            sources.requireConfigured();
            const r = await getJson(`${config.sourcesInternalUrl}/api/v1/sources/${encodeURIComponent(key)}`, 'openvibe.sources');
            if (r.status === 404) return null;
            if (r.status !== 200 || !r.body) throw new IntegrationError(503, 'sources.unavailable', `Sources answered ${r.status}`);
            return r.body.source || r.body;
        },
    };

    // ── Community: comment threads (reference, never copy) ──
    const communityBase = config.communityInternalUrl || config.communityUrl;
    const discussionClient = createDiscussionClient({ communityUrl: communityBase, tokenClient: forAudience('openvibe.community'), fetchImpl });
    const community = {
        configured: !!(tokenClient && communityBase),
        resolveThread: (ref, opts) => discussionClient.resolveThread(ref, opts),
        async getThread(threadId, { subject } = {}) {
            const headers = subject && SUBJECT_RE.test(subject) ? { 'X-OV-Subject': subject } : {};
            const r = await getJson(`${communityBase}/api/v1/comments/threads/${encodeURIComponent(threadId)}?limit=50`, 'openvibe.community', { headers, timeoutMs: 5000 });
            if (r.status === 404) throw new IntegrationError(404, 'thread.not_found', 'The discussion thread no longer exists');
            if (r.status !== 200 || !r.body || !r.body.thread) throw new IntegrationError(503, 'discussion.unavailable', `Community answered ${r.status}`);
            return r.body;
        },
        async addComment(threadId, { subject, message }) {
            if (!SUBJECT_RE.test(String(subject || ''))) throw new IntegrationError(403, 'reviews.person_required', 'Only a signed-in person can comment');
            let res;
            try {
                res = await fetchImpl(`${communityBase}/api/v1/comments/threads/${encodeURIComponent(threadId)}/comments`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-OV-Subject': subject, ...(await forAudience('openvibe.community').authHeaders()) },
                    body: JSON.stringify({ message: String(message || '').slice(0, 5000) }),
                    signal: AbortSignal.timeout(5000),
                });
            } catch (err) {
                if (err instanceof IntegrationError) throw err;
                throw new IntegrationError(503, 'discussion.unavailable', 'Community did not answer');
            }
            const body = await res.json().catch(() => null);
            if (res.status !== 201 && res.status !== 200) {
                throw new IntegrationError(res.status >= 500 ? 503 : res.status, (body && body.code) || 'discussion.unavailable', (body && (body.detail || body.error)) || `Community answered ${res.status}`);
            }
            return body;
        },
    };

    return {
        tokenClient, sdk, events, outbox, sources, community,
        eventsConfigured: !!(tokenClient && config.eventsUrl),
    };
}

module.exports = { createPlatform, IntegrationError };
