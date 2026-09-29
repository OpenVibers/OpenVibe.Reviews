'use strict';
/**
 * How review items get from OpenVibe.Sources into Reviews.
 *
 * The chassis (openvibe-publishing/ingest) owns the Sources client, the change cursor and the pull
 * loop: one transaction per page (the page's writes and the cursor advance commit together), one
 * savepoint per item (a bad item is isolated and counted, never stalling the page). This module keeps
 * Reviews' domain half and its own policy:
 *
 *   pull   GET /api/v1/items?category=reviews&include_removed=1&after=<change_seq> in change order
 *          (sources.item.read), from the cursor in review_ingest_cursor. A restart resumes where it
 *          stopped and a missed event is caught up on the next pass.
 *   push   sources.item.created|updated|removed events from OpenVibe.Events (signed webhook + inbox,
 *          server/http/events.js). Created/updated items are queued here (event payloads carry no
 *          fields) and fetched by id; a removal is applied at once.
 *
 * A failed fetch leaves everything as it was and is retried with backoff: nothing is invented to fill
 * the gap, and a signal is never created from anything but an item Sources returned.
 */
const { createChangeCursor, pullChanges } = require('openvibe-publishing/ingest');

const BACKOFF_MS = [15000, 60000, 5 * 60000, 30 * 60000, 2 * 3600000];
const CURSOR = 'sources';   // the chassis cursor name; the old key sources.items.after is carried once by migration 0002

/** applyItem's own outcome → the chassis' three pull outcomes ('applied' | 'hold' | 'removed'). */
const PULL_OUTCOME = {
    created: 'applied', updated: 'applied',
    removed: 'removed', 'removed:unknown': 'removed',
    unchanged: 'hold',
    'ignored:category': 'hold', 'ignored:removed': 'hold', 'ignored:older_revision': 'hold', 'ignored:unknown_item': 'hold',
};

function createSourcesSync({ db, svc, sources, config, now = () => Date.now(), log = console }) {
    const cursor = createChangeCursor(db, { prefix: 'review', now });
    const q = {
        get: db.prepare('SELECT value FROM review_sync_state WHERE name = ?'),
        put: db.prepare('INSERT INTO review_sync_state (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'),
        enqueue: db.prepare(`INSERT INTO review_import_queue (item_id, reason, enqueued_at, next_attempt_at) VALUES (?, ?, ?, 0)
                             ON CONFLICT (item_id) DO UPDATE SET reason = excluded.reason, next_attempt_at = 0`),
        due: db.prepare('SELECT * FROM review_import_queue WHERE next_attempt_at <= ? ORDER BY enqueued_at LIMIT ?'),
        done: db.prepare('DELETE FROM review_import_queue WHERE item_id = ?'),
        failed: db.prepare('UPDATE review_import_queue SET attempts = attempts + 1, next_attempt_at = ?, last_error = ? WHERE item_id = ?'),
        pending: db.prepare('SELECT COUNT(*) AS n FROM review_import_queue'),
        sourceExists: db.prepare('SELECT 1 FROM review_sources WHERE key = ?'),
    };
    const system = { kind: 'system', service: 'svc:reviews' };
    const state = async (name) => { const r = await q.get.get(name); return r ? r.value : null; };
    const setState = async (name, value) => await q.put.run(name, value == null ? null : String(value), now());

    let pulling = null;
    let draining = null;

    // The page's source health and registry records, merged into the applyItem sourceInfo (as before).
    let pageHealth = {};
    const infos = new Map();
    const pageSource = {
        async listItems(opts) {
            const body = await sources.listItems(opts);
            pageHealth = body.sources || {};
            for (const key of new Set((body.items || []).map((i) => i.source_key).filter(Boolean))) {
                if (infos.has(key)) continue;
                if (await q.sourceExists.get(key)) { infos.set(key, null); continue; }
                try { const full = await sources.getSource(key); infos.set(key, full || null); } catch { infos.set(key, null); }
            }
            return body;
        },
    };

    async function pullOnce({ maxPages = config.sync.maxPages } = {}) {
        if (!sources.enabled) return { ok: false, reason: 'OpenVibe.Sources is not configured' };
        const counts = { pages: 0, applied: 0, unchanged: 0, skipped: 0, hold: 0, removed: 0, failed: 0 };
        try {
            const summary = await pullChanges({
                db, cursor, source: pageSource, name: CURSOR,
                maxPages, pageSize: config.sync.pageSize,
                apply: async (item) => {
                    const info = { ...(infos.get(item.source_key) || {}), ...(pageHealth[item.source_key] || {}) };
                    const out = await svc.applyItem(item, { sourceInfo: info, actor: system });
                    if (out.outcome === 'unchanged') counts.unchanged++;
                    else if (String(out.outcome).startsWith('ignored')) counts.skipped++;
                    else counts.applied++;
                    return PULL_OUTCOME[out.outcome] || 'applied';
                },
                onItem: (item, err, outcome) => { if (outcome === 'failed') log.warn(`[Reviews] item ${item && item.id} skipped: ${err && err.message}`); },
            });
            counts.pages = summary.pages;
            counts.hold = summary.hold;
            counts.removed = summary.removed;
            counts.failed = summary.failed;
            await setState('sources.last_pull_ok_at', new Date(now()).toISOString());
            return { ok: true, after: summary.after, ...counts };
        } catch (err) {
            await setState('sources.last_pull_error', `${new Date(now()).toISOString()} ${String(err && err.message).slice(0, 300)}`);
            return { ok: false, reason: err && err.message, ...counts };
        }
    }

    async function drainQueue({ limit = 50 } = {}) {
        if (!sources.enabled) return { ok: false, reason: 'OpenVibe.Sources is not configured', done: 0 };
        let done = 0;
        let failed = 0;
        for (const row of await q.due.all(now(), limit)) {
            try {
                await svc.importItem(row.item_id, sources, system);
                await q.done.run(row.item_id);
                done++;
            } catch (err) {
                // A 404/422 is final (the item is gone or unusable); anything else is retried.
                if (err && (err.status === 404 || err.status === 422)) { await q.done.run(row.item_id); log.warn(`[Reviews] queued item ${row.item_id} dropped: ${err.message}`); continue; }
                await q.failed.run(now() + BACKOFF_MS[Math.min(row.attempts, BACKOFF_MS.length - 1)], String(err && err.message).slice(0, 500), row.item_id);
                failed++;
            }
        }
        return { ok: true, done, failed };
    }

    return {
        async enqueue(itemId, reason) { await q.enqueue.run(String(itemId), String(reason || 'event').slice(0, 60), now()); },
        pending: async () => (await q.pending.get()).n,
        cursor: async () => await cursor.get(CURSOR),
        state,
        pull(opts) { if (!pulling) pulling = pullOnce(opts).finally(() => { pulling = null; }); return pulling; },
        drain(opts) { if (!draining) draining = drainQueue(opts).finally(() => { draining = null; }); return draining; },
    };
}

module.exports = { createSourcesSync, CURSOR };
