'use strict';
/**
 * OpenVibe.Reviews — Express app factory. server/index.js starts it; tests build their own.
 *
 *   Pages (SSR, useful without JavaScript)      server/http/pages.js
 *   /api/v1 (people and service principals)     server/http/api.js
 *   POST /internal/events (signed webhook)      server/http/consumer.js
 *   Discovery: robots, sitemaps, feeds, llms    server/http/machine.js
 *   /auth/* (Network SSO)                       server/auth/session.js
 *   GET /api/health, /api/ready, /release.json, /metrics (loopback only)
 */
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const { createReadiness } = require('openvibe-shared/ready');
const { http } = require('openvibe-contracts');
const { createSessionRoutes } = require('./auth/session');
const { createApi } = require('./http/api');
const { createPages } = require('./http/pages');
const { createMachine } = require('./http/machine');
const { consumerRouter } = require('./http/consumer');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VERSION = require('../package.json').version;

function createApp({ config, svc, viewers, platform, sync, keys, db, log = console, rateLimits = true, fetchImpl = globalThis.fetch }) {
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);
    // One W3C trace across services (openvibe-shared/trace): calls made while serving a request carry its traceparent.
    require('openvibe-shared/trace').install(app);

    const release = require('openvibe-shared/release').createRelease({ service: 'reviews', root: path.join(__dirname, '..') });
    const metrics = require('openvibe-shared/metrics').instrument(app, { service: 'reviews', release: release.release });
    metrics.registry.gauge({
        name: 'reviews_event_outbox', help: 'Events in the outbox by state', labelNames: ['state'],
        collect: () => [{ labels: { state: 'pending' }, value: platform.outbox.pending() }, { labels: { state: 'rejected' }, value: platform.outbox.rejected() }],
    });
    metrics.registry.gauge({
        name: 'reviews_work', help: 'Editorial and import backlog', labelNames: ['kind'],
        collect: () => {
            const s = svc.stats();
            return [
                { labels: { kind: 'items_unresolved' }, value: s.items_unresolved },
                { labels: { kind: 'corrections_open' }, value: s.corrections_open },
                { labels: { kind: 'summaries_flagged' }, value: s.summaries_flagged },
                { labels: { kind: 'import_queue' }, value: sync.pending() },
            ];
        },
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
            "connect-src 'self' https://openvibe.network",
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

    // Signed deliveries from OpenVibe.Events. Loopback/internal only in nginx (not proxied publicly).
    const consumer = consumerRouter({ db, svc, sync, config, log });
    app.use('/internal', http.middleware(), consumer.router);

    app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'openvibe-reviews', version: VERSION }));
    // GET /release.json (ADR-016) and POST /release-metrics: open tabs' update reports into /metrics.
    release.mount(app, { registry: metrics.registry });
    const ready = createReadiness({
        service: 'reviews', release: release.release,
        checks: [
            { name: 'db', required: true, check: () => db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('review_entities','review_signals','review_summary_revisions')").get().n === 3 || 'review tables missing' },
            { name: 'network_jwks', required: false, check: () => { if (keys.loaded()) return true; keys.ensure().catch(() => {}); return 'Network signing key not loaded yet: sign-in and token calls answer 503'; } },
            { name: 'sources', required: false, check: () => platform.sources.configured || 'not configured: no review items are read, so no signals and no aggregates exist' },
            { name: 'events_relay', required: false, check: () => (platform.eventsConfigured ? true : 'EVENTS_URL or the service principal is not configured: events wait in the outbox') },
            { name: 'events_webhook', required: false, check: () => (config.eventsWebhookSecrets.length ? true : 'REVIEWS_EVENTS_SECRET is not set: sources.item.* deliveries are refused; the pull sync still runs') },
            { name: 'community', required: false, check: () => platform.community.configured || 'not configured: discussions show as unavailable' },
            { name: 'editors', required: false, check: () => (svc.access.editorCount() ? true : 'REVIEWS_EDITORS is empty: only Network staff can edit') },
        ],
        details: () => ({
            outbox: { pending: platform.outbox.pending(), rejected: platform.outbox.rejected() },
            sources: { cursor: sync.cursor(), import_queue: sync.pending(), last_pull_ok_at: sync.state('sources.last_pull_ok_at'), last_pull_error: sync.state('sources.last_pull_error') },
            backlog: svc.stats(),
        }),
    });
    app.get('/api/ready', ready.handler);

    app.use('/api/', limiter(60000, 300));
    app.use('/api/v1/entities/:ref/corrections', limiter(60 * 60000, 20));
    app.use('/api/v1', createApi({ svc, viewers, platform, sync, config, log }));
    app.use('/api', (req, res) => http.sendProblem(res, 404, 'route.not_found', { detail: 'Not found' }));

    app.use(express.static(PUBLIC_DIR, {
        index: false, redirect: false,
        setHeaders(res) { res.setHeader('Cache-Control', res.req && res.req.query && res.req.query.v ? 'public, max-age=31536000, immutable' : 'public, max-age=3600'); },
    }));
    app.use(createMachine({ svc, config }));

    app.post(['/e/*', '/editor/*'], limiter(10 * 60000, 120));
    app.post('/e/:slug/correct', limiter(60 * 60000, 20));
    const pages = createPages({ svc, platform, sync, viewers, config, log });
    app.use(pages.router);

    app.use((req, res) => pages.errorPage(req, res, 404, 'Not found', 'Nothing lives at that address.'));
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, _next) => {
        log.error('[Reviews]', err && err.stack ? err.stack : err);
        if (res.headersSent) return;
        if (req.path.startsWith('/api/')) return http.sendProblem(res, 500, 'internal.error', { detail: 'Internal error' });
        res.status(500).set('Cache-Control', 'private, no-store').type('text/plain').send('Something went wrong on our side. Please try again.');
    });
    app.locals.consumer = consumer;
    return app;
}

module.exports = { createApp };
