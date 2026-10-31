'use strict';
/**
 * OpenVibe.Reviews entry point.
 *
 *   node server/index.js            (systemd: openvibe-reviews.service, port 4830)
 *
 * start() is also what the tests use: it takes a config (server/config.js load()) plus injectable
 * clock/fetch/log/tokens/keys, and returns handles to every part. Workers (the Sources pull, the
 * import queue, the Events outbox relay) run only when asked (`workers: true`).
 */
const { createSourcesClient } = require('openvibe-publishing/ingest');
const { load } = require('./config');
const { openDb, createStores } = require('./db');
const { createPlatform } = require('./integrations/platform');
const { createReviewsService } = require('./reviews/service');
const { createSourcesSync } = require('./reviews/source-items');
const { createKeyStore } = require('./auth/keys');
const { createViewerResolver } = require('./auth/viewer');
const { createApp } = require('./app');
const { createIndexNow } = require('openvibe-shared/indexnow');
const { gracefulStop, createHttpTelemetry } = require('openvibe-sdk/service');
const { createNetworkSender, startSubscriptions } = require('openvibe-sdk/account-data');
const accountDataLib = require('./reviews/account-data');
const { createPgTelemetrySink, startTelemetryRetention } = require('openvibe-sdk/telemetry');

/**
 * The process stop (openvibe-sdk/service, plan T1): the job timers and the Events outbox relay stop taking new
 * work, then the HTTP server drains (in-flight requests get 8 s), then the database closes — today's order. Past
 * the 10 s deadline the process exits 0, as the hand-rolled timer did. `closeDb` is false when a test handed in
 * its own database (start's `givenDb`), which stays open. `exit` and `signals` are injectable so a test can watch
 * the stop and no test process installs signal handlers.
 */
function createLifecycle({ server, db, valkey = null, platform, timers = [], telemetry = null, retention = null, closeDb = true, exit, signals, log, subscriptions = null, background = null } = {}) {
    return gracefulStop({
        name: 'Reviews', server, log, drainMs: 8000, deadlineMs: 10000, deadlineExitCode: 0, exit, signals,
        stop: [
            () => timers.forEach((t) => { clearInterval(t); clearTimeout(t); }),
            () => platform.outbox.stop(),
            () => { if (subscriptions) subscriptions.stop(); },
        ],
        close: [
            async () => { if (retention) await retention.stop(); if (telemetry) await telemetry.stop(); },
            async () => { if (background) await background(); },
            () => { if (closeDb) return db.close(); },
            () => { if (valkey) return valkey.close(); },
        ],
    });
}

async function start({ config, db: givenDb = null, now = () => Date.now(), fetchImpl = globalThis.fetch, tokens = null, publicKey = null, log = console, telemetrySink = null, listen = true, workers = listen, rateLimits = true, limitsNow = null, indexnow: givenIndexnow = undefined, signals = false, exit = () => {}, send: givenSend = null } = {}) {
    config = config || load();
    // PostgreSQL (ADR-035): opened and migrated here unless the caller (a test) hands in a migrated handle.
    const db = givenDb || await openDb(config, { log });
    const stores = createStores(db, { now });
    const platform = createPlatform({ config, db, fetchImpl, tokens, now, log });
    // The Sources client is the ingest chassis (openvibe-publishing/ingest): the client-credentials
    // token for audience openvibe.sources and the change-order items API live there now.
    const sources = createSourcesClient({ config, fetchImpl, now });
    // IndexNow (openvibe-shared/indexnow): created once at boot from INDEXNOW_KEY. Unset → off, nothing
    // mounted, nothing sent; tests and drills never set it (nor hand one in).
    const indexnow = givenIndexnow !== undefined ? givenIndexnow : createIndexNow({ host: config.baseUrl, key: config.indexnow.key, fetch: fetchImpl, log });
    const svc = createReviewsService({ db, stores, outbox: platform.outbox, config, now, log, indexnow });
    const sync = createSourcesSync({ db, svc, sources, config, now, log });
    const keys = createKeyStore({ config, fetchImpl, log, publicKey });
    keys.ensure().catch(() => {});
    const viewers = createViewerResolver({ keys, config });
    // Request telemetry (openvibe-sdk/service, plan T1): one aggregated sample per route template, method and status
    // class each flush, stored in this service's telemetry_samples table (app.js mounts the middleware). With workers
    // on, a one-minute tick writes each interval (the collector has no timer of its own) and the table keeps 14 days.
    const telemetry = createHttpTelemetry({ service: 'reviews', sink: telemetrySink || createPgTelemetrySink({ db, log }), skipPrefixes: ['/shared'], intervalMs: 60_000 });
    let retention = null;
    // Account export and deletion (ADR-033): the table map over the service, and the sender to Network's internal routes
    // with Reviews' own client-credentials token (a test hands in a stand-in).
    const accountData = accountDataLib.create({ db, svc, log });
    const accountSend = givenSend || (config.oauth.clientSecret
        ? createNetworkSender({ networkInternalUrl: config.networkInternalUrl, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, fetch: fetchImpl })
        : null);
    const app = createApp({ config, telemetry, svc, viewers, platform, sources, sync, keys, db, log, rateLimits, fetchImpl, limitsNow, indexnow, accountData, accountSend });

    // Search holds whatever the current rules say (idempotent: unchanged documents are not re-sent). A running service
    // does it after it listens: 6,800 entities took 30 s on 2026-10-18, past ovhost's readiness wait, and the deploy
    // was rolled back. Without workers (tests, one-off scripts) it is done before start() returns.
    let stopping = false;
    let reconciling = null;
    const reconcile = () => svc.reconcileIndex({ stopped: () => stopping })
        .then((r) => { if (r.sent) log.log(`[Reviews] index reconcile: ${r.sent} document(s) re-sent`); })
        .catch((err) => log.warn(`[Reviews] index reconcile: ${err.message}`));
    if (!workers) await reconcile();

    const timers = [];
    if (workers) {
        timers.push(setInterval(() => { telemetry.flush().catch(() => {}); }, 60_000));
        retention = startTelemetryRetention({ db, log, olderThanDays: 14 });
        if (config.sync.enabled && sources.enabled) {
            const pull = () => sync.pull().then((r) => { if (!r.ok) log.warn(`[Reviews] Sources pull: ${r.reason}`); }).catch((err) => log.warn(`[Reviews] Sources pull: ${err.message}`));
            timers.push(setTimeout(pull, 5000));
            timers.push(setInterval(pull, config.sync.intervalMs));
            timers.push(setInterval(() => sync.drain().catch((err) => log.warn(`[Reviews] import queue: ${err.message}`)), config.sync.queueIntervalMs));
        }
        if (platform.eventsConfigured) platform.outbox.start();
        for (const t of timers) if (t.unref) t.unref();
    }

    let server = null;
    if (listen) {
        // Socket activation (2026-10-31): systemd's .socket unit holds the listener across restarts, so a deploy
        // queues requests in the kernel instead of answering 502. Without the socket unit, the usual listen.
        const socketActivated = process.env.LISTEN_FDS === '1' && Number(process.env.LISTEN_PID) === process.pid;
        await new Promise((resolve) => { server = app.listen(...(socketActivated ? [{ fd: 3 }] : [config.port, config.host]), resolve); });
        server.keepAliveTimeout = 65000;
        log.log(`[Reviews] ${config.nodeEnv} on http://${config.host}:${config.port} → ${config.baseUrl}`);
    }
    if (workers) reconciling = reconcile();
    // The two account subscriptions at OpenVibe.Events, created when missing; off without workers, EVENTS_URL,
    // REVIEWS_EVENTS_SECRET or the client secret.
    let subscriptions = null;
    if (workers && listen) {
        subscriptions = startSubscriptions({
            eventsUrl: config.eventsUrl, endpoint: `http://127.0.0.1:${config.port}/internal/account-events`, secret: (config.eventsWebhookSecrets || [])[0],
            networkInternalUrl: config.networkInternalUrl, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, fetch: fetchImpl, log,
        });
    }

    const lifecycle = createLifecycle({ server, db, telemetry, retention, platform, timers, closeDb: !givenDb, signals, exit, log, subscriptions,
        background: async () => { stopping = true; if (reconciling) await reconciling; } });

    async function stop() {
        return lifecycle.stop('stop');
    }
    return { app, db, telemetry, svc, sync, stores, platform, keys, viewers, indexnow, server, config, timers, lifecycle, stop };
}

module.exports = { start, createLifecycle };

if (require.main === module) {
    require('dotenv').config();
    start({ signals: true, exit: (code) => process.exit(code) }).catch((err) => {
        console.error('[Reviews] failed to start:', err);
        process.exit(1);
    });
}
