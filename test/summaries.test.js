'use strict';
/**
 * Summaries: every point cites signals; AI drafts (reviews.summarize_entity) are never published
 * on their own, stay out of the page and the index until a person approves them, and AI text can
 * never produce a rating. A withdrawn cited signal flags the summary and prepares a pending
 * revision for an editor.
 */
const assert = require('assert');
const {
    boot, req, suite, steamItem, importItem, createEntity, outbox, deliver, sourcesEvent, editorToken, readerToken, serviceToken,
} = require('./helpers');

const t = suite('summaries');
const AI = () => serviceToken({ client: 'ai', cap: ['reviews.summary.propose'] });
const WF = { id: 'reviews.summarize_entity', run_id: 'run_01J9ZZZZZZZZZZZZZZZZZZZZZZ', version: 1 };

async function setup(h) {
    const e = await createEntity(h, { name: 'Portal 2', kind: 'game', aliases: [{ type: 'source', value: 'steam-reviews-portal-2' }] });
    const items = [];
    for (const v of [true, true, true, false]) items.push((await importItem(h, steamItem({ votedUp: v }))).item);
    const sigs = h.db.prepare("SELECT id, recommended, source_item_id FROM review_signals WHERE entity_id = ? AND status = 'active' ORDER BY id").all(e.id);
    return { e, items, sigs, pos: sigs.filter((s) => s.recommended === 1).map((s) => s.id), neg: sigs.filter((s) => s.recommended === 0).map((s) => s.id) };
}

const aggRevision = (h, id) => (h.db.prepare('SELECT MAX(revision) AS r FROM review_aggregates WHERE entity_id = ?').get(id).r);

t('AI text never yields a rating: rating fields and rating text are refused, the aggregate is untouched', async () => {
    const h = await boot();
    try {
        const { e, pos } = await setup(h);
        const rev = aggRevision(h, e.id);
        const withField = await req(h, 'POST', `/api/v1/entities/${e.slug}/summary/proposals`, { token: AI(), body: { overview: 'Fine.', overview_signals: pos, rating: 4.5, workflow: WF } });
        assert.strictEqual(withField.status, 422);
        assert.strictEqual(withField.json.code, 'summary.rating_forbidden');
        const inPoint = await req(h, 'POST', `/api/v1/entities/${e.slug}/summary/proposals`, { token: AI(), body: { pros: [{ text: 'Good', signals: pos, stars: 5 }], workflow: WF } });
        assert.strictEqual(inPoint.json.code, 'summary.rating_forbidden');
        for (const text of ['Players rate it 4.5/5.', 'A solid 9 out of 10.', '★★★★☆ overall', 'Easily five stars... 5 stars']) {
            const r = await req(h, 'POST', `/api/v1/entities/${e.slug}/summary/proposals`, { token: AI(), body: { overview: text, overview_signals: pos, workflow: WF } });
            assert.strictEqual(r.status, 422, text);
            assert.strictEqual(r.json.code, 'summary.rating_in_text', text);
        }
        assert.strictEqual(aggRevision(h, e.id), rev);
        // Even an entity with no signals gets no aggregate from AI text: summaries cannot cite what does not exist.
        const empty = await createEntity(h, { name: 'Unknown Game', kind: 'game' });
        const noSig = await req(h, 'POST', `/api/v1/entities/${empty.slug}/summary/proposals`, { token: AI(), body: { overview: 'Widely loved.', pros: [{ text: 'Loved', signals: pos }], workflow: WF } });
        assert.strictEqual(noSig.status, 422);
        assert.strictEqual(noSig.json.code, 'summary.invalid_citation');
        const agg = await req(h, 'GET', `/api/v1/entities/${empty.slug}/aggregate`, { token: editorToken() });
        assert.strictEqual(agg.json.aggregate, null);
        const page = await req(h, 'GET', `/e/${empty.slug}`);
        assert.ok(!/AggregateRating/.test(page.text));
    } finally { await h.stop(); }
});

t('an AI draft is held: not on the page, not publishable, not indexed, until a person approves it', async () => {
    const h = await boot();
    try {
        const { e, pos, neg } = await setup(h);
        const body = {
            overview: 'Most recent Steam reviewers in the sample recommend it. The sample is small and recent, so it says little about long-term opinion across every player who reviewed it on Steam in any language.',
            pros: [{ text: 'Most sampled reviewers recommend it', signals: pos }], cons: [{ text: 'One sampled reviewer does not', signals: neg }],
            workflow: WF, stub_provider: false,
        };
        // Only a service proposes; a person cannot pose as the AI.
        assert.strictEqual((await req(h, 'POST', `/api/v1/entities/${e.slug}/summary/proposals`, { token: editorToken(), body })).status, 403);
        assert.strictEqual((await req(h, 'POST', `/api/v1/entities/${e.slug}/summary/proposals`, { token: serviceToken({ cap: ['reviews.summary.publish'] }), body })).status, 403);
        const p = await req(h, 'POST', `/api/v1/entities/${e.slug}/summary/proposals`, { token: AI(), body });
        assert.strictEqual(p.status, 201, p.text);
        assert.strictEqual(p.json.revision.status, 'pending_ai');
        assert.strictEqual(p.json.revision.authorship.mode, 'ai');
        assert.strictEqual(p.json.summary.state, 'draft');

        const pageBefore = await req(h, 'GET', `/e/${e.slug}`);
        assert.match(pageBefore.text, /No published summary/);
        assert.ok(!pageBefore.text.includes('Most sampled reviewers recommend it'));
        assert.ok(!outbox(h).some((x) => x.event_type === 'reviews.summary.published'));
        assert.ok(!outbox(h).some((x) => JSON.stringify(x.payload).includes('Most sampled reviewers')), 'the draft never reaches Search');
        const feed = await req(h, 'GET', '/feed.json');
        assert.strictEqual(JSON.parse(feed.text).items.length, 0);

        const pub = await req(h, 'POST', `/api/v1/entities/${e.slug}/summary/publish`, { token: editorToken(), body: { revision: 1 } });
        assert.strictEqual(pub.status, 409);
        assert.strictEqual(pub.json.code, 'ai_generated_unreviewed');
        // A reader is not an editor.
        assert.strictEqual((await req(h, 'POST', `/api/v1/entities/${e.slug}/summary/revisions/1/review`, { token: readerToken(), body: { decision: 'approved' } })).status, 403);

        const ok = await req(h, 'POST', `/api/v1/entities/${e.slug}/summary/revisions/1/review`, { token: editorToken(), body: { decision: 'approved', note: 'checked against the signals' } });
        assert.strictEqual(ok.status, 200, ok.text);
        assert.strictEqual(ok.json.published, true);
        const page = await req(h, 'GET', `/e/${e.slug}`);
        assert.match(page.text, /AI-generated by workflow reviews\.summarize_entity v1, reviewed by a person/);
        assert.match(page.text, /Most sampled reviewers recommend it/);
        const ev = outbox(h).filter((x) => x.event_type === 'reviews.summary.published');
        assert.strictEqual(ev.length, 1);
        // The review JSON-LD carries no reviewRating: a summary never states a rating.
        const ld = [...page.text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
        const review = ld.find((x) => x['@type'] === 'Review');
        assert.ok(review, 'Review JSON-LD for a signal-backed summary');
        assert.strictEqual(review.reviewRating, undefined);
    } finally { await h.stop(); }
});

t('human summaries cite signals for every point; a withdrawn cited signal flags the summary and prepares a pending revision', async () => {
    const h = await boot();
    try {
        const { e, pos, neg, sigs } = await setup(h);
        const uncited = await req(h, 'POST', `/api/v1/entities/${e.slug}/summary/revisions`, { token: editorToken(), body: { pros: [{ text: 'Clever puzzles', signals: [] }] } });
        assert.strictEqual(uncited.status, 422);
        assert.strictEqual(uncited.json.code, 'summary.uncited_point');
        const foreign = await req(h, 'POST', `/api/v1/entities/${e.slug}/summary/revisions`, { token: editorToken(), body: { pros: [{ text: 'x', signals: ['sig_01J9ZZZZZZZZZZZZZZZZZZZZZZ'] }] } });
        assert.strictEqual(foreign.json.code, 'summary.invalid_citation');
        const scored = await req(h, 'POST', `/api/v1/entities/${e.slug}/summary/revisions`, { token: editorToken(), body: { score: 9, pros: [{ text: 'x', signals: pos }] } });
        assert.strictEqual(scored.json.code, 'summary.rating_forbidden');

        const w = await req(h, 'POST', `/api/v1/entities/${e.slug}/summary/revisions`, { token: editorToken(), body: {
            overview: 'Three of the four sampled Steam reviewers recommend it.', overview_signals: sigs.map((s) => s.id),
            pros: [{ text: 'Recommended by most of the sample', signals: pos }], cons: [{ text: 'Not by everyone', signals: neg }], publish: true,
        } });
        assert.strictEqual(w.status, 201, w.text);
        assert.strictEqual(w.json.published, true);

        // The source removes the only negative review: the con loses its support.
        const negItem = sigs.find((s) => s.recommended === 0).source_item_id;
        await deliver(h, sourcesEvent('sources.item.removed', h.sources.remove(negItem, 'author deleted the review'), { reason: 'author deleted the review' }));
        const s = h.db.prepare('SELECT * FROM review_summaries WHERE entity_id = ?').get(e.id);
        assert.strictEqual(s.flagged, 1);
        assert.match(s.flag_reason, /withdrawn/);
        const page = await req(h, 'GET', `/api/v1/entities/${e.slug}`, { token: editorToken() });
        assert.strictEqual(page.json.summary.published.number, 1, 'the published text stays until an editor decides');
        assert.strictEqual(page.json.summary.pending.length, 1);
        const pending = page.json.summary.pending[0];
        assert.strictEqual(pending.status, 'pending_system');
        assert.deepStrictEqual(pending.points.map((p) => p.kind).sort(), ['overview', 'pro']);
        const html = await req(h, 'GET', `/e/${e.slug}`);
        assert.match(html.text, /Under review/);
        assert.match(html.text, /rv-unsupported/);
        // The gate: an unsupported point means noindex until it is resolved.
        assert.ok(page.json.decision.reasons.includes('unsupported_claims'));
        // A system revision needs a person's approval.
        const direct = await req(h, 'POST', `/api/v1/entities/${e.slug}/summary/publish`, { token: editorToken(), body: { revision: pending.number } });
        assert.strictEqual(direct.status, 409);
        const ok = await req(h, 'POST', `/api/v1/entities/${e.slug}/summary/revisions/${pending.number}/review`, { token: editorToken(), body: { decision: 'approved' } });
        assert.strictEqual(ok.status, 200, ok.text);
        const fresh = h.db.prepare('SELECT * FROM review_summaries WHERE entity_id = ?').get(e.id);
        assert.strictEqual(fresh.flagged, 0);
        assert.strictEqual(fresh.published_revision, pending.number);
        assert.ok(outbox(h).some((x) => x.event_type === 'reviews.summary.updated'));
    } finally { await h.stop(); }
});

t('readers never see an unreviewed AI draft, an unpublished summary, or a deleted entity through the revision history', async () => {
    const h = await boot();
    try {
        const { e, pos, neg } = await setup(h);
        const secret = 'Unreviewed model text that no person approved';
        const p = await req(h, 'POST', `/api/v1/entities/${e.slug}/summary/proposals`, { token: AI(), body: { overview: secret, overview_signals: pos, pros: [{ text: secret, signals: pos }], workflow: WF } });
        assert.strictEqual(p.status, 201, p.text);
        // An editor writes and publishes their own revision instead of reviewing the AI draft.
        const w = await req(h, 'POST', `/api/v1/entities/${e.slug}/summary/revisions`, { token: editorToken(), body: {
            overview: 'Most sampled Steam reviewers recommend it.', overview_signals: pos, cons: [{ text: 'One does not', signals: neg }], publish: true,
        } });
        assert.strictEqual(w.status, 201, w.text);
        assert.strictEqual(w.json.revision.number, 2);

        for (const path of [`/e/${e.slug}/summary/1`, `/api/v1/entities/${e.slug}/summary/revisions/1`]) {
            const r = await req(h, 'GET', path);
            assert.strictEqual(r.status, 404, `${path} shows the never-reviewed AI draft`);
            assert.ok(!r.text.includes(secret), path);
        }
        for (const path of [`/e/${e.slug}/history`, `/api/v1/entities/${e.slug}/history`]) {
            const r = await req(h, 'GET', path);
            assert.ok(!r.text.includes(secret), `${path} lists the never-reviewed AI draft`);
        }
        // Editors still see it.
        assert.strictEqual((await req(h, 'GET', `/api/v1/entities/${e.slug}/summary/revisions/1`, { token: editorToken() })).status, 200);

        // Unpublishing takes the summary down everywhere, including its revision pages.
        const un = await req(h, 'POST', `/api/v1/entities/${e.slug}/summary/unpublish`, { token: editorToken() });
        assert.strictEqual(un.status, 200, un.text);
        for (const path of [`/e/${e.slug}/summary/2`, `/api/v1/entities/${e.slug}/summary/revisions/2`]) {
            assert.strictEqual((await req(h, 'GET', path)).status, 404, `${path} still serves the unpublished summary`);
        }
        const hist = await req(h, 'GET', `/api/v1/entities/${e.slug}/history`);
        assert.strictEqual(hist.json.summary_revisions.length, 0, 'history still lists the unpublished summary');

        // A deleted entity answers 410 on its pages, and the API does not serve its history either.
        const gone = await createEntity(h, { name: 'Removed On Request', kind: 'other', aliases: [{ type: 'url', value: 'https://example.org/private-person' }] });
        const del = await req(h, 'DELETE', `/api/v1/entities/${gone.slug}`, { token: editorToken(), body: { note: 'legal request' } });
        assert.strictEqual(del.status, 200, del.text);
        assert.strictEqual((await req(h, 'GET', `/e/${gone.slug}/history`)).status, 410);
        const api = await req(h, 'GET', `/api/v1/entities/${gone.id}/history`);
        assert.strictEqual(api.status, 410, 'the API serves a deleted entity\'s history');
        assert.ok(!api.text.includes('legal request'));
        assert.strictEqual((await req(h, 'GET', `/api/v1/entities/${gone.id}/history`, { token: editorToken() })).status, 200);
    } finally { await h.stop(); }
});

t('corrections from people queue for editors', async () => {
    const h = await boot();
    try {
        const { e } = await setup(h);
        const anon = await req(h, 'POST', `/api/v1/entities/${e.slug}/corrections`, { body: { target_type: 'entity', body: 'This is the wrong game entirely.' } });
        assert.strictEqual(anon.status, 403);
        const svcAlone = await req(h, 'POST', `/api/v1/entities/${e.slug}/corrections`, { token: serviceToken({ cap: ['reviews.correction.submit'] }), body: { target_type: 'entity', body: 'This is the wrong game entirely.' } });
        assert.strictEqual(svcAlone.status, 403);
        const c = await req(h, 'POST', `/api/v1/entities/${e.slug}/corrections`, { token: readerToken(), body: { target_type: 'aggregate', body: 'The sample is only recent English reviews.', evidence_url: 'https://store.steampowered.com/app/620/' } });
        assert.strictEqual(c.status, 201, c.text);
        const list = await req(h, 'GET', '/api/v1/corrections', { token: editorToken() });
        assert.strictEqual(list.json.corrections.length, 1);
        assert.strictEqual((await req(h, 'GET', '/api/v1/corrections', { token: readerToken() })).status, 403);
        const done = await req(h, 'PATCH', `/api/v1/corrections/${c.json.correction.id}`, { token: editorToken(), body: { status: 'accepted', note: 'Added a limitation note' } });
        assert.strictEqual(done.json.correction.status, 'accepted');
    } finally { await h.stop(); }
});
