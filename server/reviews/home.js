'use strict';
/**
 * What the front page counts and ranks, read from Reviews' own database (active entities and records only; the
 * front page is cached for everyone, so nothing here depends on who is looking):
 *
 *   stats()              pages, official records, ratings from sources (active signals), members' reviews and the
 *                        ratings members saved from other sites
 *   latestInspections(n) restaurants by their newest NYC Health inspection: that day's violations, how many were
 *                        critical, the newest grade on record, the borough and cuisine
 *   mostHazardous(n)     buildings by NYC HPD's open class C (immediately hazardous) violations
 *   mostComplaints(n)    companies by the complaints consumers sent the CFPB
 */
const ACTIVE_RECORD = "r.status = 'active'";

function createHome({ db }) {
    const q = {
        stats: db.prepare(`SELECT (SELECT COUNT(*) FROM review_entities WHERE state = 'active') AS pages,
                                  (SELECT COUNT(*) FROM review_records r WHERE ${ACTIVE_RECORD}) AS records,
                                  (SELECT COUNT(*) FROM review_signals WHERE status = 'active') AS signals,
                                  (SELECT COUNT(*) FROM review_member_reviews WHERE status = 'published') AS member_reviews,
                                  (SELECT COUNT(*) FROM review_seen_ratings WHERE status = 'shown') AS seen`),
        inspections: db.prepare(`WITH latest AS (
                                     SELECT DISTINCT ON (r.entity_id) r.entity_id, r.occurred_on FROM review_records r
                                     WHERE r.kind = 'inspection_violation' AND ${ACTIVE_RECORD} AND r.occurred_on IS NOT NULL
                                     ORDER BY r.entity_id, r.occurred_on DESC)
                                 SELECT e.slug, e.name, l.occurred_on,
                                        (SELECT COUNT(*) FROM review_records r WHERE r.entity_id = l.entity_id AND r.kind = 'inspection_violation' AND ${ACTIVE_RECORD} AND r.occurred_on = l.occurred_on) AS violations,
                                        (SELECT COUNT(*) FROM review_records r WHERE r.entity_id = l.entity_id AND r.kind = 'inspection_violation' AND ${ACTIVE_RECORD} AND r.occurred_on = l.occurred_on
                                            AND r.fields->>'critical_flag' = 'Critical') AS critical,
                                        (SELECT r.fields->>'grade' FROM review_records r WHERE r.entity_id = l.entity_id AND r.kind = 'inspection_violation' AND ${ACTIVE_RECORD}
                                            AND r.fields->>'grade' IS NOT NULL ORDER BY r.occurred_on DESC LIMIT 1) AS grade,
                                        (SELECT r.fields->>'boro' FROM review_records r WHERE r.entity_id = l.entity_id AND r.kind = 'inspection_violation' AND ${ACTIVE_RECORD} LIMIT 1) AS boro,
                                        (SELECT r.fields->>'cuisine' FROM review_records r WHERE r.entity_id = l.entity_id AND r.kind = 'inspection_violation' AND ${ACTIVE_RECORD} LIMIT 1) AS cuisine
                                 FROM latest l JOIN review_entities e ON e.id = l.entity_id AND e.state = 'active'
                                 ORDER BY l.occurred_on DESC, e.name LIMIT ?`),
        hazardous: db.prepare(`SELECT e.slug, e.name, (r.fields->>'c')::bigint AS c, (r.fields->>'b')::bigint AS b, (r.fields->>'open')::bigint AS open, r.fields->>'boro' AS boro
                               FROM review_records r JOIN review_entities e ON e.id = r.entity_id AND e.state = 'active'
                               WHERE r.kind = 'housing_violation_tally' AND ${ACTIVE_RECORD} AND r.fields->>'c' IS NOT NULL
                               ORDER BY (r.fields->>'c')::bigint DESC, e.name LIMIT ?`),
        complaints: db.prepare(`SELECT e.slug, e.name, (r.fields->>'complaints')::bigint AS complaints
                                FROM review_records r JOIN review_entities e ON e.id = r.entity_id AND e.state = 'active'
                                WHERE r.kind = 'complaint_tally' AND ${ACTIVE_RECORD} AND r.fields->>'complaints' IS NOT NULL
                                ORDER BY (r.fields->>'complaints')::bigint DESC, e.name LIMIT ?`),
    };
    const n = (v) => (v == null ? null : Number(v));
    const lim = (x, d) => Math.min(50, Math.max(1, Number(x) || d));
    return {
        async stats() {
            const r = (await q.stats.get()) || {};
            return { pages: n(r.pages) || 0, records: n(r.records) || 0, signals: n(r.signals) || 0, memberReviews: n(r.member_reviews) || 0, seen: n(r.seen) || 0 };
        },
        async latestInspections(limit = 8) {
            return (await q.inspections.all(lim(limit, 8))).map((x) => ({ ...x, violations: n(x.violations) || 0, critical: n(x.critical) || 0 }));
        },
        async mostHazardous(limit = 6) {
            return (await q.hazardous.all(lim(limit, 6))).map((x) => ({ ...x, c: n(x.c), b: n(x.b), open: n(x.open) }));
        },
        async mostComplaints(limit = 6) {
            return (await q.complaints.all(lim(limit, 6))).map((x) => ({ ...x, complaints: n(x.complaints) }));
        },
    };
}

module.exports = { createHome };
