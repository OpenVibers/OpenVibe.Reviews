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
const { gracefulStop } = require('openvibe-sdk/service');

/**
 * The process stop (openvibe-sdk/service, plan T1): the job timers and the Events outbox relay stop taking new
 * work, then the HTTP server drains (in-flight requests get 8 s), then the database closes — today's order. Past
 * the 10 s deadline the process exits 0, as the hand-rolled timer did. `closeDb` is false when a test handed in
 * its own database (start's `givenDb`), which stays open. `exit` and `signals` are injectable so a test can watch
 * the stop and no test process installs signal handlers.
 */
function createLifecycle({ server, db, valkey = null, platform, timers = [], closeDb = true, exit, signals, log } = {}) {
    return gracefulStop({
        name: 'Reviews', server, log, drainMs: 8000, deadlineMs: 10000, deadlineExitCode: 0, exit, signals,
        stop: [
            () => timers.forEach((t) => { clearInterval(t); clearTimeout(t); }),
            () => platform.outbox.stop(),
        ],
        close: [
            () => { if (closeDb) return db.close(); },
            () => { if (valkey) return valkey.close(); },
        ],
    });
}

async function start({ config, db: givenDb = null, now = () => Date.now(), fetchImpl = globalThis.fetch, tokens = null, publicKey = null, log = console, listen = true, workers = listen, rateLimits = true, limitsNow = null, indexnow: givenIndexnow = undefined, signals = false, exit = () => {} } = {}) {
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
    const app = createApp({ config, svc, viewers, platform, sources, sync, keys, db, log, rateLimits, fetchImpl, limitsNow, indexnow });

    // Search holds whatever the current rules say (idempotent: unchanged documents are not re-sent).
    try { await svc.reconcileIndex(); } catch (err) { log.warn(`[Reviews] index reconcile: ${err.message}`); }

    const timers = [];
    if (workers) {
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
        await new Promise((resolve) => { server = app.listen(config.port, config.host, resolve); });
        server.keepAliveTimeout = 65000;
        log.log(`[Reviews] ${config.nodeEnv} on http://${config.host}:${config.port} → ${config.baseUrl}`);
    }

    const lifecycle = createLifecycle({ server, db, platform, timers, closeDb: !givenDb, signals, exit, log });

    async function stop() {
        return lifecycle.stop('stop');
    }
    return { app, db, svc, sync, stores, platform, keys, viewers, indexnow, server, config, timers, lifecycle, stop };
}

module.exports = { start, createLifecycle };

if (require.main === module) {
    require('dotenv').config();
    start({ signals: true, exit: (code) => process.exit(code) }).catch((err) => {
        console.error('[Reviews] failed to start:', err);
        process.exit(1);
    });
}
