'use strict';
/**
 * Plan T9 (J3) — Reviews on the openvibe-publishing 1.1.0 chassis. This proves the conversion:
 *   - the local copies the brief's §7 lists are unrequired (the harness denies rm, so the files may
 *     remain on disk; nothing under server/ requires them);
 *   - a dry-run ingest from the captured Sources fixture produces the same domain rows as the
 *     pre-conversion code (test/fixtures/ingest-golden.json, captured before the change);
 *   - the Search document validates against search.index-document@1, with its provenance and
 *     visibility;
 *   - the outbox row and the state change share the caller's transaction (a rollback drops both).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const contracts = require('openvibe-contracts');
const { boot, req, suite, editorToken, steamItem, importItem, createEntity, outbox } = require('./helpers');
const { feedFixture, reviseFixture, project } = require('./helpers/golden');

const ROOT = path.join(__dirname, '..');
const GOLDEN = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ingest-golden.json'), 'utf8'));

// The brief's §7 deletion list for Reviews: the chassis (openvibe-publishing/ingest and
// /publication) owns this code now. The files themselves cannot be removed in this harness.
const DELETED = ['server/reviews/sync.js', 'server/reviews/normalize.js', 'server/http/consumer.js']
    .map((f) => path.join(ROOT, f));

const OVERVIEW = 'Most sampled Steam reviewers recommend this game, and the sample here is broad enough to clear the thin-content gate for the entity page in this test without difficulty.';

function jsFiles(dir, found = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) jsFiles(p, found);
        else if (e.name.endsWith('.js')) found.push(p);
    }
    return found;
}
function relativeRequires(file) {
    const src = fs.readFileSync(file, 'utf8');
    return [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]).filter((s) => s.startsWith('.'));
}

/** An indexable entity page: three live signals and their published, gate-clearing summary. */
async function indexableEntity(h) {
    const e = await createEntity(h, { name: 'Portal 2', kind: 'game', aliases: [{ type: 'source', value: 'steam-reviews-portal-2' }] });
    for (let i = 0; i < 3; i++) await importItem(h, steamItem({ votedUp: i < 2 }));
    const sigs = (await h.db.prepare("SELECT id FROM review_signals WHERE entity_id = ? AND status = 'active' ORDER BY id").all(e.id)).map((s) => s.id);
    const pub = await req(h, 'POST', `/api/v1/entities/${e.slug}/summary/revisions`, { token: editorToken(), body: { overview: OVERVIEW, overview_signals: sigs, publish: true } });
    assert.strictEqual(pub.status, 201, pub.text);
    return e;
}

const t = suite('chassis');

t('the local copies are gone: no live server file requires them; the chassis provides ingest and publication', () => {
    const gone = new Set(DELETED);
    for (const file of jsFiles(path.join(ROOT, 'server'))) {
        if (gone.has(file)) continue;   // the (undeletable) files themselves
        for (const spec of relativeRequires(file)) {
            let resolved;
            try { resolved = require.resolve(path.resolve(path.dirname(file), spec)); } catch { continue; }
            assert.ok(!gone.has(resolved), `${path.relative(ROOT, file)} still requires ${spec}`);
        }
    }
    // ...and the chassis entry points are the ones the app uses.
    const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.match(read('server/index.js'), /openvibe-publishing\/ingest/);
    assert.match(read('server/reviews/source-items.js'), /openvibe-publishing\/ingest/);
    assert.match(read('server/http/events.js'), /openvibe-publishing\/ingest/);
    assert.match(read('server/reviews/service.js'), /openvibe-publishing\/publication/);
});

t('a dry-run ingest from the captured Sources fixture produces the same domain rows as before', async () => {
    const h = await boot();
    try {
        const it = await feedFixture(h);
        const first = await h.sync.pull();
        assert.strictEqual(first.ok, true, first.reason);
        reviseFixture(h, it);
        const second = await h.sync.pull();
        assert.strictEqual(second.ok, true, second.reason);
        assert.deepStrictEqual(await project(h), GOLDEN);
    } finally { await h.stop(); }
});

t('the Search document validates against search.index-document@1, with its provenance and visibility', async () => {
    const h = await boot();
    try {
        await indexableEntity(h);
        const upserts = (await outbox(h)).filter((env) => env.event_type === 'reviews.index_document.upserted');
        assert.ok(upserts.length >= 1, 'publishing an indexable entity sends an index document');
        const doc = upserts[upserts.length - 1].payload;
        const v = contracts.validate('search.index-document@1', doc);
        assert.ok(v.valid, JSON.stringify(v.errors));
        assert.strictEqual(doc.owner, 'reviews');
        assert.strictEqual(doc.type, 'entity');
        assert.strictEqual(doc.visibility, 'public');
        assert.strictEqual(doc.indexability.decision, 'index');
        const sources = doc.provenance.filter((p) => p.service === 'sources');
        assert.ok(sources.length >= 1, 'the document carries its Sources provenance');
        assert.ok(sources.every((p) => p.type === 'item' && /^itm_/.test(p.id) && p.retrieved_at), JSON.stringify(sources));
    } finally { await h.stop(); }
});

t("the outbox row and the state change share the caller's transaction (a rollback drops both)", async () => {
    const h = await boot();
    try {
        const e = await indexableEntity(h);
        const row = await h.db.prepare('SELECT name FROM review_entities WHERE id = ?').get(e.id);
        const count = async () => (await h.db.prepare('SELECT COUNT(*) AS n FROM review_event_outbox').get()).n;
        const before = await count();
        await assert.rejects(h.db.tx(async () => {
            await h.db.prepare('UPDATE review_entities SET name = ? WHERE id = ?').run('Rolled back name', e.id);
            await h.svc.syncIndex(e.id);
            throw new Error('rollback: the outbox row and the state change must not survive together');
        }), /rollback/);
        assert.strictEqual(await count(), before, 'no outbox row survives the rollback');
        assert.strictEqual((await h.db.prepare('SELECT name FROM review_entities WHERE id = ?').get(e.id)).name, row.name, 'the state change rolled back with it');
    } finally { await h.stop(); }
});
