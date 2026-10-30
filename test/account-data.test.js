'use strict';
/**
 * Account export and deletion (ADR-033) now that Reviews holds what people write: the export carries a person's reviews,
 * what they added to review and their corrections; the deletion removes their reviews (the pages are re-sent to Search
 * without them), leaves what they added and their corrections authorless, keeps the editorial audit log, and confirms
 * once with the counts. Deliveries are Events' v2-signed webhooks at /internal/account-events.
 */
const assert = require('assert');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { uncovered } = require('openvibe-sdk/account-data');
const { TABLES } = require('../server/reviews/account-data');
const { boot, req, suite, userToken, cookieFor, subject, outbox, WEBHOOK_SECRET } = require('./helpers');

const t = suite('account-data');
const BODY = 'Managers listened, the pay was on time, and the on-call rota was fair. Promotions were slow though.';

t('export, then deletion: reviews gone and re-indexed, additions and corrections authorless, confirmed once', async () => {
    const calls = [];
    const send = async (path, body) => { calls.push({ path, body }); return { ok: true, status: 201 }; };
    const h = await boot({ send });
        const missing = await uncovered(h.db, {
            tables: TABLES,
            taskKeyed: ['review_entities', 'review_entity_aliases', 'review_entity_links', 'review_summary_drafts'],
            exempt: {
                account_data_events: 'the ledger of requests itself: which export and deletion Reviews applied',
                review_signals: 'signals are imported from OpenVibe.Sources and attributed to the source, not to a person',
                review_index_revisions: "owner is the search-index document's owner (type/id), not a person; the row holds a revision and hash",
            },
        });
        assert.deepStrictEqual(missing, [], `a table with a person column is neither covered nor exempted: ${missing.join(', ')}`);
    try {
        const ana = subject();
        const ben = subject();
        const anaC = cookieFor(userToken({ subject: ana, username: 'ana' }));
        const benC = cookieFor(userToken({ subject: ben, username: 'ben' }));
        await req(h, 'POST', '/review', { cookie: anaC, form: { kind: 'employer', name: 'Acme Corp' } });
        await req(h, 'POST', '/e/acme-corp/reviews', { cookie: anaC, form: { rating: '4', title: 'Solid place to work', body: BODY } });
        await req(h, 'POST', '/e/acme-corp/reviews', { cookie: benC, form: { rating: '2', title: 'Burned out', body: 'Constant overtime, and the on-call rota was anything but fair to the night team.' } });
        await req(h, 'POST', '/save', { cookie: anaC, form: { entity: 'acme-corp', url: 'https://www.glassdoor.com/Reviews/Acme-E1.htm', value: '3.9', best: '5', count: '120' } });
        const deliver = async (event, { secret = WEBHOOK_SECRET, headers = {} } = {}) => {
            const body = JSON.stringify({ event, seq: 1 });
            const r = await fetch(`${h.base}/internal/account-events`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(body, secret), ...headers } });
            return { status: r.status, json: await r.json().catch(() => null) };
        };
        const ev = (id, type, payload) => ({ event_id: id, event_type: type, source: 'network', version: 1, timestamp: new Date().toISOString(), payload });

        // Export: her review, what she added, nothing of Ben's.
        const ex = await deliver(ev('evt_01JZ0000000000000000000E01', 'network.account.export_requested', { export_id: 'exp_01JZ0000000000000000000EX1', subject: ana }));
        assert.deepStrictEqual([ex.status, ex.json && ex.json.outcome], [200, 'exported'], JSON.stringify(ex.json));
        const part = calls.find((c) => c.path === '/internal/account-exports/exp_01JZ0000000000000000000EX1/parts');
        const files = JSON.stringify(part.body);
        assert.ok(files.includes('reviews.json') && files.includes('Solid place to work') && files.includes('added-to-review.json'), files.slice(0, 300));
        assert.ok(files.includes('ratings-from-other-sites.json') && files.includes('Acme-E1.htm'), 'the rating she saved');
        assert.ok(!files.includes('Burned out') && !files.includes(ben), 'nothing of Ben\'s');

        // Deletion: her review gone, the page re-sent to Search without it; Acme stays, made authorless.
        const before = (await outbox(h)).length;
        const del = ev('evt_01JZ0000000000000000000D01', 'network.account.deleted', { deletion_id: 'del_01JZ0000000000000000000DE1', subject: ana });
        const r = await deliver(del);
        assert.deepStrictEqual([r.status, r.json && r.json.outcome], [200, 'erased'], JSON.stringify(r.json));
        assert.strictEqual(Number((await h.db.prepare('SELECT COUNT(*) AS n FROM review_member_reviews WHERE author = ?').get(ana)).n), 0);
        assert.strictEqual(Number((await h.db.prepare('SELECT COUNT(*) AS n FROM review_member_reviews WHERE author = ?').get(ben)).n), 1, 'Ben\'s review stays');
        assert.strictEqual((await h.db.prepare("SELECT created_by FROM review_entities WHERE slug = 'acme-corp'").get()).created_by, 'deleted');
        const page = await req(h, 'GET', '/e/acme-corp');
        assert.ok(page.text.includes('Reviews from OpenVibe members (1)') && !page.text.includes('Solid place to work'));
        const docs = (await outbox(h)).slice(before).filter((x) => x.event_type === 'reviews.index_document.upserted' && x.payload.title === 'Acme Corp');
        assert.ok(docs.some((d) => /OpenVibe members: 2 out of 5 from 1 review/.test(d.payload.body || '')), 'Search gets the page without her review');
        const conf = calls.filter((c) => c.path === '/internal/account-deletions/del_01JZ0000000000000000000DE1/confirmations');
        assert.strictEqual(conf.length, 1);
        assert.strictEqual(conf[0].body.erased.review_member_reviews, 1);
        assert.strictEqual(conf[0].body.erased.review_seen_ratings, 1);
        assert.ok(!/rv-seen/.test(page.text), 'the rating she saved is gone from the page');
        // A redelivery erases nothing twice.
        assert.strictEqual((await deliver(del)).json.outcome, 'unchanged');
        // Signed wrong or relayed from outside: refused.
        assert.strictEqual((await deliver(del, { secret: `x${WEBHOOK_SECRET}` })).status, 401);
        assert.strictEqual((await deliver(del, { headers: { 'X-Forwarded-For': '203.0.113.9' } })).status, 403);
    } finally { await h.stop(); }
});
