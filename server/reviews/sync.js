'use strict';
/**
 * How review items get from OpenVibe.Sources into Reviews. Two paths feed the same applyItem():
 *
 *   pull   GET /api/v1/items?category=reviews&include_removed=1&after=<change_seq> in change order
 *          (sources.item.read). The cursor is stored after each page, so a restart resumes where it
 *          stopped and a missed event is caught up on the next pass.
 *   push   sources.item.created|updated|removed events from OpenVibe.Events (signed webhook +
 *          inbox, server/http/consumer.js). Created/updated items are queued here and fetched by
 *          id (event payloads carry no fields); a removal is applied at once.
 *
 * A failed fetch leaves everything as it was and is retried with backoff: nothing is invented to
 * fill the gap, and a signal is never created from anything but an item Sources returned.
 */
const BACKOFF_MS = [15000, 60000, 5 * 60000, 30 * 60000, 2 * 3600000];
const CURSOR = 'sources.items.after';

function createSourcesSync({ db, svc, platform, config, now = () => Date.now(), log = console }) {
    const q = {
        get: db.prepare('SELECT value FROM review_sync_state WHERE name = ?'),
        put: db.prepare('INSERT INTO review_sync_state (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'),
        enqueue: db.prepare(`INSERT INTO review_import_queue (item_id, reason, enqueued_at, next_attempt_at) VALUES (?, ?, ?, 0)
                             ON CONFLICT (item_id) DO UPDATE SET reason = excluded.reason, next_attempt_at = 0`),
        due: db.prepare('SELECT * FROM review_import_queue WHERE next_attempt_at <= ? ORDER BY enqueued_at LIMIT ?'),
        done: db.prepare('DELETE FROM review_import_queue WHERE item_id = ?'),
        failed: db.prepare('UPDATE review_import_queue SET attempts = attempts + 1, next_attempt_at = ?, last_error = ? WHERE item_id = ?'),
        pending: db.prepare('SELECT COUNT(*) AS n FROM review_import_queue'),
    };
    const system = { kind: 'system', service: 'svc:reviews' };
    const state = (name) => { const r = q.get.get(name); return r ? r.value : null; };
    const setState = (name, value) => q.put.run(name, value == null ? null : String(value), now());

    let pulling = null;
    let draining = null;

    async function pullOnce({ maxPages = 25 } = {}) {
        if (!platform.sources.configured) return { ok: false, reason: 'OpenVibe.Sources is not configured' };
        const counts = { pages: 0, applied: 0, unchanged: 0, skipped: 0 };
        let after = Number(state(CURSOR) || 0);
        const known = new Set();
        const infos = new Map();
        try {
            for (let page = 0; page < maxPages; page++) {
                const body = await platform.sources.listItems({ after, limit: config.sync.pageSize });
                counts.pages++;
                for (const key of new Set(body.items.map((i) => i.source_key))) {
                    if (known.has(key)) continue;
                    known.add(key);
                    if (db.prepare('SELECT 1 FROM review_sources WHERE key = ?').get(key)) continue;
                    try { const full = await platform.sources.getSource(key); if (full) infos.set(key, full); } catch { /* notes still come with the item */ }
                }
                svc.batch(() => {
                    for (const item of body.items) {
                        const info = { ...(infos.get(item.source_key) || {}), ...((body.sources && body.sources[item.source_key]) || {}) };
                        try {
                            const out = svc.applyItem(item, { sourceInfo: info, actor: system });
                            if (out.outcome === 'unchanged') counts.unchanged++; else counts.applied++;
                        } catch (err) {
                            if (err && err.status && err.status < 500) { counts.skipped++; log.warn(`[Reviews] item ${item && item.id} skipped: ${err.message}`); } else throw err;
                        }
                    }
                });
                if (Number.isInteger(body.next_after) && body.next_after >= after) { after = body.next_after; setState(CURSOR, after); }
                if (!body.more) break;
            }
            setState('sources.last_pull_ok_at', new Date(now()).toISOString());
            return { ok: true, after, ...counts };
        } catch (err) {
            setState('sources.last_pull_error', `${new Date(now()).toISOString()} ${String(err && err.message).slice(0, 300)}`);
            return { ok: false, reason: err && err.message, after, ...counts };
        }
    }

    async function drainQueue({ limit = 50 } = {}) {
        if (!platform.sources.configured) return { ok: false, reason: 'OpenVibe.Sources is not configured', done: 0 };
        let done = 0;
        let failed = 0;
        for (const row of q.due.all(now(), limit)) {
            try {
                await svc.importItem(row.item_id, platform.sources, system);
                q.done.run(row.item_id);
                done++;
            } catch (err) {
                // A 404/422 is final (the item is gone or unusable); anything else is retried.
                if (err && (err.status === 404 || err.status === 422)) { q.done.run(row.item_id); log.warn(`[Reviews] queued item ${row.item_id} dropped: ${err.message}`); continue; }
                q.failed.run(now() + BACKOFF_MS[Math.min(row.attempts, BACKOFF_MS.length - 1)], String(err && err.message).slice(0, 500), row.item_id);
                failed++;
            }
        }
        return { ok: true, done, failed };
    }

    return {
        enqueue(itemId, reason) { q.enqueue.run(String(itemId), String(reason || 'event').slice(0, 60), now()); },
        pending: () => q.pending.get().n,
        cursor: () => Number(state(CURSOR) || 0),
        state,
        pull(opts) { if (!pulling) pulling = pullOnce(opts).finally(() => { pulling = null; }); return pulling; },
        drain(opts) { if (!draining) draining = drainQueue(opts).finally(() => { draining = null; }); return draining; },
    };
}

module.exports = { createSourcesSync };
