'use strict';
/**
 * Corrections: accepting a reader's correction of a published summary (or an editor correcting it
 * on their own) creates a new immutable summary revision that carries the public correction note,
 * is published at once, and shows on the entity page without JavaScript next to the earlier
 * revisions, which stay readable. The request's text, the internal note and who sent it never
 * reach a public surface. Rejecting creates nothing; only editors decide.
 */
const assert = require('assert');
const {
    boot, req, suite, steamItem, importItem, createEntity, outbox, cookieFor, editorToken, readerToken, serviceToken,
    EDITOR, READER,
} = require('./helpers');

const t = suite('corrections');
const noScripts = (html) => html.replace(/<script[\s\S]*?<\/script>/g, '');
const jsonLd = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
const revCount = (h, summaryId) => h.db.prepare('SELECT COUNT(*) AS n FROM review_summary_revisions WHERE entity_id = ?').get(summaryId).n;

const OLD = 'Every sampled Steam reviewer recommends it without reservation.';
const NEW = 'Three of the four sampled Steam reviewers recommend it; one does not.';
const NOTE = 'The overview said every sampled reviewer recommends it; one of the four does not.';
const REQUEST = 'The summary claims unanimous praise but a negative review is listed right below it.';
const INTERNAL = 'internal: checked the signal table, reader is right';

async function setup(h) {
    const e = await createEntity(h, { name: 'Portal 2', kind: 'game', aliases: [{ type: 'source', value: 'steam-reviews-portal-2' }] });
    for (const v of [true, true, true, false]) await importItem(h, steamItem({ votedUp: v }));
    const sigs = h.db.prepare("SELECT id, recommended FROM review_signals WHERE entity_id = ? AND status = 'active' ORDER BY id").all(e.id);
    const pos = sigs.filter((s) => s.recommended === 1).map((s) => s.id);
    const neg = sigs.filter((s) => s.recommended === 0).map((s) => s.id);
    const w = await req(h, 'POST', `/api/v1/entities/${e.slug}/summary/revisions`, { token: editorToken(), body: {
        overview: OLD, overview_signals: pos, pros: [{ text: 'Recommended by the sample', signals: pos }], publish: true,
    } });
    assert.strictEqual(w.status, 201, w.text);
    const summaryId = w.json.summary.id;
    return { e, pos, neg, summaryId };
}

async function submit(h, e, body = REQUEST) {
    const r = await req(h, 'POST', `/e/${e.slug}/correct`, { cookie: cookieFor(readerToken()), form: { target_type: 'summary', body, evidence_url: 'https://store.steampowered.com/app/620/' } });
    assert.strictEqual(r.status, 201, r.text.slice(0, 300));
    return h.db.prepare('SELECT * FROM review_corrections WHERE body = ?').get(body);
}

t('accepting a correction publishes a new revision with its note; the page shows it and the history without JavaScript', async () => {
    const h = await boot();
    try {
        const { e, pos, neg, summaryId } = await setup(h);
        const c = await submit(h, e);
        assert.strictEqual(c.submitted_by, READER);

        // Only an editor who is a person decides, and nothing is created by a refused attempt.
        const patch = (token, body, headers) => req(h, 'PATCH', `/api/v1/corrections/${c.id}`, { token, body, headers });
        const accept = { status: 'accepted', correction_note: NOTE };
        assert.strictEqual((await patch(readerToken(), accept)).status, 403);
        assert.strictEqual((await req(h, 'POST', `/editor/corrections/${c.id}`, { cookie: cookieFor(readerToken()), form: { status: 'accepted', correction_note: NOTE } })).status, 403);
        assert.strictEqual((await req(h, 'POST', `/editor/corrections/${c.id}`, { form: { status: 'accepted', correction_note: NOTE } })).status, 401);
        assert.strictEqual((await patch(serviceToken({ client: 'tools', cap: ['reviews.entity.manage', 'reviews.summary.publish'] }), accept)).status, 403, 'a service on its own');
        assert.strictEqual((await patch(serviceToken({ client: 'tools', cap: ['reviews.entity.manage', 'reviews.summary.publish'] }), accept, { 'X-OV-Subject': READER })).status, 403, 'a service acting for a reader');
        const noPublish = await patch(serviceToken({ client: 'tools', cap: ['reviews.entity.manage'] }), accept, { 'X-OV-Subject': EDITOR });
        assert.strictEqual(noPublish.status, 403, 'publishing a correction revision needs reviews.summary.publish');
        assert.strictEqual(noPublish.json.code, 'capability.denied');
        assert.strictEqual((await req(h, 'POST', `/api/v1/entities/${e.slug}/summary/revisions`, { token: readerToken(), body: { overview: NEW, overview_signals: pos, correction_note: NOTE } })).status, 403);
        // A correction of a published summary says what changed.
        const bare = await patch(editorToken(), { status: 'accepted' });
        assert.strictEqual(bare.status, 422);
        assert.strictEqual(bare.json.code, 'correction.note_required');
        assert.strictEqual(revCount(h, summaryId), 1);
        assert.strictEqual(h.db.prepare('SELECT status FROM review_corrections WHERE id = ?').get(c.id).status, 'open');

        const ok = await patch(editorToken(), {
            status: 'accepted', note: INTERNAL, correction_note: NOTE,
            summary: { overview: NEW, overview_signals: [...pos, ...neg], pros: [{ text: 'Recommended by most of the sample', signals: pos }], cons: [{ text: 'Not by everyone', signals: neg }] },
        });
        assert.strictEqual(ok.status, 200, ok.text);
        assert.strictEqual(ok.json.correction.status, 'accepted');
        assert.strictEqual(ok.json.correction.resolved_by, EDITOR);
        assert.strictEqual(ok.json.revision.number, 2);
        assert.strictEqual(ok.json.revision.status, 'published');
        assert.deepStrictEqual(ok.json.revision.correction, { note: NOTE, corrects: 1, requested: true });
        assert.strictEqual(ok.json.revision.author, EDITOR, 'who: the editor who corrected it');

        // Immutable revisions: the old text is still revision 1; the correction is revision 2.
        const rows = h.db.prepare('SELECT number, content, meta, author FROM review_summary_revisions WHERE entity_id = ? ORDER BY number').all(summaryId);
        assert.deepStrictEqual(rows.map((r) => [r.number, r.content]), [[1, OLD], [2, NEW]]);
        assert.strictEqual(JSON.parse(rows[1].meta).correction.note, NOTE);
        assert.throws(() => h.db.prepare('UPDATE review_summary_revisions SET content = ? WHERE entity_id = ? AND number = 2').run('rewritten', summaryId));

        // The public page, without JavaScript: the corrected text, the note, and the history.
        const page = await req(h, 'GET', `/e/${e.slug}`);
        assert.strictEqual(page.status, 200);
        const text = noScripts(page.text);
        assert.ok(text.includes(NEW), 'current text reflects the correction');
        assert.ok(!text.includes(OLD), 'the corrected text is not the current text');
        assert.match(text, /<strong>Corrected<\/strong>/);
        assert.match(text, /Revision history/);
        assert.ok(text.includes(`Correction:</strong> ${NOTE}`));
        assert.ok(text.includes(`href="/e/${e.slug}/summary/2"`) && text.includes(`href="/e/${e.slug}/summary/1"`), 'both revisions in the history');
        const r1 = await req(h, 'GET', `/e/${e.slug}/summary/1`);
        assert.strictEqual(r1.status, 200);
        assert.ok(noScripts(r1.text).includes(OLD), 'the old revision stays readable');
        assert.match(r1.text, /superseded/);
        const r2 = noScripts((await req(h, 'GET', `/e/${e.slug}/summary/2`)).text);
        assert.ok(r2.includes(NOTE) && r2.includes(NEW));
        const hist = noScripts((await req(h, 'GET', `/e/${e.slug}/history`)).text);
        assert.ok(hist.includes(NOTE));

        // Structured data, feeds, events and Search follow the corrected revision.
        const review = jsonLd(page.text).find((x) => x['@type'] === 'Review');
        assert.ok(review.reviewBody.includes(NEW) && !review.reviewBody.includes(OLD));
        assert.ok(review.dateModified, 'the Review says it was modified');
        const feed = JSON.parse((await req(h, 'GET', '/feed.json')).text);
        assert.ok(feed.items[0].summary.startsWith(`Correction: ${NOTE}\n${NEW}`), JSON.stringify(feed.items[0]));
        const events = outbox(h);
        const upd = events.filter((x) => x.event_type === 'reviews.summary.updated');
        assert.strictEqual(upd.length, 1);
        assert.deepStrictEqual(upd[0].payload.correction, { note: NOTE, corrects: 1 });
        assert.strictEqual(upd[0].subject.revision, 2);
        const doc = events.filter((x) => x.event_type === 'reviews.index_document.upserted').pop().payload;
        assert.ok(doc.body.includes(NEW) && !doc.body.includes(OLD), 'Search gets the corrected text');

        // Nothing private leaks: not the request, not who sent it, not the editors' note.
        const surfaces = [
            page.text, r1.text, hist, (await req(h, 'GET', `/e/${e.slug}.json`)).text,
            (await req(h, 'GET', `/api/v1/entities/${e.slug}`)).text, (await req(h, 'GET', `/api/v1/entities/${e.slug}/history`)).text,
            (await req(h, 'GET', `/api/v1/entities/${e.slug}/summary/revisions/2`)).text,
            (await req(h, 'GET', '/feed.json')).text, (await req(h, 'GET', '/feed.atom')).text, JSON.stringify(events),
        ];
        for (const s of surfaces) {
            for (const secret of [REQUEST, INTERNAL, READER, c.id]) assert.ok(!s.includes(secret), `public surface carries ${secret}`);
        }
        // Editors still see the whole record.
        const edHist = await req(h, 'GET', `/api/v1/entities/${e.slug}/history`, { token: editorToken() });
        assert.ok(edHist.text.includes(c.id) && edHist.text.includes(INTERNAL));

        // Closed is closed.
        assert.strictEqual((await patch(editorToken(), accept)).status, 409);
    } finally { await h.stop(); }
});

t('a rejected correction creates no revision; editors correct with plain forms, on their own or from the desk', async () => {
    const h = await boot();
    try {
        const { e, pos, neg, summaryId } = await setup(h);
        const ed = cookieFor(editorToken());
        const c1 = await submit(h, e, 'I think this game deserves a higher score overall, honestly.');
        const desk = noScripts((await req(h, 'GET', '/editor', { cookie: ed })).text);
        assert.match(desk, /name="correction_note"/, 'the desk asks for the public note when a summary is published');
        const rej = await req(h, 'POST', `/editor/corrections/${c1.id}`, { cookie: ed, form: { status: 'rejected', note: 'opinion, not an error', correction_note: 'ignored when rejecting' } });
        assert.strictEqual(rej.status, 303);
        assert.strictEqual(h.db.prepare('SELECT status FROM review_corrections WHERE id = ?').get(c1.id).status, 'rejected');
        assert.strictEqual(revCount(h, summaryId), 1, 'rejecting creates no revision');
        assert.ok(!outbox(h).some((x) => x.event_type === 'reviews.summary.updated'));

        // From the desk: accept with a note, the published text carried forward as a correction revision.
        const c2 = await submit(h, e, 'The signal table lists a review that its source has since edited.');
        const short = await req(h, 'POST', `/editor/corrections/${c2.id}`, { cookie: ed, form: { status: 'accepted', correction_note: 'fixed' } });
        assert.strictEqual(short.status, 422, 'a correction note is a sentence readers can use');
        assert.strictEqual(revCount(h, summaryId), 1);
        const acc = await req(h, 'POST', `/editor/corrections/${c2.id}`, { cookie: ed, form: { status: 'accepted', correction_note: 'Checked the cited signals against their sources; the text stands.' } });
        assert.strictEqual(acc.status, 303);
        const r2 = h.db.prepare('SELECT content, meta FROM review_summary_revisions WHERE entity_id = ? AND number = 2').get(summaryId);
        assert.strictEqual(r2.content, OLD, 'carried forward');
        assert.strictEqual(JSON.parse(r2.meta).correction.note, 'Checked the cited signals against their sources; the text stands.');

        // From the edit page, answering a request: the form names it and accepts it on publish.
        const c3 = await submit(h, e, 'Only three of the four sampled reviewers recommend it, not all of them.');
        const form = await req(h, 'GET', `/e/${e.slug}/edit?correction=${c3.id}`, { cookie: ed });
        assert.ok(form.text.includes(`name="correction_id" value="${c3.id}"`));
        assert.ok(noScripts(form.text).includes('Only three of the four sampled reviewers'), 'editors see the request');
        const fixed = await req(h, 'POST', `/e/${e.slug}/summary`, { cookie: ed, form: {
            overview: NEW, overview_signals: [...pos, ...neg], pro_text_0: 'Recommended by most of the sample', pro_signals_0: pos,
            con_text_0: 'Not by everyone', con_signals_0: neg, correction_id: c3.id, correction_note: NOTE, expected_revision: '2', publish: '0',
        } });
        assert.strictEqual(fixed.status, 303, fixed.text.slice(0, 400));
        assert.strictEqual(h.db.prepare('SELECT status FROM review_corrections WHERE id = ?').get(c3.id).status, 'accepted');
        const s = h.db.prepare('SELECT * FROM review_summaries WHERE entity_id = ?').get(e.id);
        assert.strictEqual(s.published_revision, 3, 'a correction is published at once');

        // An editor corrects without any request.
        const own = await req(h, 'POST', `/api/v1/entities/${e.slug}/summary/revisions`, { token: editorToken(), body: {
            overview: `${NEW} The sample is recent reviews only.`, overview_signals: pos, correction_note: 'Added that the sample covers recent reviews only.',
        } });
        assert.strictEqual(own.status, 201, own.text);
        assert.strictEqual(own.json.revision.number, 4);
        assert.deepStrictEqual(own.json.revision.correction, { note: 'Added that the sample covers recent reviews only.', corrects: 3, requested: false });
        const page = noScripts((await req(h, 'GET', `/e/${e.slug}`)).text);
        for (const n of [NOTE, 'Added that the sample covers recent reviews only.', 'Checked the cited signals against their sources; the text stands.']) assert.ok(page.includes(n), n);
        assert.match(page, /3 corrections\./);
        assert.ok(!page.includes('opinion, not an error'));

        // Nothing published → nothing to correct.
        const other = await createEntity(h, { name: 'Unsummarised', kind: 'game' });
        const none = await req(h, 'POST', `/api/v1/entities/${other.slug}/summary/revisions`, { token: editorToken(), body: { overview: 'x', overview_signals: pos, correction_note: 'This cannot be a correction.' } });
        assert.strictEqual(none.status, 409);
        assert.strictEqual(none.json.code, 'summary.not_published');
    } finally { await h.stop(); }
});

t('a correction of approved AI text is AI-assisted, never "written by a person"', async () => {
    const h = await boot();
    try {
        const e = await createEntity(h, { name: 'Portal 2', kind: 'game', aliases: [{ type: 'source', value: 'steam-reviews-portal-2' }] });
        for (const v of [true, true, false]) await importItem(h, steamItem({ votedUp: v }));
        const sigs = h.db.prepare("SELECT id FROM review_signals WHERE status = 'active'").all().map((s) => s.id);
        const p = await req(h, 'POST', `/api/v1/entities/${e.slug}/summary/proposals`, { token: serviceToken({ client: 'ai', cap: ['reviews.summary.propose'] }), body: {
            overview: 'All sampled reviewers recommend it.', overview_signals: sigs, workflow: { id: 'reviews.summarize_entity', run_id: 'run_01J9ZZZZZZZZZZZZZZZZZZZZZZ', version: 1 },
        } });
        assert.strictEqual(p.status, 201, p.text);
        assert.strictEqual((await req(h, 'POST', `/api/v1/entities/${e.slug}/summary/revisions/1/review`, { token: editorToken(), body: { decision: 'approved' } })).status, 200);
        const c = await req(h, 'POST', `/api/v1/entities/${e.slug}/summary/revisions`, { token: editorToken(), body: {
            overview: 'Two of the three sampled reviewers recommend it.', overview_signals: sigs, correction_note: 'The AI draft said all reviewers recommend it; one does not.',
        } });
        assert.strictEqual(c.status, 201, c.text);
        assert.strictEqual(c.json.revision.authorship.mode, 'hybrid');
        const page = noScripts((await req(h, 'GET', `/e/${e.slug}`)).text);
        assert.match(page, /Written by a person with AI assistance/);
        assert.ok(page.includes('The AI draft said all reviewers recommend it; one does not.'));
    } finally { await h.stop(); }
});
