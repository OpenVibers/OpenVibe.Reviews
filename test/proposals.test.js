'use strict';
/**
 * Proposals for OpenVibe.Contracts are valid against the contracts' own schemas and match what the
 * code enforces; the nine §15.13 tables exist; nothing that looks like content is seeded.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const contracts = require('openvibe-contracts');
const { CAPS } = require('../server/auth/capabilities');
const { openDb, createStores, AUTHORITY_TABLES } = require('../server/db');
const { suite, boot } = require('./helpers');

const t = suite('proposals');
const DOCS = path.join(__dirname, '..', 'docs');
const SRC = path.join(__dirname, '..', 'server');

function sourceFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sourceFiles(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
}

t('capability proposals are valid capabilities.capability@1 and cover exactly the guarded ids', () => {
    const dir = path.join(DOCS, 'capabilities-proposal');
    const ids = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
        const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const v = contracts.validate('capabilities.capability@1', m);
        assert.ok(v.valid, `${f}: ${JSON.stringify(v.errors)}`);
        assert.strictEqual(`${m.id}.json`, f);
        assert.strictEqual(m.owner, 'reviews');
        assert.ok(m.id.split('.').length === 3);
        return m.id;
    });
    assert.deepStrictEqual(ids.sort(), Object.values(CAPS).sort());
    const guarded = new Set();
    for (const f of sourceFiles(SRC)) for (const m of fs.readFileSync(f, 'utf8').matchAll(/guard\('([a-z0-9_.]+)'\)/g)) guarded.add(m[1]);
    assert.deepStrictEqual([...guarded].sort(), Object.values(CAPS).sort());
    for (const id of ['reviews.entity.resolve', 'reviews.entity.merge', 'reviews.entity.split', 'reviews.signal.import', 'reviews.summary.publish', 'reviews.correction.submit']) assert.ok(ids.includes(id), `§15.13 minimum capability ${id}`);
});

t('the service manifest proposal is a valid registry.service-manifest@1 and lists the §15.13 events', () => {
    const m = JSON.parse(fs.readFileSync(path.join(DOCS, 'service-manifest-proposal.json'), 'utf8'));
    const v = contracts.validate('registry.service-manifest@1', m);
    assert.ok(v.valid, JSON.stringify(v.errors));
    assert.deepStrictEqual([...m.capabilities].sort(), Object.values(CAPS).sort());
    for (const ev of ['reviews.entity.merged', 'reviews.entity.split', 'reviews.signal.added', 'reviews.signal.removed', 'reviews.summary.published', 'reviews.summary.updated']) assert.ok(m.eventsProduced.includes(ev), ev);
    assert.ok(m.eventsConsumed.includes('sources.item.removed'));
    // Every event type the code can enqueue is declared.
    const produced = new Set();
    for (const f of sourceFiles(SRC)) for (const x of fs.readFileSync(f, 'utf8').matchAll(/(?:entityEvent|signalEvent)\('([a-z_.]+)'/g)) produced.add(x[1]);
    assert.ok(produced.size >= 4);
    for (const ev of produced) assert.ok(m.eventsProduced.includes(ev), `undeclared event ${ev}`);
});

t('the nine authority tables exist; a fresh database holds no content', async () => {
    const db = openDb(':memory:');
    createStores(db);
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    assert.strictEqual(AUTHORITY_TABLES.length, 9);
    for (const name of AUTHORITY_TABLES) assert.ok(tables.has(name), name);
    for (const name of [...tables].filter((n) => n.startsWith('review_'))) {
        assert.strictEqual(db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n, 0, `${name} is empty`);
    }
    // Booting the service seeds nothing either.
    const h = await boot();
    try {
        for (const name of ['review_entities', 'review_signals', 'review_summaries', 'review_aggregates', 'review_sources', 'review_source_items']) {
            assert.strictEqual(h.db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n, 0, name);
        }
    } finally { await h.stop(); }
    assert.ok(!fs.existsSync(path.join(__dirname, '..', 'seeds')), 'no seed directory');
});
