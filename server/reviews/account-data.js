'use strict';
/**
 * Account export and deletion → Reviews (ADR-033; openvibe-sdk/account-data). What Reviews holds about a person:
 *
 *   their own, deleted       the reviews they wrote here (review_member_reviews) and the ratings of other sites they
 *                            saved (review_seen_ratings); the pages they were on are re-sent to Search without them,
 *                            in the same transaction
 *   their additions, kept    what they added to review (review_entities.created_by), the aliases and links they
 *                            added and the corrections they sent (review_corrections.submitted_by) stay, made
 *                            authorless ('deleted'): other people's reviews and the editors' answers hang under them
 *   theirs, deleted          an unpublished summary draft (review_summary_drafts.owner) is theirs alone
 *   kept                     the editorial audit log (review_audit): who decided what is the record editors answer for
 */
const { createAccountData } = require('openvibe-sdk/account-data');

const TABLES = [
    { table: 'review_audit', subject: 'actor', file: null, erase: { keep: 'the editorial record editors answer for' } },
];

// The rows extraErase handles: what the person added to an entity, and their draft, stay with the entity made
// authorless; the guard needs their names.
const GUARDED = ['review_entities', 'review_entity_aliases', 'review_entity_links', 'review_summary_drafts'];

async function extraExport(db, subject) {
    const files = [];
    const reviews = await db.many(`SELECT id, entity_id, rating, title, body, relation, status, created_at, updated_at FROM review_member_reviews
        WHERE author = $1 ORDER BY created_at DESC LIMIT 5000`, [subject]);
    if (reviews.length) files.push({ name: 'reviews.json', content: reviews });
    const seen = await db.many(`SELECT id, entity_id, site, page_url, rating_value::float8 AS rating_value, rating_best::float8 AS rating_best, rating_count, seen_at, via, status
        FROM review_seen_ratings WHERE seen_by = $1 ORDER BY seen_at DESC LIMIT 5000`, [subject]);
    if (seen.length) files.push({ name: 'ratings-from-other-sites.json', content: seen });
    const added = await db.many('SELECT id, slug, name, kind, description, created_at FROM review_entities WHERE created_by = $1 ORDER BY created_at DESC LIMIT 5000', [subject]);
    if (added.length) files.push({ name: 'added-to-review.json', content: added });
    const corrections = await db.many(`SELECT id, entity_id, target_type, target_id, body, evidence_url, status, resolution_note, created_at FROM review_corrections
        WHERE submitted_by = $1 ORDER BY created_at DESC LIMIT 5000`, [subject]);
    if (corrections.length) files.push({ name: 'corrections.json', content: corrections });
    const aliases = await db.many(`SELECT id, entity_id, type, value, created_at, removed_at FROM review_entity_aliases
        WHERE created_by = $1 ORDER BY created_at DESC LIMIT 5000`, [subject]);
    if (aliases.length) files.push({ name: 'aliases.json', content: aliases });
    const links = await db.many(`SELECT id, from_entity, to_entity, type, note, created_at, ended_at FROM review_entity_links
        WHERE created_by = $1 ORDER BY created_at DESC LIMIT 5000`, [subject]);
    if (links.length) files.push({ name: 'links.json', content: links });
    const drafts = await db.many(`SELECT entity_id, base_revision, content, fields, created_at, updated_at FROM review_summary_drafts
        WHERE owner = $1 ORDER BY updated_at DESC LIMIT 5000`, [subject]);
    if (drafts.length) files.push({ name: 'summary-drafts.json', content: drafts });
    return files;
}

/** The account-data handle over Reviews' database; `svc.syncIndex` re-sends a page (it joins the erase transaction). */
function create({ db, svc, log = console } = {}) {
    async function extraErase(t, subjects, counts) {
        const pages = (await t.many(`SELECT entity_id FROM review_member_reviews WHERE author = ANY($1::text[])
            UNION SELECT entity_id FROM review_seen_ratings WHERE seen_by = ANY($1::text[])`, [subjects])).map((r) => r.entity_id);
        counts.add(counts.erased, 'review_member_reviews', await t.exec('DELETE FROM review_member_reviews WHERE author = ANY($1::text[])', [subjects]));
        counts.add(counts.erased, 'review_seen_ratings', await t.exec('DELETE FROM review_seen_ratings WHERE seen_by = ANY($1::text[])', [subjects]));
        counts.add(counts.retained, 'tombstones', await t.exec("UPDATE review_entities SET created_by = 'deleted' WHERE created_by = ANY($1::text[])", [subjects]));
        counts.add(counts.retained, 'tombstones', await t.exec("UPDATE review_corrections SET submitted_by = 'deleted' WHERE submitted_by = ANY($1::text[])", [subjects]));
        // The aliases and links they added stay part of the entity, without their name; one only they removed or
        // ended loses the remover, never its author.
        counts.add(counts.retained, 'tombstones', await t.exec(`UPDATE review_entity_aliases SET
            created_by = CASE WHEN created_by = ANY($1::text[]) THEN 'deleted' ELSE created_by END,
            removed_by = CASE WHEN removed_by = ANY($1::text[]) THEN 'deleted' ELSE removed_by END
            WHERE created_by = ANY($1::text[]) OR removed_by = ANY($1::text[])`, [subjects]));
        counts.add(counts.retained, 'tombstones', await t.exec(`UPDATE review_entity_links SET
            created_by = CASE WHEN created_by = ANY($1::text[]) THEN 'deleted' ELSE created_by END,
            ended_by = CASE WHEN ended_by = ANY($1::text[]) THEN 'deleted' ELSE ended_by END
            WHERE created_by = ANY($1::text[]) OR ended_by = ANY($1::text[])`, [subjects]));
        // An editor's unpublished summary draft is theirs alone.
        counts.add(counts.erased, 'review_summary_drafts', await t.exec('DELETE FROM review_summary_drafts WHERE owner = ANY($1::text[])', [subjects]));
        for (const id of pages) await svc.syncIndex(id);
    }
    return createAccountData({
        db, service: 'reviews', tables: TABLES, extraExport, extraErase, log,
        note: 'Your reviews, the ratings you saved and an unpublished summary draft are deleted. What you added to review, its aliases and links, and the corrections you sent stay without your name.',
    });
}

module.exports = { create, TABLES, GUARDED };
