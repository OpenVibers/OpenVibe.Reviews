'use strict';
/**
 * Account export and deletion → Reviews (ADR-033; openvibe-sdk/account-data). What Reviews holds about a person:
 *
 *   their own, deleted       the reviews they wrote here (review_member_reviews); the pages they were on are re-sent to
 *                            Search without them, in the same transaction
 *   their additions, kept    what they added to review (review_entities.created_by) and the corrections they sent
 *                            (review_corrections.submitted_by) stay, made authorless ('deleted'): other people's
 *                            reviews and the editors' answers hang under them
 *   kept                     the editorial audit log (review_audit): who decided what is the record editors answer for
 */
const { createAccountData } = require('openvibe-sdk/account-data');

const TABLES = [
    { table: 'review_audit', subject: 'actor', file: null, erase: { keep: 'the editorial record editors answer for' } },
];

async function extraExport(db, subject) {
    const files = [];
    const reviews = await db.many(`SELECT id, entity_id, rating, title, body, relation, status, created_at, updated_at FROM review_member_reviews
        WHERE author = $1 ORDER BY created_at DESC LIMIT 5000`, [subject]);
    if (reviews.length) files.push({ name: 'reviews.json', content: reviews });
    const added = await db.many('SELECT id, slug, name, kind, description, created_at FROM review_entities WHERE created_by = $1 ORDER BY created_at DESC LIMIT 5000', [subject]);
    if (added.length) files.push({ name: 'added-to-review.json', content: added });
    const corrections = await db.many(`SELECT id, entity_id, target_type, target_id, body, evidence_url, status, resolution_note, created_at FROM review_corrections
        WHERE submitted_by = $1 ORDER BY created_at DESC LIMIT 5000`, [subject]);
    if (corrections.length) files.push({ name: 'corrections.json', content: corrections });
    return files;
}

/** The account-data handle over Reviews' database; `svc.syncIndex` re-sends a page (it joins the erase transaction). */
function create({ db, svc, log = console } = {}) {
    async function extraErase(t, subjects, counts) {
        const pages = (await t.many('SELECT DISTINCT entity_id FROM review_member_reviews WHERE author = ANY($1::text[])', [subjects])).map((r) => r.entity_id);
        counts.add(counts.erased, 'review_member_reviews', await t.exec('DELETE FROM review_member_reviews WHERE author = ANY($1::text[])', [subjects]));
        counts.add(counts.retained, 'tombstones', await t.exec("UPDATE review_entities SET created_by = 'deleted' WHERE created_by = ANY($1::text[])", [subjects]));
        counts.add(counts.retained, 'tombstones', await t.exec("UPDATE review_corrections SET submitted_by = 'deleted' WHERE submitted_by = ANY($1::text[])", [subjects]));
        for (const id of pages) await svc.syncIndex(id);
    }
    return createAccountData({
        db, service: 'reviews', tables: TABLES, extraExport, extraErase, log,
        note: 'Your reviews are deleted. What you added to review and the corrections you sent stay without your name.',
    });
}

module.exports = { create, TABLES };
