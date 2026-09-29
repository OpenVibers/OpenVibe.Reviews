'use strict';
/**
 * The Reviews ingest golden fixture: a deterministic Sources feed and the canonical projection of the
 * domain rows it produces (entities, aliases, source items, signals, the current aggregate per entity).
 * The same fixture and projection run before and after the chassis conversion, so test/chassis.test.js
 * can compare the projection to test/fixtures/ingest-golden.json (captured from the pre-conversion
 * code). Volatile values (ULID ids, timestamps) are left out so only domain meaning is compared.
 */
const { createEntity, steamItem, productItem } = require('../helpers');

const SRC = 'steam-reviews-portal-2';
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

/** Add the fixture's items to the Sources mock (same order and fields as the capture run). → items */
async function feedFixture(h) {
    await createEntity(h, { name: 'Portal 2', kind: 'game', aliases: [{ type: 'source', value: SRC }] });
    const a = h.sources.put(steamItem({ votedUp: true, identity: 'review-a' }));
    const b = h.sources.put(steamItem({ votedUp: false, identity: 'review-b' }));
    const p = h.sources.put(productItem({ url: 'https://shop.example/p/widget', title: 'Widget 3000', gtin: '0012345678905' }));
    const ignored = h.sources.put({ ...steamItem({ identity: 'review-c' }), category: 'blog' });   // not review: skipped
    return { a, b, p, ignored };
}

/** A revision upstream (vote flipped) and a removal, applied by a second pull. */
function reviseFixture(h, it) {
    h.sources.revise(it.a.id, { voted_up: false });
    h.sources.remove(it.b.id, 'takedown');
}

/** The canonical projection of the domain rows. Deterministic in everything but ids. */
async function project(h) {
    const db = h.db;
    // ULID ids are volatile between runs: map them to stable domain keys (a Sources item's identity,
    // a signal's item#revision, an entity's name) so only domain meaning is compared.
    const itmMap = new Map((await db.prepare('SELECT id, identity FROM review_source_items').all()).map((r) => [r.id, r.identity]));
    const entMap = new Map((await db.prepare('SELECT id, name FROM review_entities').all()).map((r) => [r.id, r.name]));
    const sigMap = new Map((await db.prepare('SELECT id, source_item_id, item_revision FROM review_signals').all())
        .map((r) => [r.id, `${itmMap.get(r.source_item_id) || r.source_item_id}#${r.item_revision}`]));
    const iid = (id) => itmMap.get(id) || id;
    const entities = (await db.prepare('SELECT name, kind, state FROM review_entities ORDER BY lower(name)').all())
        .map((e) => ({ name: e.name, kind: e.kind, state: e.state }));
    const aliases = (await db.prepare(`SELECT a.type, a.norm, e.name AS entity FROM review_entity_aliases a
                                        JOIN review_entities e ON e.id = a.entity_id WHERE a.removed_at IS NULL ORDER BY a.type, a.norm`).all())
        .map((a) => ({ type: a.type, norm: a.norm, entity: a.entity }));
    const sources = (await db.prepare('SELECT key, name, status, stale, terms_note, license_note FROM review_sources ORDER BY key').all())
        .map((s) => ({ key: s.key, name: s.name, status: s.status, stale: s.stale, terms_note: s.terms_note, license_note: s.license_note }));
    const items = (await db.prepare(`SELECT i.id AS source_item_id, i.item_revision, i.source_key, i.kind, i.state, i.resolution, i.content_hash, e.name AS entity
                                     FROM review_source_items i LEFT JOIN review_entities e ON e.id = i.entity_id ORDER BY i.identity`).all())
        .map((r) => ({ item: iid(r.source_item_id), revision: r.item_revision, source_key: r.source_key, kind: r.kind, state: r.state, resolution: r.resolution, content_hash: r.content_hash, entity: r.entity || null }));
    const signals = (await db.prepare(`SELECT s.source_item_id, s.item_revision, s.type, s.status, s.recommended, s.positive_count, s.total_count, e.name AS entity
                                       FROM review_signals s LEFT JOIN review_entities e ON e.id = s.entity_id ORDER BY s.source_item_id, s.item_revision, s.type`).all())
        .map((s) => ({ item: iid(s.source_item_id), revision: s.item_revision, type: s.type, status: s.status, recommended: s.recommended, positive_count: s.positive_count, total_count: s.total_count, entity: s.entity || null }));
    const stable = (v) => {
        if (typeof v === 'string') return sigMap.get(v) || entMap.get(v) || (itmMap.get(v) ? `item:${itmMap.get(v)}` : v);
        if (Array.isArray(v)) return v.map(stable);
        if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) o[k] = stable(v[k]); return o; }
        return v;
    };
    const aggregates = (await db.prepare(`SELECT e.name AS entity, a.result FROM review_aggregates a
                                          JOIN review_entities e ON e.id = a.entity_id
                                          WHERE a.revision = (SELECT MAX(b.revision) FROM review_aggregates b WHERE b.entity_id = a.entity_id)
                                          ORDER BY lower(e.name)`).all())
        .map((a) => ({ entity: a.entity, result: stable(parse(a.result, null)) }));
    return { entities, aliases, sources, items, signals, aggregates };
}

module.exports = { feedFixture, reviseFixture, project, SRC };
