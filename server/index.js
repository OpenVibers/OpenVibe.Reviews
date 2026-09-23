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
const { load } = require('./config');
const { openDb, createStores } = require('./db');
const { createPlatform } = require('./integrations/platform');
const { createReviewsService } = require('./reviews/service');
const { createSourcesSync } = require('./reviews/sync');
const { createKeyStore } = require('./auth/keys');
const { createViewerResolver } = require('./auth/viewer');
const { createApp } = require('./app');

async function start({ config, now = () => Date.now(), fetchImpl = globalThis.fetch, tokens = null, publicKey = null, log = console, listen = true, workers = listen, rateLimits = true } = {}) {
    config = config || load();
    const db = openDb(config.dbPath);
    const stores = createStores(db, { now });
    const platform = createPlatform({ config, db, fetchImpl, tokens, now, log });
    const svc = createReviewsService({ db, stores, outbox: platform.outbox, config, now, log });
    const sync = createSourcesSync({ db, svc, platform, config, now, log });
    const keys = createKeyStore({ config, fetchImpl, log, publicKey });
    keys.ensure().catch(() => {});
    const viewers = createViewerResolver({ keys, config });
    const app = createApp({ config, svc, viewers, platform, sync, keys, db, log, rateLimits, fetchImpl });

    // Search holds whatever the current rules say (idempotent: unchanged documents are not re-sent).
    try { svc.reconcileIndex(); } catch (err) { log.warn(`[Reviews] index reconcile: ${err.message}`); }

    const timers = [];
    if (workers) {
        if (config.sync.enabled && platform.sources.configured) {
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

    async function stop() {
        for (const t of timers) { clearInterval(t); clearTimeout(t); }
        await platform.outbox.stop();
        if (server) await new Promise((resolve) => server.close(resolve));
        db.close();
    }
    return { app, db, svc, sync, stores, platform, keys, viewers, server, config, stop };
}

module.exports = { start };

if (require.main === module) {
    require('dotenv').config();
    start().then((h) => {
        const shutdown = (signal) => {
            console.log(`[Reviews] ${signal} — closing`);
            h.stop().finally(() => process.exit(0));
            setTimeout(() => process.exit(0), 10000).unref();
        };
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));
    }).catch((err) => {
        console.error('[Reviews] failed to start:', err);
        process.exit(1);
    });
}
