'use strict';
/**
 * The product-specific service clients Reviews composes (roadmap §29): Events (the outbox relay) and
 * Community (discussion threads). Each call uses a Network client-credentials token for svc:reviews,
 * minted per audience by the SDK token client. The Sources client is the ingest chassis
 * (openvibe-publishing/ingest.createSourcesClient), created in server/index.js.
 *
 * Every integration is optional. Missing configuration or an unreachable service is an explicit
 * failure (an error with a stable code, or `configured: false`), never invented data.
 */
const { createClient } = require('openvibe-sdk/core');
const { createServiceTokenClient } = require('openvibe-sdk/auth');
const { createEventsClient, createPgOutbox } = require('openvibe-sdk/events');
const { createDiscussionClient } = require('openvibe-publishing/discussion');

class IntegrationError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const SUBJECT_RE = /^(usr|gst)_[0-9A-HJKMNP-TV-Z]{26}$/;

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
    // The PostgreSQL outbox (ADR-035): rows are written in the change's own transaction (enqueue(db, …) joins the
    // ambient transaction); several processes relay one table safely (leases). The table is in migrations/.
    const outbox = createPgOutbox(db, {
        events, table: 'review_event_outbox', intervalMs: config.eventsRelayIntervalMs, now,
        onError: (err) => log.warn(`[Reviews] event relay: ${err && err.message}`),
    });

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
        tokenClient, sdk, events, outbox, community,
        eventsConfigured: !!(tokenClient && config.eventsUrl),
    };
}

module.exports = { createPlatform, IntegrationError };
