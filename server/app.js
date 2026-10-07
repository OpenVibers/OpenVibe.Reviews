'use strict';
/**
 * OpenVibe.Reviews — Express app factory. server/index.js starts it; tests build their own.
 *
 *   Pages (SSR, useful without JavaScript)      server/http/pages.js
 *   /api/v1 (people and service principals)     server/http/api.js
 *   POST /internal/events (signed webhook)      server/http/events.js
 *   Discovery: robots, sitemaps, feeds, llms    server/http/machine.js
 *   /auth/* (Network SSO)                       server/auth/session.js
 *   GET /api/health, /api/ready, /release.json, /metrics (loopback only)
 */
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const cache = require('openvibe-shared/cache-policy');
const { createReadiness } = require('openvibe-shared/ready');
const { http } = require('openvibe-contracts');
const { createSessionRoutes } = require('./auth/session');
const { createApi } = require('./http/api');
const { createPages } = require('./http/pages');
const { createMachine } = require('./http/machine');
const { createEvents } = require('./http/events');
const { createActorLimits } = require('./http/actor-limits');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VERSION = require('../package.json').version;

/**
 * A gauge's collect() is synchronous and the database is not (ADR-035): each scrape returns what the previous scrape
 * read (one interval behind) and starts the next read. It never throws.
 */
function lagged(read, initial) {
    let last = initial;
    let busy = false;
    return () => {
        if (!busy) {
            busy = true;
            Promise.resolve().then(read).then((v) => { last = v; }, () => {}).finally(() => { busy = false; });
        }
        return last;
    };
}

function createApp({ config, svc, viewers, platform, sources, sync, keys, db, log = console, rateLimits = true, fetchImpl = globalThis.fetch, limitsNow = null, indexnow = null }) {
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);
    // One W3C trace across services (openvibe-shared/trace): calls made while serving a request carry its traceparent.
    require('openvibe-shared/trace').install(app);

    const release = require('openvibe-shared/release').createRelease({ service: 'reviews', root: path.join(__dirname, '..') });
    require('./render/layout').setRelease(release.release);
    // Valkey (ADR-035): shared, never-authoritative state (per-actor limit counters). Optional.
    const valkey = config.valkey.url ? require('openvibe-sdk/valkey').createValkey({ url: config.valkey.url, prefix: config.valkey.prefix, log }) : null;
    const metrics = require('openvibe-shared/metrics').instrument(app, { service: 'reviews', release: release.release });
    metrics.registry.gauge({
        name: 'reviews_event_outbox', help: 'Events in the outbox by state', labelNames: ['state'],
        collect: lagged(async () => [{ labels: { state: 'pending' }, value: await platform.outbox.pending() }, { labels: { state: 'rejected' }, value: await platform.outbox.rejected() }], []),
    });
    metrics.registry.gauge({
        name: 'reviews_work', help: 'Editorial and import backlog', labelNames: ['kind'],
        collect: lagged(async () => {
            const s = await svc.stats();
            return [
                { labels: { kind: 'items_unresolved' }, value: s.items_unresolved },
                { labels: { kind: 'corrections_open' }, value: s.corrections_open },
                { labels: { kind: 'summaries_flagged' }, value: s.summaries_flagged },
                { labels: { kind: 'import_queue' }, value: await sync.pending() },
            ];
        }, []),
    });

    app.use((req, res, next) => {
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
        res.set('Content-Security-Policy', [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline' https://openvibe.network",
            "style-src 'self' 'unsafe-inline' https://openvibe.network https://fonts.googleapis.com https://cdnjs.cloudflare.com",
            "font-src 'self' data: https://fonts.gstatic.com https://cdnjs.cloudflare.com",
            "img-src 'self' data: https:",
            // openvibe.events: release notifications (release-watch's EventSource, openvibe-shared 1.17).
            "connect-src 'self' https://openvibe.network https://openvibe.events",
            "frame-src 'self' https://openvibe.network",
            "frame-ancestors 'self'",
            "form-action 'self' https://openvibe.network",
            "base-uri 'self'",
            "object-src 'none'",
        ].join('; '));
        next();
    });
    app.use(cookieParser());

    const limiter = (windowMs, max) => (rateLimits ? rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false }) : (_q, _s, n) => n());
    app.use('/auth/', limiter(15 * 60000, 60));
    app.use('/auth', createSessionRoutes({ config, viewers, log, fetchImpl }));
    { const legal = require('openvibe-shared/legal'); app.get(legal.PATHS, legal.handler({ id: 'reviews', service: 'reviews', host: 'openvibe.reviews', name: 'OpenVibe.Reviews', profile: 'ugc' })); }

    // GET /<key>.txt — the IndexNow key file (mounted only when a key is configured; it serves itself).
    if (indexnow && indexnow.enabled) app.use(indexnow.keyFile);

    // Signed deliveries from OpenVibe.Events. Loopback/internal only in nginx (not proxied publicly).
    const consumer = createEvents({ db, svc, sync, config, log });
    app.use('/internal', http.middleware(), consumer.router);

    app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'openvibe-reviews', version: VERSION }));
    // GET /release.json (ADR-016) and POST /release-metrics: open tabs' update reports into /metrics.
    release.mount(app, { registry: metrics.registry });
    const ready = createReadiness({
        service: 'reviews', release: release.release,
        checks: [
            {
                name: 'db', required: true,
                // A real round trip that names the store (postgresql / pglite), and the authority tables present.
                check: async () => {
                    const r = await db.ready();
                    if (!r.ok) return r.error;
                    const n = await db.prepare("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = current_schema() AND table_name IN ('review_entities','review_signals','review_summary_revisions')").pluck().get();
                    return n === 3 ? { ok: true, detail: r.detail } : 'schema missing (migrations did not run)';
                },
            },
            { name: 'valkey', required: false, check: async () => (valkey ? valkey.ready() : { skipped: 'VALKEY_URL not set: per-actor limits count in this process only' }) },
            { name: 'network_jwks', required: false, check: () => { if (keys.loaded()) return true; keys.ensure().catch(() => {}); return 'Network signing key not loaded yet: sign-in and token calls answer 503'; } },
            { name: 'sources', required: false, check: () => sources.enabled || 'not configured: no review items are read, so no signals and no aggregates exist' },
            { name: 'events_relay', required: false, check: () => (platform.eventsConfigured ? true : 'EVENTS_URL or the service principal is not configured: events wait in the outbox') },
            { name: 'events_webhook', required: false, check: () => (config.eventsWebhookSecrets.length ? true : 'REVIEWS_EVENTS_SECRET is not set: sources.item.* deliveries are refused; the pull sync still runs') },
            { name: 'community', required: false, check: () => platform.community.configured || 'not configured: discussions show as unavailable' },
            { name: 'editors', required: false, check: () => (svc.access.editorCount() ? true : 'REVIEWS_EDITORS is empty: only Network staff can edit') },
        ],
        details: async () => ({
            outbox: { pending: await platform.outbox.pending(), rejected: await platform.outbox.rejected() },
            sources: { cursor: await sync.cursor(), import_queue: await sync.pending(), last_pull_ok_at: await sync.state('sources.last_pull_ok_at'), last_pull_error: await sync.state('sources.last_pull_error') },
            backlog: await svc.stats(),
        }),
    });
    app.get('/api/ready', ready.handler);

    app.use('/api/', limiter(60000, 300));
    app.use('/api/v1/entities/:ref/corrections', limiter(60 * 60000, 20));
    // Per-actor limits (http/actor-limits.js) on /api/v1 and the forms, counted once each router resolved
    // req.actor; the per-address limits here stay. limitsNow: the limiter's clock (tests).
    const limits = createActorLimits({ config, now: limitsNow || (() => Date.now()), registry: metrics.registry, log, enabled: rateLimits, valkey });
    app.use('/api/v1', createApi({ svc, viewers, sources, sync, config, log, limits }));
    app.use('/api', (req, res) => http.sendProblem(res, 404, 'route.not_found', { detail: 'Not found' }));

    // This site's own pinned copy of the OpenVibe Frame's browser files (openvibe-shared/serve).
    app.use('/shared', require('openvibe-shared/serve').handler());
    app.use(express.static(PUBLIC_DIR, {
        index: false, redirect: false,
        // Immutable only when ?v= is the hash of the bytes served: an older page's URL after a deploy (or a
        // rollback) gets the current file with a short cache, never pinned for a year (WS-P task 10).
        setHeaders(res, filePath) {
            const v = res.req && res.req.query && res.req.query.v;
            const rel = path.relative(PUBLIC_DIR, filePath).split(path.sep).join('/');
            res.setHeader('Cache-Control', cache.assetHeaders(rel, { hashed: !!v && v === require('./render/layout').assetVersion(rel) }));
        },
    }));
    app.use(createMachine({ svc, config }));

    app.post(['/e/*', '/editor/*'], limiter(10 * 60000, 120));
    app.post('/e/:slug/correct', limiter(60 * 60000, 20));
    const pages = createPages({ svc, platform, sync, viewers, config, log, limits });
    app.use(pages.router);

    app.use((req, res) => pages.errorPage(req, res, 404, 'Not found', 'Nothing lives at that address.'));
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, _next) => {
        log.error('[Reviews]', err && err.stack ? err.stack : err);
        if (res.headersSent) return;
        if (req.path.startsWith('/api/')) return http.sendProblem(res, 500, 'internal.error', { detail: 'Internal error' });
        res.status(500).set('Cache-Control', cache.htmlHeaders({ private: true })).type('text/plain').send('Something went wrong on our side. Please try again.');
    });
    app.locals.consumer = consumer;
    return app;
}

module.exports = { createApp };
