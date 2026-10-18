'use strict';
/**
 * The reviews domain: entities and aliases, resolution of Sources items to entities, signals with
 * provenance, aggregates, reversible merges, summaries, corrections. Reviews owns the
 * interpretation and publication layer; OpenVibe.Sources owns the items, Community the discussion,
 * OpenVibe.AI only proposes drafts.
 *
 * Every write runs in one PostgreSQL transaction together with the events it causes (transactional
 * outbox): reviews.entity.merged|split, reviews.signal.added|removed,
 * reviews.summary.published|updated|unpublished (a correction is an `updated` carrying
 * `correction`), and the Search index events reviews.index_document.upserted|deleted.
 *
 * Methods take an actor (server/reviews/access.js) and throw ReviewsError (status + stable code).
 */
const { AsyncLocalStorage } = require('async_hooks');
const seo = require('openvibe-publishing/seo');
const hooks = require('openvibe-publishing/index-hooks');
const authorship = require('openvibe-publishing/authorship');
const ssr = require('openvibe-publishing/ssr');
const { createPublication: createPublicationGlue } = require('openvibe-publishing/publication');
const { normalize: norm } = require('openvibe-publishing/ingest');
const { ulid } = require('openvibe-contracts').ids;
const extract = require('./extract');
const { computeAggregate, hashOf } = require('./aggregate');
const { createAccess } = require('./access');
const { ENTITY_KINDS, ALIAS_TYPES, LINK_TYPES, TRUST_KEYS } = require('../db');

class ReviewsError extends Error {
    constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; if (extra) this.extra = extra; }
}

const ITEM_RE = /^itm_[0-9A-HJKMNP-TV-Z]{26}$/;
const ENTITY_ID_RE = /^ent_[0-9A-HJKMNP-TV-Z]{26}$/;
const SIGNAL_ID_RE = /^sig_[0-9A-HJKMNP-TV-Z]{26}$/;
const SUMMARY_WORKFLOW = 'reviews.summarize_entity';
const MAX_POINTS = 12;
const MAX_POINT = 600;
const MAX_OVERVIEW = 6000;
const MIN_CORRECTION_NOTE = 10;
const MAX_CORRECTION_NOTE = 2000;
// Correction requests one person may send per rolling day (the per-IP limit is in server/app.js).
const CORRECTIONS_PER_PERSON_DAY = 20;
const DAY_MS = 24 * 3600 * 1000;
const MAX_AUDIT_TEXT = 2000;
// A summary is text with citations. Nothing in it can carry a score.
const SUMMARY_KEYS = new Set(['overview', 'pros', 'cons', 'overview_signals', 'expected_revision', 'expectedRevision', 'message', 'publish', 'workflow', 'stub_provider', 'stubProvider', 'note', 'correction_note', 'correction_id']);
const BODY_KEYS = ['overview', 'overview_signals', 'pros', 'cons'];
const RATING_KEY_RE = /(rating|stars?|score|grade|verdict_value)/i;
// Numeric ratings in AI text ("4.5/5", "8 out of 10", "★★★★", "four and a half stars", "nine out of
// ten"): AI output never states a rating.
const NUMBER_WORD = '(?:zero|one|two|three|four|five|six|seven|eight|nine|ten)(?:[\\s-]+and[\\s-]+a[\\s-]+half)?';
const RATING_TEXT_RE = new RegExp([
    '(\\b\\d+(?:[.,]\\d+)?\\s*(?:\\/|out of)\\s*(?:5|10|100)\\b)', '[★☆⭐]', '\\b\\d+(?:[.,]\\d+)?\\s*stars?\\b',
    `\\b${NUMBER_WORD}[\\s-]+stars?\\b`, `\\b${NUMBER_WORD}\\s+out\\s+of\\s+(?:five|ten|a\\s+hundred|one\\s+hundred|5|10|100)\\b`,
].join('|'), 'i');

const toIso = (ms) => (ms == null ? null : new Date(ms).toISOString());

// Official records' names (CFPB lists companies in capitals): readable, with companies' own spellings.
const SMALL_WORDS = new Set(['a', 'an', 'and', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'de', 'la', 'del', 'n']);
const KEEP_UPPER = /^(LLC|LLP|LP|NA|N\.A\.|USA|US|U\.S\.|NY|NYC|BBQ|II|III|IV|FSB|PLC|AG|SA|BMW|HSBC|TD|USAA|PNC|BBVA|NFCU|MBA|IHOP|KFC|PLLC|PC|CO-OP|ATM|ACE|AAA|CFPB)$/;
// Names a company spells its own way.
const OWN_SPELLING = { JPMORGAN: 'JPMorgan', TRANSUNION: 'TransUnion', PAYPAL: 'PayPal', EBAY: 'eBay', SOFI: 'SoFi', MONEYGRAM: 'MoneyGram', LENDINGCLUB: 'LendingClub',
    MCDONALDS: 'McDonald\'s', "MCDONALD'S": "McDonald's", IPHONE: 'iPhone', LOANDEPOT: 'loanDepot', NAVIENT: 'Navient', DITECH: 'Ditech', CASHAPP: 'Cash App', CREDITONE: 'Credit One' };
/** "CAPITAL ONE FINANCIAL CORPORATION" → "Capital One Financial Corporation"; mixed-case names stay as written. */
function recordName(raw) {
    const t = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!t || /[a-z]/.test(t)) return t;
    return t.split(' ').map((w, i) => {
        const bare = w.replace(/[,.]$/, '');
        if (OWN_SPELLING[bare]) return OWN_SPELLING[bare] + w.slice(bare.length);
        if (KEEP_UPPER.test(bare)) return w;
        // A short word without vowels is an abbreviation (SLM, PNC, TD Bank's TD).
        if (bare.length <= 4 && !/[AEIOUY]/.test(bare) && /^[A-Z&]+$/.test(bare)) return w;
        const lower = w.toLowerCase();
        if (i > 0 && SMALL_WORDS.has(lower)) return lower;
        return lower.replace(/(^|[-/&(.'])([a-z])/g, (m, p1, c) => p1 + c.toUpperCase()).replace(/^Mc([a-z])/, (m, c) => `Mc${c.toUpperCase()}`).replace(/'S\b/g, "'s");
    }).join(' ').replace(/\bInc\b/g, 'Inc.').replace(/\bInc\.\./g, 'Inc.').replace(/\bLlc\b/g, 'LLC');
}

function createReviewsService({ db, stores, outbox, config, now = () => Date.now(), log = console, indexnow = null }) {
    const { revisions, reviews, redirects, discussions, sequencer } = stores;
    const access = createAccess(config);
    const origin = config.baseUrl;
    const policy = config.gate;

    const q = {
        entity: db.prepare('SELECT * FROM review_entities WHERE id = ?'),
        entityBySlug: db.prepare('SELECT * FROM review_entities WHERE slug = ?'),
        insertEntity: db.prepare(`INSERT INTO review_entities (id, slug, name, kind, description, created_by, created_at, updated_at)
                                  VALUES (@id, @slug, @name, @kind, @description, @created_by, @now, @now)`),
        mergedInto: db.prepare("SELECT id FROM review_entities WHERE merged_into = ? AND state = 'merged'"),
        listActive: db.prepare(`SELECT e.* FROM review_entities e WHERE e.state = 'active' ORDER BY lower(e.name) LIMIT ? OFFSET ?`),
        countActive: db.prepare("SELECT COUNT(*) AS n FROM review_entities WHERE state = 'active'"),
        searchEntities: db.prepare(`SELECT e.* FROM review_entities e
                                    WHERE e.state = 'active' AND (e.name ILIKE @like ESCAPE '\\'
                                          OR EXISTS (SELECT 1 FROM review_entity_aliases a WHERE a.entity_id = e.id AND a.removed_at IS NULL AND a.type = 'name' AND a.norm ILIKE @nlike ESCAPE '\\'))
                                    ORDER BY lower(e.name) LIMIT @limit`),
        alias: db.prepare('SELECT * FROM review_entity_aliases WHERE id = ?'),
        aliasesOf: db.prepare('SELECT * FROM review_entity_aliases WHERE entity_id = ? AND removed_at IS NULL ORDER BY type, norm'),
        strongAlias: db.prepare("SELECT * FROM review_entity_aliases WHERE type = ? AND norm = ? AND removed_at IS NULL AND type != 'name'"),
        nameAliases: db.prepare("SELECT * FROM review_entity_aliases WHERE type = 'name' AND norm = ? AND removed_at IS NULL"),
        insertAlias: db.prepare(`INSERT INTO review_entity_aliases (id, entity_id, type, value, norm, created_by, created_at) VALUES (@id, @entity_id, @type, @value, @norm, @by, @now)`),
        removeAlias: db.prepare('UPDATE review_entity_aliases SET removed_at = ?, removed_by = ? WHERE id = ? AND removed_at IS NULL'),
        // Members' own reviews (migrations/0004): one per person per entity, beside the source signals.
        memberReviewsOf: db.prepare("SELECT * FROM review_member_reviews WHERE entity_id = ? AND status = 'published' ORDER BY created_at DESC LIMIT ?"),
        memberStatsOf: db.prepare(`SELECT COUNT(*) AS n, AVG(rating)::float8 AS avg,
                                          COUNT(*) FILTER (WHERE rating = 1) AS r1, COUNT(*) FILTER (WHERE rating = 2) AS r2, COUNT(*) FILTER (WHERE rating = 3) AS r3,
                                          COUNT(*) FILTER (WHERE rating = 4) AS r4, COUNT(*) FILTER (WHERE rating = 5) AS r5,
                                          COALESCE(SUM(array_length(regexp_split_to_array(trim(body), '\\s+'), 1)), 0) AS words
                                   FROM review_member_reviews WHERE entity_id = ? AND status = 'published'`),
        memberReview: db.prepare('SELECT * FROM review_member_reviews WHERE id = ?'),
        memberReviewBy: db.prepare('SELECT * FROM review_member_reviews WHERE entity_id = ? AND author = ?'),
        insertMemberReview: db.prepare(`INSERT INTO review_member_reviews (id, entity_id, author, author_name, rating, title, body, relation, created_at, updated_at)
                                        VALUES (@id, @entity_id, @author, @author_name, @rating, @title, @body, @relation, @now, @now)`),
        updateMemberReview: db.prepare(`UPDATE review_member_reviews SET rating = @rating, title = @title, body = @body, relation = @relation, author_name = @author_name,
                                               status = 'published', removed_by = NULL, removed_reason = NULL, removed_at = NULL, updated_at = @now WHERE id = @id`),
        removeMemberReview: db.prepare("UPDATE review_member_reviews SET status = 'removed', removed_by = ?, removed_reason = ?, removed_at = ?, updated_at = ? WHERE id = ? AND status = 'published'"),
        recentMemberReviews: db.prepare(`SELECT r.*, e.slug AS entity_slug, e.name AS entity_name, e.kind AS entity_kind, e.description AS entity_place
                                         FROM review_member_reviews r JOIN review_entities e ON e.id = r.entity_id
                                         WHERE r.status = 'published' AND e.state = 'active' ORDER BY r.created_at DESC LIMIT ?`),
        entitiesOfKind: db.prepare(`SELECT e.*, (SELECT COUNT(*) FROM review_member_reviews m WHERE m.entity_id = e.id AND m.status = 'published') AS member_count,
                                           (SELECT AVG(m.rating)::float8 FROM review_member_reviews m WHERE m.entity_id = e.id AND m.status = 'published') AS member_avg,
                                           (SELECT MAX((r.fields->>'complaints')::bigint) FROM review_records r WHERE r.entity_id = e.id AND r.status = 'active' AND r.kind = 'complaint_tally') AS complaints,
                                           (SELECT MAX((r.fields->>'c')::bigint) FROM review_records r WHERE r.entity_id = e.id AND r.status = 'active' AND r.kind = 'housing_violation_tally') AS hazardous,
                                           (SELECT MAX(r.occurred_on) FROM review_records r WHERE r.entity_id = e.id AND r.status = 'active' AND r.kind = 'inspection_violation') AS inspected_on,
                                           (SELECT r.fields->>'grade' FROM review_records r WHERE r.entity_id = e.id AND r.status = 'active' AND r.kind = 'inspection_violation' AND r.fields->>'grade' IS NOT NULL
                                             ORDER BY r.occurred_on DESC LIMIT 1) AS grade
                                    FROM review_entities e WHERE e.state = 'active' AND e.kind = ?
                                    ORDER BY member_count DESC, complaints DESC NULLS LAST, hazardous DESC NULLS LAST, inspected_on DESC NULLS LAST, e.updated_at DESC LIMIT ? OFFSET ?`),
        countOfKind: db.prepare("SELECT COUNT(*) AS n FROM review_entities WHERE state = 'active' AND kind = ?"),
        kindCounts: db.prepare("SELECT kind, COUNT(*) AS n FROM review_entities WHERE state = 'active' GROUP BY kind"),
        memberReviewsSince: db.prepare('SELECT COUNT(*) AS n FROM review_member_reviews WHERE author = ? AND created_at > ?'),
        memberEntitiesSince: db.prepare('SELECT COUNT(*) AS n FROM review_entities WHERE created_by = ? AND created_at > ?'),
        // Official records (migrations/0007).
        recordByItem: db.prepare('SELECT * FROM review_records WHERE source_item_id = ?'),
        insertRecord: db.prepare(`INSERT INTO review_records (id, entity_id, source_key, source_item_id, kind, occurred_on, fields, item_revision, retrieved_at, status, created_at, updated_at)
                                  VALUES (@id, @entity_id, @source_key, @source_item_id, @kind, @occurred_on, @fields, @item_revision, @retrieved_at, 'active', @now, @now)`),
        updateRecord: db.prepare(`UPDATE review_records SET entity_id = @entity_id, occurred_on = @occurred_on, fields = @fields, item_revision = @item_revision,
                                         retrieved_at = @retrieved_at, status = 'active', updated_at = @now WHERE id = @id`),
        removeRecord: db.prepare("UPDATE review_records SET status = 'removed', updated_at = ? WHERE id = ?"),
        recordsOf: db.prepare(`SELECT kind, occurred_on, fields, retrieved_at, source_key FROM review_records WHERE entity_id = ANY(?::text[]) AND status = 'active'
                               ORDER BY kind, occurred_on DESC NULLS LAST, retrieved_at DESC LIMIT 400`),
        externalAlias: db.prepare("SELECT entity_id FROM review_entity_aliases WHERE type = 'external' AND norm = ? AND removed_at IS NULL LIMIT 1"),
        externalOfScheme: db.prepare("SELECT 1 FROM review_entity_aliases WHERE entity_id = ? AND type = 'external' AND norm LIKE ? AND removed_at IS NULL LIMIT 1"),
        // Ratings other sites show, as members saw them (migrations/0006).
        seenRatingsOf: db.prepare(`SELECT site, page_url, rating_value::float8 AS rating_value, rating_best::float8 AS rating_best, rating_count, seen_at, via, id, seen_by
                                   FROM review_seen_ratings WHERE entity_id = ? AND status = 'shown' ORDER BY seen_at DESC LIMIT 200`),
        seenRatingBy: db.prepare('SELECT * FROM review_seen_ratings WHERE entity_id = ? AND site = ? AND seen_by = ?'),
        seenRating: db.prepare('SELECT * FROM review_seen_ratings WHERE id = ?'),
        insertSeenRating: db.prepare(`INSERT INTO review_seen_ratings (id, entity_id, site, page_url, rating_value, rating_best, rating_count, seen_by, seen_at, via)
                                      VALUES (@id, @entity_id, @site, @page_url, @rating_value, @rating_best, @rating_count, @seen_by, @now, @via)`),
        updateSeenRating: db.prepare(`UPDATE review_seen_ratings SET page_url = @page_url, rating_value = @rating_value, rating_best = @rating_best, rating_count = @rating_count,
                                             seen_at = @now, via = @via, status = 'shown', removed_by = NULL, removed_reason = NULL WHERE id = @id`),
        removeSeenRating: db.prepare("UPDATE review_seen_ratings SET status = 'removed', removed_by = ?, removed_reason = ? WHERE id = ? AND status = 'shown'"),
        seenRatingsSince: db.prepare('SELECT COUNT(*) AS n FROM review_seen_ratings WHERE seen_by = ? AND seen_at > ?'),
        sameNamedOfKind: db.prepare(`SELECT e.* FROM review_entities e JOIN review_entity_aliases a ON a.entity_id = e.id
                                     WHERE a.type = 'name' AND a.norm = ? AND a.removed_at IS NULL AND e.kind = ? AND e.state = 'active' ORDER BY e.created_at`),
        link: db.prepare('SELECT * FROM review_entity_links WHERE id = ?'),
        linksFrom: db.prepare("SELECT * FROM review_entity_links WHERE from_entity = ? AND ended_at IS NULL AND type != 'merged_into' ORDER BY created_at"),
        linksTo: db.prepare("SELECT * FROM review_entity_links WHERE to_entity = ? AND ended_at IS NULL AND type != 'merged_into' ORDER BY created_at"),
        activeMerge: db.prepare("SELECT * FROM review_entity_links WHERE from_entity = ? AND type = 'merged_into' AND ended_at IS NULL"),
        mergeLinksOf: db.prepare("SELECT * FROM review_entity_links WHERE type = 'merged_into' AND (from_entity = ? OR to_entity = ?) ORDER BY created_at"),
        insertLink: db.prepare(`INSERT INTO review_entity_links (id, from_entity, to_entity, type, ref, note, created_by, created_at) VALUES (@id, @from, @to, @type, @ref, @note, @by, @now)`),
        endLink: db.prepare('UPDATE review_entity_links SET ended_at = ?, ended_by = ?, end_note = ? WHERE id = ? AND ended_at IS NULL'),
        source: db.prepare('SELECT * FROM review_sources WHERE key = ?'),
        insertSource: db.prepare(`INSERT INTO review_sources (key, name, homepage_url, category, license_note, terms_note, status, stale, last_success_at, first_seen_at, updated_at)
                                  VALUES (@key, @name, @homepage_url, @category, @license_note, @terms_note, @status, @stale, @last_success_at, @now, @now)`),
        updateSource: db.prepare(`UPDATE review_sources SET name = COALESCE(@name, name), homepage_url = COALESCE(@homepage_url, homepage_url), category = COALESCE(@category, category),
                                  license_note = @license_note, terms_note = @terms_note, status = COALESCE(@status, status), stale = COALESCE(@stale, stale),
                                  last_success_at = COALESCE(@last_success_at, last_success_at), updated_at = @now WHERE key = @key`),
        item: db.prepare('SELECT * FROM review_source_items WHERE id = ?'),
        insertItem: db.prepare(`INSERT INTO review_source_items (id, source_key, kind, identity, canonical_url, title, item_revision, content_hash, published_at, retrieved_at,
                                    parser_version, license_note, terms_note, fields, state, removed_at, removed_reason, resolution, entity_id, resolution_rule, candidates, resolved_by, resolved_at, signal_note, first_seen_at, updated_at)
                                VALUES (@id, @source_key, @kind, @identity, @canonical_url, @title, @item_revision, @content_hash, @published_at, @retrieved_at,
                                    @parser_version, @license_note, @terms_note, @fields, @state, @removed_at, @removed_reason, @resolution, @entity_id, @resolution_rule, @candidates, @resolved_by, @resolved_at, @signal_note, @now, @now)`),
        updateItemContent: db.prepare(`UPDATE review_source_items SET kind = @kind, identity = @identity, canonical_url = @canonical_url, title = @title, item_revision = @item_revision,
                                    content_hash = @content_hash, published_at = @published_at, retrieved_at = @retrieved_at, parser_version = @parser_version,
                                    license_note = @license_note, terms_note = @terms_note, fields = @fields, signal_note = @signal_note, updated_at = @now WHERE id = @id`),
        touchItem: db.prepare('UPDATE review_source_items SET retrieved_at = ?, updated_at = ? WHERE id = ? AND retrieved_at < ?'),
        setResolution: db.prepare(`UPDATE review_source_items SET resolution = @resolution, entity_id = @entity_id, resolution_rule = @rule, candidates = @candidates,
                                    resolved_by = @by, resolved_at = @at, updated_at = @now WHERE id = @id`),
        removeItem: db.prepare("UPDATE review_source_items SET state = 'removed', removed_at = ?, removed_reason = ?, updated_at = ? WHERE id = ?"),
        queueItems: db.prepare(`SELECT * FROM review_source_items WHERE resolution IN ('ambiguous','unmatched') AND state = 'active' ORDER BY updated_at DESC LIMIT ?`),
        unresolvedItems: db.prepare("SELECT * FROM review_source_items WHERE resolution IN ('ambiguous','unmatched') AND state = 'active' ORDER BY first_seen_at"),
        itemsOfEntity: db.prepare('SELECT * FROM review_source_items WHERE entity_id = ?'),
        signal: db.prepare('SELECT * FROM review_signals WHERE id = ?'),
        activeSignalOfItem: db.prepare("SELECT * FROM review_signals WHERE source_item_id = ? AND status = 'active'"),
        signalsOfEntity: db.prepare('SELECT * FROM review_signals WHERE entity_id = ? ORDER BY observed_at DESC, id DESC'),
        activeSignalsOfEntity: db.prepare("SELECT * FROM review_signals WHERE entity_id = ? AND status = 'active' ORDER BY observed_at DESC, id DESC"),
        entitiesWithSourceSignals: db.prepare("SELECT DISTINCT entity_id FROM review_signals WHERE source_key = ? AND status = 'active'"),
        insertSignal: db.prepare(`INSERT INTO review_signals (id, entity_id, source_item_id, source_key, item_revision, type, recommended, positive_count, total_count,
                                      rating_value, rating_best, rating_worst, rating_count, observed_at, source_published_at, canonical_url, license_note, trust, created_by, created_at)
                                  VALUES (@id, @entity_id, @source_item_id, @source_key, @item_revision, @type, @recommended, @positive_count, @total_count,
                                      @rating_value, @rating_best, @rating_worst, @rating_count, @observed_at, @source_published_at, @canonical_url, @license_note, @trust, @created_by, @now)`),
        setSignalStatus: db.prepare("UPDATE review_signals SET status = @status, status_reason = @reason, status_at = @at, superseded_by = @superseded_by WHERE id = @id AND status = 'active'"),
        trustCurrent: db.prepare('SELECT * FROM review_trust_metadata WHERE scope = ? AND scope_id = ? AND ended_at IS NULL ORDER BY key'),
        trustOne: db.prepare('SELECT * FROM review_trust_metadata WHERE scope = ? AND scope_id = ? AND key = ? AND ended_at IS NULL'),
        trustEnd: db.prepare('UPDATE review_trust_metadata SET ended_at = ?, ended_by = ? WHERE id = ?'),
        trustInsert: db.prepare('INSERT INTO review_trust_metadata (scope, scope_id, key, value, note, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
        trustHistory: db.prepare('SELECT * FROM review_trust_metadata WHERE (scope = ? AND scope_id = ?) ORDER BY id'),
        excludedSources: db.prepare("SELECT scope_id, note FROM review_trust_metadata WHERE scope = 'source' AND key = 'aggregate' AND value = 'exclude' AND ended_at IS NULL"),
        excludedSignals: db.prepare("SELECT scope_id, note FROM review_trust_metadata WHERE scope = 'signal' AND key = 'aggregate' AND value = 'exclude' AND ended_at IS NULL"),
        lastAggregate: db.prepare('SELECT * FROM review_aggregates WHERE entity_id = ? ORDER BY revision DESC LIMIT 1'),
        aggregates: db.prepare('SELECT * FROM review_aggregates WHERE entity_id = ? ORDER BY revision DESC LIMIT ?'),
        insertAggregate: db.prepare('INSERT INTO review_aggregates (entity_id, revision, computed_at, trigger, inputs_hash, result) VALUES (?, ?, ?, ?, ?, ?)'),
        summary: db.prepare('SELECT * FROM review_summaries WHERE entity_id = ?'),
        summaryById: db.prepare('SELECT * FROM review_summaries WHERE id = ?'),
        insertSummary: db.prepare('INSERT INTO review_summaries (id, entity_id, created_at, updated_at) VALUES (?, ?, ?, ?)'),
        publishSummary: db.prepare(`UPDATE review_summaries SET state = 'published', published_revision = @n, published_at = COALESCE(published_at, @now),
                                    revision_published_at = @now, flagged = 0, flag_reason = NULL, flagged_at = NULL, updated_at = @now WHERE id = @id`),
        unpublishSummary: db.prepare("UPDATE review_summaries SET state = 'unpublished', updated_at = ? WHERE id = ?"),
        flagSummary: db.prepare('UPDATE review_summaries SET flagged = 1, flag_reason = ?, flagged_at = ?, updated_at = ? WHERE id = ?'),
        insertCitation: db.prepare('INSERT INTO review_summary_citations (summary_id, revision, point, signal_id) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING'),
        citationsOf: db.prepare('SELECT * FROM review_summary_citations WHERE summary_id = ? AND revision = ? ORDER BY point, signal_id'),
        summariesCiting: db.prepare('SELECT DISTINCT summary_id FROM review_summary_citations WHERE signal_id = ?'),
        flaggedSummaries: db.prepare('SELECT * FROM review_summaries WHERE flagged = 1 ORDER BY flagged_at DESC LIMIT 200'),
        allSummaries: db.prepare('SELECT * FROM review_summaries ORDER BY updated_at DESC LIMIT 500'),
        publishedSummaries: db.prepare("SELECT * FROM review_summaries WHERE state = 'published' ORDER BY revision_published_at DESC LIMIT ?"),
        correction: db.prepare('SELECT * FROM review_corrections WHERE id = ?'),
        correctionsSince: db.prepare('SELECT COUNT(*) AS n FROM review_corrections WHERE submitted_by = ? AND created_at > ?'),
        sameOpenCorrection: db.prepare("SELECT id FROM review_corrections WHERE submitted_by = ? AND entity_id = ? AND status = 'open' AND body = ?"),
        insertCorrection: db.prepare(`INSERT INTO review_corrections (id, entity_id, target_type, target_id, body, evidence_url, submitted_by, via, created_at)
                                      VALUES (@id, @entity_id, @target_type, @target_id, @body, @evidence_url, @submitted_by, @via, @now)`),
        resolveCorrection: db.prepare("UPDATE review_corrections SET status = ?, resolved_by = ?, resolution_note = ?, resolved_at = ? WHERE id = ? AND status = 'open'"),
        openCorrections: db.prepare("SELECT * FROM review_corrections WHERE status = 'open' ORDER BY created_at LIMIT 200"),
        openCorrectionsOf: db.prepare("SELECT COUNT(*) AS n FROM review_corrections WHERE entity_id = ? AND status = 'open'"),
        audit: db.prepare('INSERT INTO review_audit (at, actor, action, entity_id, target, detail) VALUES (?, ?, ?, ?, ?, ?)'),
        auditOf: db.prepare('SELECT * FROM review_audit WHERE entity_id = ? OR target = ? ORDER BY id DESC LIMIT 300'),
        allEntityIds: db.prepare('SELECT id FROM review_entities ORDER BY id'),
    };

    // ── Small helpers ────────────────────────────────────────
    const fail = (status, code, message, extra) => { throw new ReviewsError(status, code, message, extra); };
    const tx = async (fn) => await db.tx(async () => await fn());   // ambient: plain db calls inside join it
    const entityPath = (e) => `/e/${encodeURIComponent(e.slug)}`;
    const entityUrl = (e) => seo.canonicalUrl(origin, entityPath(e));
    // The publication glue (openvibe-publishing/publication): the index document's revision, its
    // search.index-document@1 event, the outbox write and the IndexNow ping, all on the caller's
    // transaction handle. Reviews' gate, document builder and canonical path stay here.
    const publication = createPublicationGlue({ owner: 'reviews', sequencer, outbox, baseUrl: origin, indexnow, db, now });
    const parse = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };

    function actorId(actor) {
        if (!actor) return 'svc:reviews';
        if (actor.subject) return actor.subject;
        if (actor.service) return actor.service;
        return 'svc:reviews';
    }
    function requireEditorPerson(actor, what) {
        if (!access.isPerson(actor)) fail(403, 'reviews.person_required', `${what} is decided by a signed-in editor (a service must name the person in X-OV-Subject)`);
        if (!access.isEditor(actor)) fail(403, 'reviews.editor_required', `${what} is for Reviews editors`);
        return actor.subject;
    }
    function requireEditor(actor, what) {
        if (!access.isEditor(actor)) fail(403, 'reviews.editor_required', `${what} is for Reviews editors`);
        return actorId(actor);
    }
    // Audit rows are append-only and kept forever: no free text in one grows without bound.
    function clipText(v, depth = 0) {
        if (typeof v === 'string') return v.length > MAX_AUDIT_TEXT ? `${v.slice(0, MAX_AUDIT_TEXT)}…` : v;
        if (Array.isArray(v)) return v.map((x) => clipText(x, depth + 1));
        if (v && typeof v === 'object' && depth < 4) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clipText(x, depth + 1)]));
        return v;
    }
    async function audit(actor, action, entityId, target, detail = {}) {
        await q.audit.run(now(), typeof actor === 'string' ? actor : actorId(actor), action, entityId || null, target || null, JSON.stringify(clipText(detail)));
    }
    async function emit(envelope) { return await outbox.enqueue(db, envelope); }

    async function entityOrFail(ref) {
        const s = String(ref == null ? '' : ref);
        const e = ENTITY_ID_RE.test(s) ? await q.entity.get(s) : await q.entityBySlug.get(s);
        if (!e) fail(404, 'entity.not_found', 'No such entity');
        return e;
    }

    /** The entity a merged entity now lives under (follows merged_into). */
    async function canonicalOf(entityId) {
        let e = await q.entity.get(entityId);
        const seen = new Set();
        while (e && e.state === 'merged' && e.merged_into && !seen.has(e.id)) { seen.add(e.id); e = await q.entity.get(e.merged_into); }
        return e ? e.id : null;
    }

    /** The entity and every entity merged into it, transitively. */
    async function closure(entityId) {
        const out = new Set([entityId]);
        const stack = [entityId];
        while (stack.length) {
            const id = stack.pop();
            for (const r of await q.mergedInto.all(id)) if (!out.has(r.id)) { out.add(r.id); stack.push(r.id); }
        }
        return out;
    }

    async function activeSignalsIn(ids) {
        const out = [];
        for (const id of ids) out.push(...await q.activeSignalsOfEntity.all(id));
        return out.sort((a, b) => (a.observed_at < b.observed_at ? 1 : a.observed_at > b.observed_at ? -1 : (a.id < b.id ? 1 : -1)));
    }
    async function allSignalsIn(ids) {
        const out = [];
        for (const id of ids) out.push(...await q.signalsOfEntity.all(id));
        return out.sort((a, b) => (a.observed_at < b.observed_at ? 1 : a.observed_at > b.observed_at ? -1 : (a.id < b.id ? 1 : -1)));
    }

    // ── Aggregates ───────────────────────────────────────────
    async function exclusions() {
        return {
            sources: new Map((await q.excludedSources.all()).map((r) => [r.scope_id, r.note])),
            signals: new Map((await q.excludedSignals.all()).map((r) => [r.scope_id, r.note])),
        };
    }

    async function computeFor(canonicalId) {
        return computeAggregate(await activeSignalsIn(await closure(canonicalId)), { exclusions: await exclusions() });
    }

    /**
     * Records the next aggregate revision of the canonical entity when the result changed. A change
     * to nothing (every signal gone) is recorded as a revision whose result is null; an entity
     * that never had a qualifying signal has no aggregate row at all.
     */
    async function refreshAggregate(entityId, trigger) {
        const canon = await canonicalOf(entityId);
        const e = canon && await q.entity.get(canon);
        if (!e || e.state !== 'active') return null;
        const result = await computeFor(canon);
        const hash = hashOf(result);
        const last = await q.lastAggregate.get(canon);
        if (last && last.inputs_hash === hash) return last;
        if (!last && result === null) return null;
        const revision = last ? last.revision + 1 : 1;
        await q.insertAggregate.run(canon, revision, now(), String(trigger).slice(0, 60), hash, result ? JSON.stringify(result) : null);
        return await q.lastAggregate.get(canon);
    }

    function aggregateView(row) {
        if (!row) return null;
        return { revision: row.revision, computed_at: toIso(row.computed_at), trigger: row.trigger, result: row.result ? JSON.parse(row.result) : null };
    }

    // ── Summaries: shape, citations, validation ──────────────
    function summaryPoints(rev) {
        const f = rev ? rev.fields || {} : {};
        const out = [];
        if (Array.isArray(f.overview_signals) && f.overview_signals.length) out.push({ key: 'overview', kind: 'overview', text: rev.content, signals: f.overview_signals });
        (f.pros || []).forEach((p, i) => out.push({ key: `pro:${i}`, kind: 'pro', text: p.text, signals: p.signals || [] }));
        (f.cons || []).forEach((p, i) => out.push({ key: `con:${i}`, kind: 'con', text: p.text, signals: p.signals || [] }));
        return out;
    }

    function summaryText(rev) {
        if (!rev) return '';
        const f = rev.fields || {};
        return [rev.content || '', ...(f.pros || []).map((p) => p.text), ...(f.cons || []).map((p) => p.text)].join('\n');
    }

    /** For each point of a revision: which cited signals are still active and belong to the entity. */
    async function citationState(canonicalId, rev) {
        const members = await closure(canonicalId);
        return Promise.all(summaryPoints(rev).map(async (p) => {
            const cites = (await Promise.all(p.signals.map(async (id) => {
                const s = await q.signal.get(id);
                const ok = !!(s && s.status === 'active' && members.has(s.entity_id));
                return { signal_id: id, ok, status: s ? s.status : 'missing', in_entity: !!(s && members.has(s.entity_id)), superseded_by: s ? s.superseded_by : null };
            })));
            return { ...p, cites, supported: cites.some((c) => c.ok) };
        }));
    }

    async function unsupportedCount(canonicalId, rev) {
        return (await citationState(canonicalId, rev)).filter((p) => !p.supported).length;
    }

    function cleanPoints(list, what) {
        if (list == null) return [];
        if (!Array.isArray(list)) fail(422, 'summary.invalid', `${what} must be a list of { text, signals }`);
        if (list.length > MAX_POINTS) fail(422, 'summary.invalid', `at most ${MAX_POINTS} ${what}`);
        return list.map((p, i) => {
            if (!p || typeof p !== 'object' || Array.isArray(p)) fail(422, 'summary.invalid', `${what}[${i}] must be { text, signals }`);
            for (const k of Object.keys(p)) {
                if (RATING_KEY_RE.test(k)) fail(422, 'summary.rating_forbidden', `${what}[${i}].${k}: a summary carries no rating; ratings come only from source signals`);
                if (k !== 'text' && k !== 'signals') fail(422, 'summary.invalid', `${what}[${i}].${k} is not a summary field`);
            }
            const text = String(p.text == null ? '' : p.text).replace(/\s+/g, ' ').trim();
            if (!text) fail(422, 'summary.invalid', `${what}[${i}] needs text`);
            if (text.length > MAX_POINT) fail(422, 'summary.invalid', `${what}[${i}] is at most ${MAX_POINT} characters`);
            const signals = [...new Set((Array.isArray(p.signals) ? p.signals : [p.signals]).filter((x) => x != null && x !== '').map(String))];
            if (!signals.length) fail(422, 'summary.uncited_point', `${what}[${i}] cites no signal: every pro and con cites the signals it rests on`);
            return { text, signals };
        });
    }

    /** Validates a summary body. Every cited signal must be active and belong to the entity. */
    async function checkSummaryInput(canonicalId, input, { ai = false } = {}) {
        if (!input || typeof input !== 'object') fail(422, 'summary.invalid', 'A summary is { overview, pros, cons }');
        for (const k of Object.keys(input)) {
            if (RATING_KEY_RE.test(k)) fail(422, 'summary.rating_forbidden', `${k}: a summary carries no rating; ratings come only from source signals`);
            if (!SUMMARY_KEYS.has(k)) fail(422, 'summary.invalid', `${k} is not a summary field`);
        }
        const overview = String(input.overview == null ? '' : input.overview).replace(/\r\n?/g, '\n').trim();
        if (overview.length > MAX_OVERVIEW) fail(422, 'summary.invalid', `The overview is at most ${MAX_OVERVIEW} characters`);
        const pros = cleanPoints(input.pros, 'pros');
        const cons = cleanPoints(input.cons, 'cons');
        const overviewSignals = [...new Set((Array.isArray(input.overview_signals) ? input.overview_signals : []).map(String))];
        if (!overview && !pros.length && !cons.length) fail(422, 'summary.empty', 'A summary needs an overview, pros or cons');
        if (overview && !overviewSignals.length && !pros.length && !cons.length) fail(422, 'summary.uncited_point', 'The overview cites no signal');
        if (ai) {
            for (const t of [overview, ...pros.map((p) => p.text), ...cons.map((p) => p.text)]) {
                if (RATING_TEXT_RE.test(t)) fail(422, 'summary.rating_in_text', 'AI-drafted text states no rating or star count; the aggregate comes only from source signals');
            }
        }
        const members = await closure(canonicalId);
        for (const id of [...overviewSignals, ...pros.flatMap((p) => p.signals), ...cons.flatMap((p) => p.signals)]) {
            if (!SIGNAL_ID_RE.test(id)) fail(422, 'summary.invalid_citation', `${id} is not a signal id`);
            const s = await q.signal.get(id);
            if (!s || !members.has(s.entity_id)) fail(422, 'summary.invalid_citation', `Signal ${id} does not belong to this entity`);
            if (s.status !== 'active') fail(422, 'summary.invalid_citation', `Signal ${id} is ${s.status}; cite the current signal`);
        }
        return { content: overview, fields: { pros, cons, overview_signals: overviewSignals } };
    }

    async function ensureSummary(entityId) {
        let s = await q.summary.get(entityId);
        if (!s) {
            const t = now();
            await q.insertSummary.run(`sum_${ulid(t)}`, entityId, t, t);
            s = await q.summary.get(entityId);
        }
        return s;
    }

    async function writeCitations(summary, rev) {
        for (const p of summaryPoints(rev)) for (const id of p.signals) await q.insertCitation.run(summary.id, rev.number, p.key, id);
    }

    function expectedOf(input, head) {
        if (input.expected_revision != null && input.expected_revision !== '') return Number(input.expected_revision);
        if (input.expectedRevision != null && input.expectedRevision !== '') return Number(input.expectedRevision);
        return head;
    }

    async function createRevision(args) {
        try {
            return (await revisions.create(args)).revision;
        } catch (err) {
            if (err && err.code === 'revision.conflict') fail(412, 'revision.conflict', err.message, { expected: err.expected, current: err.current });
            throw err;
        }
    }

    // ── Corrections of a published summary ───────────────────
    const wantsCorrection = (input) => [input.correction_note, input.correction_id].some((v) => v != null && String(v).trim() !== '');

    /** The correction note is public text: what was wrong and what changed. */
    function checkCorrectionNote(v) {
        const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
        if (s.length < MIN_CORRECTION_NOTE) fail(422, 'correction.note_required', `A correction says what was corrected, in a note readers will see (at least ${MIN_CORRECTION_NOTE} characters)`);
        if (s.length > MAX_CORRECTION_NOTE) fail(422, 'correction.invalid', `A correction note is at most ${MAX_CORRECTION_NOTE} characters`);
        return s;
    }

    /**
     * Who answers for a correction revision: the correcting editor joins the published revision's
     * authors. AI-drafted text a person corrected is AI-assisted (hybrid), never "written by a person".
     */
    function correctionAuthorship(base, who) {
        const authors = [...new Set([...((base && base.authors) || []), who])];
        if (base && (base.mode === 'ai' || base.mode === 'hybrid') && base.workflow) {
            return authorship.record({ mode: 'hybrid', authors, workflow: base.workflow, stubProvider: !!base.stubProvider });
        }
        return authorship.record({ mode: 'human', authors });
    }

    /** The published text as summary input (a correction that changes no words, e.g. after a signal fix). */
    function carryForward(rev) {
        const f = rev.fields || {};
        return { overview: rev.content || '', overview_signals: f.overview_signals || [], pros: f.pros || [], cons: f.cons || [] };
    }

    /**
     * Corrects a published summary: a new immutable revision carrying the public correction note
     * (who: its author, the editor; when: its time), approved by that editor and published at once.
     * Earlier revisions stay in the public history. Without new text the published text is carried
     * forward. An open correction request it answers is accepted in the same transaction; what the
     * request said and who sent it stay with the editors.
     */
    async function correctSummary(e, input, { note, requestId = null, resolutionNote = null }, actor, who) {
        const text = checkCorrectionNote(note);
        const summary = await q.summary.get(e.id);
        if (!summary || summary.state !== 'published' || !summary.published_revision) fail(409, 'summary.not_published', 'Only a published summary is corrected; save and publish a revision instead');
        let request = null;
        if (requestId != null && String(requestId).trim() !== '') {
            request = await q.correction.get(String(requestId).trim());
            if (!request) fail(404, 'correction.not_found', 'No such correction');
            if (await canonicalOf(request.entity_id) !== e.id) fail(409, 'correction.other_entity', 'That correction is about another entity');
            if (request.status !== 'open') fail(409, 'correction.closed', `Already ${request.status}`);
        }
        const pub = await revisions.get(summary.id, summary.published_revision);
        const body = await checkSummaryInput(e.id, BODY_KEYS.some((k) => input[k] !== undefined) ? input : carryForward(pub));
        const revision = await createRevision({
            entityId: summary.id, expectedRevision: expectedOf(input, await revisions.headNumber(summary.id)), content: body.content, fields: body.fields,
            meta: {
                authorship: correctionAuthorship(pub.meta && pub.meta.authorship, who),
                correction: { note: text, request: request ? request.id : null, corrects: pub.number },
            },
            author: who, message: input.message ? String(input.message).slice(0, 500) : `Correction: ${text.slice(0, 200)}`, allowUnchanged: true,
        });
        await writeCitations(summary, revision);
        await reviews.record({ entityId: summary.id, revision: revision.number, reviewer: who, decision: 'approved', note: 'correction' });
        if (request) {
            await q.resolveCorrection.run('accepted', who, resolutionNote, now(), request.id);
            await audit(actor, 'correction.accepted', e.id, request.id, { note: resolutionNote, summary_revision: revision.number });
        }
        await audit(actor, 'summary.corrected', e.id, summary.id, { revision: revision.number, corrects: pub.number, correction_id: request ? request.id : null });
        await svc.publishSummary(e.id, { revision: revision.number }, actor);
        const fresh = await q.summary.get(e.id);
        return { summary: fresh, revision: await summaryRevisionView(fresh, await revisions.get(summary.id, revision.number), e.id), published: true, correction: request ? await q.correction.get(request.id) : null };
    }

    async function revisionStatus(summary, rev) {
        const review = await reviews.latest(summary.id, rev.number);
        const rec = rev.meta && rev.meta.authorship;
        if (summary.state === 'published' && summary.published_revision === rev.number) return 'published';
        if (review && review.decision === 'rejected') return 'rejected';
        if (summary.published_revision && rev.number < summary.published_revision) return 'superseded';
        if (rev.meta && rev.meta.system) return 'pending_system';
        if (rec && authorship.needsReview(rec) && !authorship.isReviewed(rec, review)) return 'pending_ai';
        return 'draft';
    }

    /**
     * What a reader may see of a summary's history: revisions up to the published one while the
     * summary is published, never a rejected revision or an AI draft no person approved.
     */
    async function publicRevision(summary, rev) {
        if (!summary || summary.state !== 'published' || !summary.published_revision || rev.number > summary.published_revision) return false;
        const review = await reviews.latest(summary.id, rev.number);
        if (review && review.decision === 'rejected') return false;
        const rec = rev.meta && rev.meta.authorship;
        return !(rec && !authorship.canPublish(rec, review).ok);
    }

    async function pendingRevisions(summary) {
        const head = await revisions.headNumber(summary.id);
        const out = [];
        for (let n = (summary.published_revision || 0) + 1; n <= head; n++) {
            const rev = await revisions.get(summary.id, n);
            const st = await revisionStatus(summary, rev);
            if (st !== 'rejected') out.push({ rev, status: st });
        }
        return out;
    }

    // ── Members' reviews ─────────────────────────────────────
    // What members may add and review. Local kinds are told apart by their place (a city), kept as the description.
    const MEMBER_KINDS = ['employer', 'landlord', 'restaurant', 'business', 'hosting', 'product', 'app', 'software', 'game', 'vehicle', 'service', 'organization', 'place', 'community', 'platform'];
    const LOCAL_KINDS = new Set(['restaurant', 'business', 'landlord', 'place']);
    const MEMBER_REVIEWS_PER_DAY = 30;
    const MEMBER_ENTITIES_PER_DAY = 20;

    function requirePerson(actor, what) {
        if (!access.isPerson(actor)) fail(403, 'reviews.person_required', `${what} needs a signed-in OpenVibe account`);
        return actor.subject;
    }
    function memberName(actor) {
        const u = actor && actor.user;
        return u ? String(u.display_name || u.username || '').trim().slice(0, 60) || null : null;
    }
    /** Members' numbers over a set of entity ids (a canonical entity and the ones merged into it). */
    async function memberStats(ids) {
        let count = 0, sum = 0, words = 0;
        const distribution = [0, 0, 0, 0, 0];
        for (const id of ids) {
            const r = await q.memberStatsOf.get(id);
            const n = Number(r.n) || 0;
            if (!n) continue;
            count += n; sum += (Number(r.avg) || 0) * n; words += Number(r.words) || 0;
            [r.r1, r.r2, r.r3, r.r4, r.r5].forEach((v, i) => { distribution[i] += Number(v) || 0; });
        }
        return { count, average: count ? Math.round((sum / count) * 10) / 10 : null, distribution, words };
    }
    // Sites whose pages state a rating a member may bring here: the hosts a page must be on, and the kind it usually is.
    const SEEN_SITES = {
        glassdoor: { name: 'Glassdoor', host: /(^|\.)glassdoor\.[a-z.]{2,12}$/, kind: 'employer' },
        indeed: { name: 'Indeed', host: /(^|\.)indeed\.[a-z.]{2,12}$/, kind: 'employer' },
        yelp: { name: 'Yelp', host: /(^|\.)yelp\.[a-z.]{2,12}$/, kind: 'restaurant' },
        bbb: { name: 'Better Business Bureau', host: /(^|\.)bbb\.org$/, kind: 'business' },
        trustpilot: { name: 'Trustpilot', host: /(^|\.)trustpilot\.com$/, kind: 'organization' },
        google: { name: 'Google Maps', host: /(^|\.)(google\.[a-z.]{2,12}|goo\.gl)$/, kind: 'business' },
        tripadvisor: { name: 'Tripadvisor', host: /(^|\.)tripadvisor\.[a-z.]{2,12}$/, kind: 'restaurant' },
    };
    const SEEN_PER_DAY = 60;
    /** The site a page belongs to (by its host), or null. */
    function seenSiteOf(url) {
        let u;
        try { u = new URL(String(url || '')); } catch { return null; }
        if (u.protocol !== 'https:') return null;
        const h = u.hostname.toLowerCase();
        return Object.keys(SEEN_SITES).find((k) => SEEN_SITES[k].host.test(h)) || null;
    }

    function memberReviewView(r, actor) {
        return {
            id: r.id, rating: Number(r.rating), title: r.title, body: r.body, relation: r.relation || null,
            author_name: r.author_name || 'An OpenVibe member', created_at: toIso(Number(r.created_at)), updated_at: toIso(Number(r.updated_at)),
            edited: Number(r.updated_at) > Number(r.created_at) + 60000, mine: !!(actor && actor.subject && actor.subject === r.author),
        };
    }

    // ── The gate, the Search document ────────────────────────
    async function publishedSummaryRevision(entityId) {
        const s = await q.summary.get(entityId);
        if (!s || s.state !== 'published' || !s.published_revision) return { summary: s || null, rev: null };
        return { summary: s, rev: await revisions.get(s.id, s.published_revision) };
    }

    async function gateFacts(e) {
        const members = await closure(e.id);
        const active = await activeSignalsIn(members);
        const { summary, rev } = await publishedSummaryRevision(e.id);
        const rec = rev && rev.meta && rev.meta.authorship;
        // Members' reviews count as substance: their words (from three reviews up) and each review as a citation.
        const mem = await memberStats(members);
        // So do official records: their own lines and their public body as the source (recordSubstance).
        const recs = recordSubstance(await recordsView(e.id));
        return {
            state: e.state === 'deleted' ? 'deleted' : 'published',
            visibility: 'public',
            canonicalUrl: entityUrl(e),
            wordCount: (rev ? ssr.wordCount(summaryText(rev)) : 0) + (mem.count >= 3 ? mem.words : 0) + recs.words,
            citationCount: active.length + mem.count + recs.sources,
            unsupportedClaims: rev ? await unsupportedCount(e.id, rev) : 0,
            noindex: !!e.noindex,
            ...(rec ? authorship.gateFacts(rec, await reviews.latest(summary.id, rev.number)) : {}),
        };
    }

    async function decide(e) {
        return seo.evaluate(await gateFacts(e), { policy, now: now() });
    }

    /**
     * Sends Search the entity's current document (or a tombstone) when it differs from the last one.
     * The chassis (openvibe-publishing/publication) stamps the revision, enqueues the
     * search.index-document@1 event and pings IndexNow (an indexable page that appeared or changed,
     * or a page Search already had that went away) — all on the caller's transaction handle. Returns
     * the stamped document, or null when nothing changed.
     */
    /** Per site, the latest rating a member saw for an entity (merged ones included), with how many members saw it. */
    async function seenBySite(entityId) {
        const rows = [];
        for (const id of await closure(entityId)) rows.push(...await q.seenRatingsOf.all(id));
        const bySite = new Map();
        for (const r of rows.sort((a, b) => Number(b.seen_at) - Number(a.seen_at))) {
            const cur = bySite.get(r.site);
            if (!cur) bySite.set(r.site, { site: r.site, name: SEEN_SITES[r.site].name, id: r.id, page_url: r.page_url, value: Number(r.rating_value), best: Number(r.rating_best),
                count: r.rating_count == null ? null : Number(r.rating_count), seen_at: toIso(Number(r.seen_at)), via: r.via, members: 1, seen_by: r.seen_by });
            else cur.members += 1;
        }
        return Object.fromEntries(bySite);
    }

    async function syncEntity(entityId) {
        const e = await q.entity.get(entityId);
        if (!e) return null;
        const live = e.state === 'active';
        const decision = live ? await decide(e) : null;
        const { rev } = live ? await publishedSummaryRevision(e.id) : { rev: null };
        const agg = live ? aggregateView(await q.lastAggregate.get(e.id)) : null;
        const signals = live ? await activeSignalsIn(await closure(e.id)) : [];
        const lines = [];
        if (agg && agg.result) lines.push(...agg.result.computation);
        const mem = live ? await memberStats(await closure(e.id)) : { count: 0 };
        if (mem.count) lines.push(`OpenVibe members: ${mem.average} out of 5 from ${mem.count} review${mem.count === 1 ? '' : 's'}`);
        if (live) {
            const rec = await recordsView(e.id);
            if (rec.complaints) lines.push(`CFPB consumer complaints: ${rec.complaints.count} in the CFPB's database (as of ${String(rec.complaints.as_of).slice(0, 10)})`);
            const h = rec.housing;
            if (h) lines.push(`NYC HPD open housing-code violations: ${h.open} (class C immediately hazardous ${h.c}, B hazardous ${h.b}, A non-hazardous ${h.a}; as of ${String(h.as_of).slice(0, 10)}${h.last ? `, latest inspection ${h.last}` : ''})`);
            const last = rec.inspections[0];
            if (last) lines.push(`NYC Health inspection ${last.date}: ${last.grade ? `grade ${last.grade}, ` : ''}${last.score != null ? `score ${last.score}, ` : ''}${last.violations.length} violation${last.violations.length === 1 ? '' : 's'} (${last.violations.filter((v) => v.critical).length} critical)`);
        }
        if (live) for (const r of Object.values(await seenBySite(e.id))) lines.push(`${r.name}: ${r.value} out of ${r.best}${r.count != null ? ` from ${r.count} ratings` : ''} (seen ${r.seen_at.slice(0, 10)})`);
        const doc = hooks.buildIndexDocument({
            owner: 'reviews', type: 'entity', id: e.id, revision: 0,
            state: e.state === 'deleted' ? 'deleted' : 'published', visibility: 'public',
            deleted: !live || !decision || !decision.listable,
            canonicalUrl: entityUrl(e), title: e.name,
            summary: rev ? (rev.content || '').slice(0, 1000) || null : (e.description || null),
            body: [rev ? summaryText(rev) : '', ...lines].join('\n'),
            facets: { kind: e.kind, has_aggregate: !!(agg && agg.result), sources: [...new Set(signals.map((s) => s.source_key))].slice(0, 50) },
            authorship: rev && rev.meta && rev.meta.authorship ? rev.meta.authorship : null,
            provenance: signals.slice(0, 40).map((s) => ({ service: 'sources', type: 'item', id: s.source_item_id, url: s.canonical_url || undefined, retrievedAt: s.observed_at })),
            decision,
            publishedAt: e.created_at, updatedAt: e.updated_at,
        });
        return await publication.index(db, { document: doc, page: entityPath(e) });
    }

    async function touchEntity(entityId) {
        await db.prepare('UPDATE review_entities SET updated_at = ? WHERE id = ?').run(now(), entityId);
    }

    // Inside batch() (a sync page, an alias that settles many items) the aggregate of each touched
    // entity is recomputed once at the end: one editorial action or one Sources page → at most one
    // new aggregate revision per entity.
    // Per batch (AsyncLocalStorage): concurrent requests each keep their own dirty set, and a batch inside a batch
    // leaves the flush to the outermost one.
    const batchScope = new AsyncLocalStorage();
    async function flushEntity(canon, trigger) {
        await refreshAggregate(canon, trigger);
        await touchEntity(canon);
        await syncEntity(canon);
    }
    async function batch(fn) {
        if (batchScope.getStore()) return await fn();
        const dirty = new Map();
        return await tx(async () => {
            const out = await batchScope.run(dirty, fn);
            for (const [canon, trigger] of dirty) await flushEntity(canon, trigger);
            return out;
        });
    }

    /** After signals of an entity changed: next aggregate revision, Search document. */
    async function afterSignalChange(entityId, trigger) {
        const canon = await canonicalOf(entityId);
        if (!canon) return;
        const dirty = batchScope.getStore();
        if (dirty) { if (!dirty.has(canon)) dirty.set(canon, trigger); return; }
        await flushEntity(canon, trigger);
    }

    // ── Events ───────────────────────────────────────────────
    async function signalPayload(s) {
        const p = {
            signal_id: s.id, entity_id: s.entity_id, canonical_entity_id: await canonicalOf(s.entity_id), type: s.type,
            source_key: s.source_key, source_item_id: s.source_item_id, item_revision: s.item_revision,
            observed_at: s.observed_at, source_published_at: s.source_published_at, canonical_url: s.canonical_url, license_note: s.license_note,
        };
        if (s.type === 'recommendation') p.recommended = s.recommended === 1;
        if (s.type === 'recommendation_tally') { p.positive_count = s.positive_count; p.total_count = s.total_count; }
        if (s.type === 'rating' || s.type === 'rating_aggregate') { p.rating_value = s.rating_value; p.rating_best = s.rating_best; p.rating_worst = s.rating_worst; p.rating_count = s.rating_count; }
        return p;
    }
    async function signalEvent(type, s, actor, extra = {}) {
        await emit({
            event_type: type,
            actor: hooks.subjectRef(actorId(actor)),
            subject: { type: 'signal', id: s.id },
            visibility: 'public',
            payload: { ...await signalPayload(s), ...extra },
        });
    }
    async function entityEvent(type, e, actor, payload) {
        await emit({ event_type: type, actor: hooks.subjectRef(actorId(actor)), subject: { type: 'entity', id: e.id }, visibility: 'public', payload });
    }

    // ── Summary flags when cited signals leave ───────────────
    /**
     * A summary whose current revision cites a signal that is no longer active (withdrawn by its
     * source, replaced by a newer revision of the item, or outside the entity after a split) gets a
     * flag and a pending revision: citations of replaced signals move to their replacement, points
     * left without a live citation are dropped. The pending revision is published only after an
     * editor approves it; until then the published text stays up with the flag shown next to it.
     */
    async function flagSummary(summaryId, reason, signalIds) {
        const s = await q.summaryById.get(summaryId);
        if (!s) return null;
        const canon = await canonicalOf(s.entity_id);
        const e = await q.entity.get(s.entity_id);
        if (!e || e.state !== 'active') return null;
        const headN = await revisions.headNumber(s.id);
        if (!headN) return null;
        const head = await revisions.get(s.id, headN);
        const base = s.published_revision && !(headN > s.published_revision && head.meta && head.meta.system)
            ? await revisions.get(s.id, s.published_revision) : head;
        const state = await citationState(canon, base);
        if (state.every((p) => p.cites.every((c) => c.ok))) return null;
        const members = await closure(canon);
        const carry = async (id) => {
            let sig = await q.signal.get(id);
            const seen = new Set();
            while (sig && sig.status === 'superseded' && sig.superseded_by && !seen.has(sig.id)) { seen.add(sig.id); sig = await q.signal.get(sig.superseded_by); }
            return sig && sig.status === 'active' && members.has(sig.entity_id) ? sig.id : null;
        };
        const mapPoints = (list) => Promise.all((list || []).map(async (p) => ({ text: p.text, signals: [...new Set((await Promise.all(p.signals.map(carry))).filter(Boolean))] })));
        const f = base.fields || {};
        const pros = await mapPoints(f.pros);
        const cons = await mapPoints(f.cons);
        const overviewSignals = [...new Set((await Promise.all((f.overview_signals || []).map(carry))).filter(Boolean))];
        const dropped = [...pros, ...cons].filter((p) => !p.signals.length).map((p) => p.text);
        const t = now();
        await q.flagSummary.run(String(reason).slice(0, 300), t, t, s.id);
        const { revision } = await revisions.create({
            entityId: s.id, expectedRevision: headN, content: base.content,
            fields: { pros: pros.filter((p) => p.signals.length), cons: cons.filter((p) => p.signals.length), overview_signals: overviewSignals },
            meta: { ...(base.meta && base.meta.authorship ? { authorship: base.meta.authorship } : {}), system: { reason: String(reason).slice(0, 300), signals: signalIds, base_revision: base.number, dropped_points: dropped } },
            author: 'svc:reviews', message: `Pending: ${reason}`, allowUnchanged: true,
        });
        await writeCitations(s, revision);
        await audit('svc:reviews', 'summary.flagged', s.entity_id, s.id, { reason, signals: signalIds, pending_revision: revision.number, dropped_points: dropped.length });
        await syncEntity(canon);
        return revision;
    }

    async function flagSummariesCiting(signalIds, reason) {
        const ids = new Set();
        for (const sid of signalIds) for (const r of await q.summariesCiting.all(sid)) ids.add(r.summary_id);
        for (const id of ids) await flagSummary(id, reason, signalIds);
    }

    // ── Signals ──────────────────────────────────────────────
    async function withdrawSignal(sig, reason, actor, { status = 'withdrawn', supersededBy = null } = {}) {
        const r = await q.setSignalStatus.run({ id: sig.id, status, reason: String(reason).slice(0, 500), at: now(), superseded_by: supersededBy });
        if (!r.changes) return false;
        await signalEvent('reviews.signal.removed', await q.signal.get(sig.id), actor, { status, reason: String(reason).slice(0, 500), ...(supersededBy ? { replaced_by: supersededBy } : {}) });
        return true;
    }

    /** A new signal for an item revision; the item's previous active signal is superseded. */
    async function createSignal(itemRow, entityId, sig, actor) {
        const prev = await q.activeSignalOfItem.get(itemRow.id);
        if (prev && prev.item_revision === itemRow.item_revision && prev.entity_id === entityId) return { signal: prev, created: false };
        const t = now();
        const id = `sig_${ulid(t)}`;
        if (prev) {
            const why = prev.entity_id !== entityId ? 'reattributed by an editor' : `source item revised (r${prev.item_revision} → r${itemRow.item_revision})`;
            await withdrawSignal(prev, why, actor, prev.entity_id !== entityId ? {} : { status: 'superseded', supersededBy: id });
        }
        await q.insertSignal.run({
            id, entity_id: entityId, source_item_id: itemRow.id, source_key: itemRow.source_key, item_revision: itemRow.item_revision,
            type: sig.type, recommended: sig.recommended == null ? null : sig.recommended,
            positive_count: sig.positive_count == null ? null : sig.positive_count, total_count: sig.total_count == null ? null : sig.total_count,
            rating_value: sig.rating_value == null ? null : sig.rating_value, rating_best: sig.rating_best == null ? null : sig.rating_best,
            rating_worst: sig.rating_worst == null ? null : sig.rating_worst, rating_count: sig.rating_count == null ? null : sig.rating_count,
            observed_at: itemRow.retrieved_at, source_published_at: itemRow.published_at, canonical_url: itemRow.canonical_url,
            license_note: itemRow.license_note, trust: JSON.stringify(sig.trust || {}), created_by: actorId(actor), now: t,
        });
        const signal = await q.signal.get(id);
        await signalEvent('reviews.signal.added', signal, actor, prev ? { replaces: prev.id } : {});
        if (prev) {
            await flagSummariesCiting([prev.id], prev.entity_id !== entityId ? 'A cited signal was reattributed to another entity' : 'A cited signal was replaced by a newer revision of its source item');
            if (await canonicalOf(prev.entity_id) !== await canonicalOf(entityId)) await afterSignalChange(prev.entity_id, 'signal_reattributed');
        }
        await afterSignalChange(entityId, prev ? 'signal_replaced' : 'signal_added');
        return { signal, created: true, replaced: prev ? prev.id : null };
    }

    // ── Resolution ───────────────────────────────────────────
    /**
     * Deterministic rules, strongest first: a source binding (every item of that source is about one
     * entity), the item's canonical URL, then GTIN / SKU / MPN. One entity (after following merges)
     * → resolved. Strong identifiers naming different entities → ambiguous. No strong match: names
     * give candidates, and a name is never enough on its own → ambiguous (an editor confirms).
     * Nothing → unmatched (an editor creates or picks the entity).
     */
    async function resolveIdentifiers({ strong = [], names = [] }) {
        const hits = [];
        for (const id of strong) {
            const n = norm.tryAlias(id.type, id.value);
            if (!n) continue;
            const a = await q.strongAlias.get(id.type, n);
            if (a) {
                const e = await q.entity.get(a.entity_id);
                if (e && e.state !== 'deleted') hits.push({ rule: id.type, alias_id: a.id, entity_id: a.entity_id, canonical: await canonicalOf(a.entity_id) });
            }
        }
        const canon = [...new Set(hits.map((h) => h.canonical))];
        if (canon.length === 1) return { resolution: 'resolved', entity_id: hits[0].entity_id, rule: hits.map((h) => h.rule).join('+'), candidates: [] };
        if (canon.length > 1) return { resolution: 'ambiguous', entity_id: null, rule: 'conflicting_identifiers', candidates: hits.map((h) => ({ entity_id: h.canonical, rule: h.rule })) };
        const named = [];
        for (const name of names) {
            const n = norm.tryAlias('name', name);
            if (!n) continue;
            for (const a of await q.nameAliases.all(n)) {
                const c = await canonicalOf(a.entity_id);
                const e = c && await q.entity.get(c);
                if (e && e.state === 'active' && !named.some((x) => x.entity_id === c)) named.push({ entity_id: c, rule: 'name' });
            }
        }
        if (named.length) return { resolution: 'ambiguous', entity_id: null, rule: 'name_only', candidates: named };
        return { resolution: 'unmatched', entity_id: null, rule: null, candidates: [] };
    }

    function itemIdentifiers(row) {
        return extract.identifiers({ source_key: row.source_key, canonical_url: row.canonical_url, kind: row.kind, title: row.title, fields: parse(row.fields, {}) });
    }

    async function setItemResolution(row, r, by) {
        await q.setResolution.run({ id: row.id, resolution: r.resolution, entity_id: r.entity_id, rule: r.rule, candidates: JSON.stringify(r.candidates || []), by, at: r.resolution === 'resolved' ? now() : null, now: now() });
        return await q.item.get(row.id);
    }

    /** Create/replace/withdraw the item's signal to match its current content and resolution. */
    async function reconcileItemSignal(row, actor) {
        const active = await q.activeSignalOfItem.get(row.id);
        if (row.state !== 'active' || row.resolution !== 'resolved') {
            if (active) {
                await withdrawSignal(active, row.state !== 'active' ? `removed by its source: ${row.removed_reason || 'no reason given'}` : 'the item is no longer attributed to this entity', actor);
                await flagSummariesCiting([active.id], row.state !== 'active' ? 'A cited signal was withdrawn: its source removed the item' : 'A cited signal was withdrawn');
                await afterSignalChange(active.entity_id, 'signal_withdrawn');
            }
            return { signal: null };
        }
        const { signal } = extract.extractSignal({ kind: row.kind, fields: parse(row.fields, {}) });
        if (!signal) {
            if (active) {
                await withdrawSignal(active, `the source no longer states a signal (${row.signal_note || 'no value'})`, actor);
                await flagSummariesCiting([active.id], 'A cited signal was withdrawn: its source no longer states it');
                await afterSignalChange(active.entity_id, 'signal_withdrawn');
            }
            return { signal: null };
        }
        return await createSignal(row, row.entity_id, signal, actor);
    }

    async function upsertSource(key, prov, info) {
        const t = now();
        const existing = await q.source.get(key);
        const values = {
            key, name: info && info.name ? String(info.name).slice(0, 300) : null,
            homepage_url: info && info.homepage_url ? String(info.homepage_url).slice(0, 1000) : null,
            category: info && info.category ? String(info.category) : null,
            license_note: (prov && prov.license_note) || (info && info.license_note) || (existing && existing.license_note) || null,
            terms_note: (prov && prov.terms_note) || (info && info.terms_note) || (existing && existing.terms_note) || null,
            status: info && info.status ? String(info.status) : null,
            stale: info && typeof info.stale === 'boolean' ? (info.stale ? 1 : 0) : null,
            last_success_at: info && info.last_success_at ? String(info.last_success_at) : null,
            now: t,
        };
        if (existing) await q.updateSource.run(values); else await q.insertSource.run(values);
        return await q.source.get(key);
    }

    function checkItem(item) {
        if (!item || typeof item !== 'object') fail(422, 'signal.invalid_item', 'not a sources.item@1 object');
        if (!ITEM_RE.test(String(item.id || ''))) fail(422, 'signal.invalid_item', 'item.id must be itm_<ULID>');
        if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(String(item.source_key || ''))) fail(422, 'signal.invalid_item', 'item.source_key is missing');
        if (!Number.isInteger(item.revision) || item.revision < 1) fail(422, 'signal.invalid_item', 'item.revision is missing');
        const p = item.provenance;
        if (!p || typeof p !== 'object' || !p.retrieved_at || Number.isNaN(Date.parse(p.retrieved_at)) || !/^[0-9a-f]{64}$/.test(String(p.content_hash || ''))) {
            fail(422, 'signal.no_provenance', 'An item without provenance (retrieved_at, content_hash) cannot become a signal');
        }
    }

    // ── Official records ─────────────────────────────────────
    // What a public body published about an entity (migrations/0007, 0008): the CFPB complaint database's count for a
    // company, NYC Health's inspection results for a restaurant, NYC HPD's open housing-code violations for an apartment
    // building. They find their entity by an external alias (cfpb:<company>, nyc-camis:<camis>, nyc-hpd:<building>),
    // else by its name (and place), else add it: every NYC restaurant inspected, the companies with
    // RECORD_MIN_COMPLAINTS or more complaints, the buildings with RECORD_MIN_HAZARDOUS or more open class C
    // violations (a landlord entity named by its address). Never signals, never in the aggregate.
    const RECORD_KINDS = new Set(['complaint_tally', 'inspection_violation', 'housing_violation_tally']);
    const RECORD_MIN_COMPLAINTS = 500;
    const RECORD_MIN_HAZARDOUS = 10;
    const BOROUGHS = { manhattan: 'Manhattan', brooklyn: 'Brooklyn', queens: 'Queens', bronx: 'Bronx', 'staten island': 'Staten Island' };
    function recordTarget(item) {
        const f = item.fields || {};
        if (item.kind === 'complaint_tally') {
            const company = String(f.company || item.identity || '').trim();
            if (!company) return null;
            return { alias: `cfpb:${company.slice(0, 200)}`, name: recordName(company), kind: 'organization', place: null, create: Number(f.complaints) >= RECORD_MIN_COMPLAINTS };
        }
        if (item.kind === 'housing_violation_tally') {
            const building = String(f.buildingid || item.identity || '').trim();
            const number = String(f.housenumber || '').trim();
            const street = recordName(String(f.streetname || '').trim());
            if (!/^\d{1,12}$/.test(building) || !number || !street) return null;
            const boro = BOROUGHS[String(f.boro || '').trim().toLowerCase()] || 'New York';
            return { alias: `nyc-hpd:${building}`, name: `${number} ${street}`.slice(0, 200), kind: 'landlord', place: `${boro}, NY`, create: Number(f.c) >= RECORD_MIN_HAZARDOUS };
        }
        const camis = String(f.camis || '').trim();
        if (!/^\d{1,12}$/.test(camis) || !f.dba) return null;
        const boro = BOROUGHS[String(f.boro || '').trim().toLowerCase()];
        // The street address is part of the place: a chain has many restaurants of one name in one borough.
        const street = [String(f.building || '').trim(), recordName(String(f.street || '').trim())].filter(Boolean).join(' ');
        return { alias: `nyc-camis:${camis}`, name: recordName(f.dba), kind: 'restaurant', place: `${street ? `${street}, ` : ''}${boro || 'New York'}, NY`.slice(0, 120), create: true };
    }
    async function recordEntity(target, actor) {
        const norm1 = norm.alias('external', target.alias);
        const hit = await q.externalAlias.get(norm1);
        if (hit) return await canonicalOf(hit.entity_id);
        const kinds = target.kind === 'organization' ? ['organization', 'employer', 'business', 'service'] : [target.kind];
        // A same-named entity takes the record only when no record of the same register is on it already: two NYC
        // restaurants (or two CFPB companies) are never one entity.
        const scheme = `${target.alias.slice(0, target.alias.indexOf(':') + 1)}%`;
        for (const k of kinds) {
            const same = [];
            for (const x of await q.sameNamedOfKind.all(norm.alias('name', target.name), k)) {
                if (LOCAL_KINDS.has(k) && String(x.description || '').toLowerCase() !== String(target.place || '').toLowerCase()) continue;
                if (await q.externalOfScheme.get(x.id, scheme)) continue;
                same.push(x);
            }
            if (same.length) { const id = await canonicalOf(same[0].id); await insertAlias(id, 'external', target.alias, actor); return id; }
        }
        if (!target.create) return null;
        const t = now();
        const id = `ent_${ulid(t)}`;
        const slug = await uniqueSlug(LOCAL_KINDS.has(target.kind) && target.place ? `${target.name} ${target.place}` : target.name);
        await redirects.release(`/e/${slug}`);
        await q.insertEntity.run({ id, slug, name: target.name, kind: target.kind, description: target.place, created_by: 'service:reviews', now: t });
        await insertAlias(id, 'name', target.name, actor);
        await insertAlias(id, 'external', target.alias, actor);
        await audit(actor, 'entity.added_from_records', id, null, { name: target.name, kind: target.kind, place: target.place, alias: target.alias });
        return id;
    }
    const dayOf = (v) => { const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v || '')); return m ? m[1] : null; };
    /** One official-record item → its record row (created, replaced, or removed with its item). */
    async function applyRecord(item, { sourceInfo, actor }) {
        const prov = item.provenance;
        return await tx(async () => {
            await upsertSource(item.source_key, prov, sourceInfo);
            const row = await q.recordByItem.get(item.id);
            const t = now();
            if (item.removed) {
                if (!row || row.status === 'removed') return { outcome: row ? 'unchanged' : 'removed:unknown', item: null, signal: null };
                await q.removeRecord.run(t, row.id);
                await afterSignalChange(row.entity_id, 'record_removed');
                return { outcome: 'removed', item: null, signal: null };
            }
            if (row && item.revision <= Number(row.item_revision)) return { outcome: 'unchanged', item: null, signal: null };
            const target = recordTarget(item);
            const entityId = target ? await recordEntity(target, actor) : null;
            if (!entityId) return { outcome: 'unchanged', item: null, signal: null };
            const f = item.fields || {};
            const count = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
            const keep = item.kind === 'complaint_tally'
                ? { company: String(f.company || item.identity).slice(0, 200), complaints: count(f.complaints) }
                : item.kind === 'housing_violation_tally'
                ? { buildingid: String(f.buildingid || item.identity).slice(0, 12), boro: f.boro == null ? null : String(f.boro).slice(0, 40), housenumber: f.housenumber == null ? null : String(f.housenumber).slice(0, 20),
                    streetname: f.streetname == null ? null : String(f.streetname).slice(0, 120), zip: f.zip == null ? null : String(f.zip).slice(0, 10), open: count(f.open), c: count(f.c), b: count(f.b), a: count(f.a) }
                : Object.fromEntries(['camis', 'dba', 'boro', 'building', 'street', 'zipcode', 'cuisine', 'inspection_type', 'action', 'violation_code', 'violation', 'critical_flag', 'score', 'grade']
                    .map((k) => [k, f[k] == null ? null : String(f[k]).slice(0, 500)]));
            const values = {
                entity_id: entityId, occurred_on: item.kind === 'inspection_violation' ? dayOf(f.inspection_date) : item.kind === 'housing_violation_tally' ? dayOf(f.last) : null, fields: JSON.stringify(keep),
                item_revision: item.revision, retrieved_at: new Date(prov.retrieved_at).toISOString(), now: t,
            };
            if (row) await q.updateRecord.run({ ...values, id: row.id });
            else await q.insertRecord.run({ ...values, id: `rec_${ulid(t)}`, source_key: item.source_key, source_item_id: item.id, kind: item.kind });
            await afterSignalChange(entityId, 'record');
            return { outcome: row ? 'updated' : 'created', item: null, signal: null };
        });
    }

    /** An entity's official records, for its page: the CFPB count, HPD's open violations, NYC inspections by day (newest first). */
    /**
     * What an entity's official records add to the index gate: the words of their specific lines (each inspection's
     * date, grade, score and violations; the complaint count; the housing counts by class), never the page's fixed
     * captions and caveats, and one source per public body. Only summaries and members' reviews counted before, so
     * 1,155 NYC restaurant pages with their inspections were in no sitemap and no network search (2026-10-18). A page
     * whose records are a bare count (a CFPB tally, an HPD building) stays under the gate's word floor.
     */
    function recordSubstance(rec) {
        const lines = [];
        if (rec.complaints) lines.push(`CFPB complaints ${rec.complaints.count}`);
        if (rec.housing) lines.push(`HPD open violations ${rec.housing.open}: class C ${rec.housing.c}, class B ${rec.housing.b}, class A ${rec.housing.a}${rec.housing.last ? `; inspected ${rec.housing.last}` : ''}`);
        for (const i of rec.inspections) lines.push([i.date, i.grade && `grade ${i.grade}`, i.score != null && `score ${i.score}`, ...i.violations.map((v) => v.text)].filter(Boolean).join(' '));
        return { words: lines.length ? ssr.wordCount(lines.join('\n')) : 0, sources: (rec.complaints ? 1 : 0) + (rec.housing ? 1 : 0) + (rec.inspections.length ? 1 : 0) };
    }

    async function recordsView(entityId) {
        const rows = await q.recordsOf.all([...await closure(entityId)]);
        const out = { complaints: null, housing: null, inspections: [], restaurant: null };
        const byDay = new Map();
        for (const r of rows) {
            const f = r.fields && typeof r.fields === 'object' ? r.fields : parse(r.fields, {});
            if (r.kind === 'complaint_tally') {
                if (!out.complaints || Number(f.complaints) > out.complaints.count) {
                    out.complaints = { company: f.company, count: Number(f.complaints), as_of: r.retrieved_at,
                        url: `https://www.consumerfinance.gov/data-research/consumer-complaints/search/?company=${encodeURIComponent(f.company)}&dateRange=All&searchField=all&tab=Map` };
                }
                continue;
            }
            if (r.kind === 'housing_violation_tally') {
                if (!out.housing || Number(f.c) > out.housing.c) {
                    out.housing = { building: f.buildingid, address: [f.housenumber, f.streetname && recordName(String(f.streetname))].filter(Boolean).join(' ') || null, boro: f.boro, zip: f.zip,
                        open: f.open, c: f.c, b: f.b, a: f.a, last: r.occurred_on, as_of: r.retrieved_at, url: `https://hpdonline.nyc.gov/hpdonline/building/${encodeURIComponent(f.buildingid)}` };
                }
                continue;
            }
            if (!out.restaurant) out.restaurant = { camis: f.camis, address: [f.building, f.street && recordName(String(f.street))].filter(Boolean).join(' ') || null, boro: f.boro, zipcode: f.zipcode, cuisine: f.cuisine };
            const day = r.occurred_on || 'unknown';
            if (!byDay.has(day)) byDay.set(day, { date: r.occurred_on, type: f.inspection_type, action: f.action, score: null, grade: null, violations: [] });
            const d = byDay.get(day);
            if (f.score != null && f.score !== '' && d.score == null) d.score = Number(f.score);
            if (f.grade && !d.grade) d.grade = f.grade;
            if (f.violation_code && !d.violations.some((v) => v.code === f.violation_code)) d.violations.push({ code: f.violation_code, text: f.violation, critical: f.critical_flag === 'Critical' });
        }
        out.inspections = [...byDay.values()].slice(0, 8);
        return out;
    }

    /**
     * Apply one Sources item (sources.item@1). Idempotent: the same item revision twice changes
     * nothing but the last-seen time. Synchronous (runs inside the caller's transaction).
     * → { outcome, item, signal }
     */
    async function applyItem(item, { sourceInfo = null, actor = { kind: 'system', service: 'svc:reviews' } } = {}) {
        checkItem(item);
        if (item.category && item.category !== 'reviews') return { outcome: 'ignored:category', item: null, signal: null };
        if (RECORD_KINDS.has(item.kind)) return await applyRecord(item, { sourceInfo, actor });
        const prov = item.provenance;
        const t = now();
        return await tx(async () => {
            await upsertSource(item.source_key, prov, sourceInfo);
            let row = await q.item.get(item.id);
            const retrievedAt = new Date(prov.retrieved_at).toISOString();
            if (item.removed) {
                const reason = String((item.removed && item.removed.reason) || 'removed').slice(0, 500);
                if (!row) {
                    // Known only as removed: kept for the record, never a signal.
                    const fields = extract.keptFields(item);
                    await q.insertItem.run({
                        id: item.id, source_key: item.source_key, kind: String(item.kind || 'unknown').slice(0, 40), identity: String(item.identity || item.id).slice(0, 2048),
                        canonical_url: item.canonical_url || null, title: extract.keptTitle(item), item_revision: item.revision, content_hash: prov.content_hash,
                        published_at: item.published_at || null, retrieved_at: retrievedAt, parser_version: prov.parser_version || null,
                        license_note: prov.license_note || null, terms_note: prov.terms_note || null, fields: JSON.stringify(fields),
                        state: 'removed', removed_at: item.removed.at || retrievedAt, removed_reason: reason, resolution: 'unmatched', entity_id: null,
                        resolution_rule: null, candidates: '[]', resolved_by: null, resolved_at: null, signal_note: 'removed by its source before Reviews read it', now: t,
                    });
                    return { outcome: 'removed:unknown', item: await q.item.get(item.id), signal: null };
                }
                if (row.state === 'removed') return { outcome: 'unchanged', item: row, signal: null };
                await q.removeItem.run(item.removed.at || retrievedAt, reason, t, row.id);
                row = await q.item.get(row.id);
                await reconcileItemSignal(row, actor);
                return { outcome: 'removed', item: row, signal: null };
            }
            if (row && row.state === 'removed') return { outcome: 'ignored:removed', item: row, signal: null };
            if (row && item.revision < row.item_revision) return { outcome: 'ignored:older_revision', item: row, signal: null };
            if (row && item.revision === row.item_revision && row.content_hash === prov.content_hash) {
                await q.touchItem.run(retrievedAt, t, row.id, retrievedAt);
                return { outcome: 'unchanged', item: await q.item.get(row.id), signal: await q.activeSignalOfItem.get(row.id) || null };
            }
            const fields = extract.keptFields(item);
            const { note } = extract.extractSignal(item);
            const values = {
                id: item.id, source_key: item.source_key, kind: String(item.kind || 'unknown').slice(0, 40), identity: String(item.identity || item.id).slice(0, 2048),
                canonical_url: item.canonical_url || null, title: extract.keptTitle(item), item_revision: item.revision, content_hash: prov.content_hash,
                published_at: item.published_at || null, retrieved_at: retrievedAt, parser_version: prov.parser_version || null,
                license_note: prov.license_note || null, terms_note: prov.terms_note || null, fields: JSON.stringify(fields), signal_note: note, now: t,
            };
            let outcome;
            if (!row) {
                await q.insertItem.run({ ...values, state: 'active', removed_at: null, removed_reason: null, resolution: 'unmatched', entity_id: null, resolution_rule: null, candidates: '[]', resolved_by: null, resolved_at: null });
                outcome = 'created';
            } else {
                await q.updateItemContent.run(values);
                outcome = 'updated';
            }
            row = await q.item.get(item.id);
            if (row.resolution === 'unmatched' || row.resolution === 'ambiguous') row = await setItemResolution(row, await resolveIdentifiers(itemIdentifiers(row)), 'rule');
            const out = await reconcileItemSignal(row, actor);
            return { outcome, item: await q.item.get(item.id), signal: out.signal || null };
        });
    }

    /** New aliases may settle items that waited: re-run the rules for every unresolved item. */
    async function reresolvePending(actor) {
        return await batch(async () => {
            let settled = 0;
            for (const row of await q.unresolvedItems.all()) {
                const r = await resolveIdentifiers(itemIdentifiers(row));
                if (r.resolution === row.resolution && JSON.stringify(r.candidates) === row.candidates) continue;
                const fresh = await setItemResolution(row, r, 'rule');
                if (fresh.resolution === 'resolved') { await reconcileItemSignal(fresh, actor); settled++; }
            }
            return settled;
        });
    }

    // ── Entities ─────────────────────────────────────────────
    async function uniqueSlug(base) {
        const root = norm.slug(base) || 'entity';
        let s = root;
        for (let i = 2; await q.entityBySlug.get(s) || await redirects.resolve(`/e/${s}`, { currentPath: () => null }); i++) s = `${root}-${i}`.slice(0, 90);
        return s;
    }

    function checkName(name) {
        const t = String(name == null ? '' : name).replace(/\s+/g, ' ').trim();
        if (!t) fail(422, 'entity.invalid_name', 'An entity needs a name');
        if (t.length > 200) fail(422, 'entity.invalid_name', 'A name is at most 200 characters');
        norm.alias('name', t);
        return t;
    }

    async function insertAlias(entityId, type, value, actor) {
        if (!ALIAS_TYPES.includes(type)) fail(422, 'alias.invalid', `alias type is one of ${ALIAS_TYPES.join(', ')}`);
        let n;
        try { n = norm.alias(type, value); } catch (err) { fail(422, 'alias.invalid', err.message); }
        if (type !== 'name') {
            const taken = await q.strongAlias.get(type, n);
            if (taken) {
                if (taken.entity_id === entityId) return taken;
                const other = await q.entity.get(taken.entity_id);
                fail(409, 'alias.taken', `${type} ${value} already identifies "${other ? other.name : taken.entity_id}"`, { entity_id: taken.entity_id });
            }
        } else if ((await q.nameAliases.all(n)).some((a) => a.entity_id === entityId)) {
            return (await q.nameAliases.all(n)).find((a) => a.entity_id === entityId);
        }
        const t = now();
        const id = `als_${ulid(t)}`;
        await q.insertAlias.run({ id, entity_id: entityId, type, value: String(value).trim().slice(0, 1000), norm: n, by: actorId(actor), now: t });
        return await q.alias.get(id);
    }

    async function entityView(e) {
        return {
            id: e.id, slug: e.slug, name: e.name, kind: e.kind, description: e.description, state: e.state,
            merged_into: e.merged_into, canonical_id: await canonicalOf(e.id), noindex: !!e.noindex,
            url: entityUrl(e), created_at: toIso(e.created_at), updated_at: toIso(e.updated_at),
        };
    }

    async function trustMap(scope, id) {
        const out = {};
        for (const r of await q.trustCurrent.all(scope, id)) out[r.key] = { value: r.value, note: r.note, set_at: toIso(r.set_at) };
        return out;
    }

    async function signalView(s) {
        const item = await q.item.get(s.source_item_id);
        const src = await q.source.get(s.source_key);
        return {
            ...await signalPayload(s), status: s.status, status_reason: s.status_reason, status_at: toIso(s.status_at), superseded_by: s.superseded_by,
            trust: parse(s.trust, {}), editor_trust: await trustMap('signal', s.id), created_at: toIso(s.created_at),
            provenance: {
                source_key: s.source_key, source_name: src ? src.name : null, source_homepage: src ? src.homepage_url : null,
                source_item_id: s.source_item_id, item_revision: s.item_revision, item_kind: item ? item.kind : null,
                retrieved_at: s.observed_at, last_seen_at: item ? item.retrieved_at : null,
                canonical_url: s.canonical_url, license_note: s.license_note, terms_note: item ? item.terms_note : (src ? src.terms_note : null),
                item_state: item ? item.state : null, item_removed_reason: item ? item.removed_reason : null,
            },
        };
    }

    /** `editor: false` (a reader): the person who wrote it is "an editor", as in the editorial log. */
    async function summaryRevisionView(summary, rev, canonicalId, { editor = true } = {}) {
        if (!rev) return null;
        const rec = rev.meta && rev.meta.authorship;
        const review = await reviews.latest(summary.id, rev.number);
        return {
            number: rev.number, status: await revisionStatus(summary, rev), overview: rev.content,
            points: (await citationState(canonicalId, rev)).map((p) => ({ key: p.key, kind: p.kind, text: p.kind === 'overview' ? null : p.text, supported: p.supported, citations: p.cites })),
            authorship: rec ? { mode: rec.mode, workflow: rec.workflow || null, stub_provider: !!rec.stubProvider } : null,
            disclosure: rec ? authorship.disclosure(rec, review) : null,
            review: review ? { decision: review.decision, reviewed_at: review.reviewedAt } : null,
            system: rev.meta && rev.meta.system ? rev.meta.system : null,
            correction: correctionView(rev),
            author: editor || !/^usr_/.test(String(rev.author)) ? rev.author : 'an editor', message: rev.message, created_at: rev.createdAt,
        };
    }

    /** The public side of a correction: the note, which revision it corrects, and whether a reader asked for it. */
    function correctionView(rev) {
        const c = rev && rev.meta && rev.meta.correction;
        return c ? { note: c.note, corrects: c.corrects, requested: !!c.request } : null;
    }

    /** The summary's history as readers may see it, newest first (entity page). */
    async function publicHistory(summary) {
        if (!summary) return [];
        const listed = await revisions.list(summary.id, { limit: 200 });
        const shown = await Promise.all(listed.map(async (r) => await publicRevision(summary, r)));
        return (await Promise.all(listed.filter((r, i) => shown[i]).map(async (r) => {
            const d = r.meta && r.meta.authorship ? authorship.disclosure(r.meta.authorship, await reviews.latest(summary.id, r.number)) : null;
            return { number: r.number, status: await revisionStatus(summary, r), created_at: r.createdAt, disclosure: d ? d.short : null, correction: correctionView(r) };
        })));
    }

    // Audit detail readers never see: which correction request it was, what it said, how editors resolved it.
    function auditDetail(r, editor) {
        const d = parse(r.detail, {});
        if (editor) return d;
        if (/^correction\./.test(r.action)) return {};
        const { correction_id: _hidden, ...rest } = d;
        return rest;
    }

    // ── Public API ───────────────────────────────────────────
    const svc = {
        access, ReviewsError, entityPath, entityUrl, canonicalOf, closure,
        ENTITY_KINDS, ALIAS_TYPES, LINK_TYPES, TRUST_KEYS, SUMMARY_WORKFLOW,

        // Lookups ----------------------------------------------------------------------------
        async findEntity(ref) { const s = String(ref || ''); return (ENTITY_ID_RE.test(s) ? await q.entity.get(s) : await q.entityBySlug.get(s)) || null; },
        async entity(ref) { return await entityOrFail(ref); },
        async entityById(id) { return await q.entity.get(id) || null; },
        async resolveRedirect(path) {
            return await redirects.resolve(path, { currentPath: async (id) => { const e = await q.entity.get(id); return e && e.state !== 'deleted' ? entityPath(e) : null; } });
        },
        async listEntities({ limit = 50, offset = 0 } = {}) { return { entities: await q.listActive.all(Math.min(200, limit), Math.max(0, offset)), total: (await q.countActive.get()).n }; },
        async search(text, { limit = 30 } = {}) {
            const s = String(text || '').trim().slice(0, 200);
            if (!s) return [];
            const esc = (x) => x.replace(/[\\%_]/g, (c) => `\\${c}`);
            const n = norm.tryAlias('name', s) || s.toLowerCase();
            return await q.searchEntities.all({ like: `%${esc(s)}%`, nlike: `%${esc(n)}%`, limit: Math.min(100, limit) });
        },
        entityView,
        signalView,
        aggregateView,
        decide,
        gateFacts,

        /** Everything the entity page shows. `e` must be active (callers redirect merged entities). */
        async page(e, actor) {
            const members = await closure(e.id);
            const signals = await allSignalsIn(members);
            const active = signals.filter((s) => s.status === 'active');
            const agg = aggregateView(await q.lastAggregate.get(e.id));
            const summary = await q.summary.get(e.id) || null;
            const pub = summary && summary.state === 'published' && summary.published_revision ? await revisions.get(summary.id, summary.published_revision) : null;
            const sourceKeys = [...new Set(signals.map((s) => s.source_key))].sort();
            const editor = access.isEditor(actor);
            return {
                entity: await entityView(e),
                aliases: (await q.aliasesOf.all(e.id)).map((a) => ({ id: a.id, type: a.type, value: a.value })),
                merged_from: (await Promise.all([...members].filter((id) => id !== e.id).map(async (id) => await entityView(await q.entity.get(id))))),
                links: (await Promise.all([...await q.linksFrom.all(e.id), ...await q.linksTo.all(e.id)].map(async (l) => ({
                    id: l.id, type: l.type, from: l.from_entity, to: l.to_entity, ref: parse(l.ref, null), note: l.note,
                    other: l.to_entity ? await entityView(await q.entity.get(l.from_entity === e.id ? l.to_entity : l.from_entity)) : null,
                    direction: l.from_entity === e.id ? 'out' : 'in', created_at: toIso(l.created_at),
                })))),
                aggregate: agg && agg.result ? agg : null,
                aggregate_revision: agg ? agg.revision : null,
                signals: (await Promise.all(active.map(signalView))),
                inactive_signals: (await Promise.all(signals.filter((s) => s.status !== 'active').map(signalView))),
                sources: (await Promise.all(sourceKeys.map(async (k) => { const r = await q.source.get(k); return { key: k, name: r && r.name, homepage_url: r && r.homepage_url, license_note: r && r.license_note, terms_note: r && r.terms_note, status: r && r.status, stale: r ? r.stale === 1 : null, last_success_at: r && r.last_success_at, trust: await trustMap('source', k) }; }))),
                entity_trust: await trustMap('entity', e.id),
                summary: summary ? {
                    id: summary.id, state: summary.state, head_revision: await revisions.headNumber(summary.id), flagged: !!summary.flagged, flag_reason: summary.flag_reason, flagged_at: toIso(summary.flagged_at),
                    published_at: toIso(summary.published_at), revision_published_at: toIso(summary.revision_published_at),
                    published: pub ? await summaryRevisionView(summary, pub, e.id, { editor }) : null,
                    pending: editor ? (await Promise.all((await pendingRevisions(summary)).map(async (p) => await summaryRevisionView(summary, p.rev, e.id)))) : (await pendingRevisions(summary)).length,
                    history: await publicHistory(summary),
                } : null,
                open_corrections: (await q.openCorrectionsOf.get(e.id)).n,
                decision: await decide(e),
                editor,
            };
        },

        async history(e, actor) {
            const editor = access.isEditor(actor);
            if (e.state === 'deleted' && !editor) fail(410, 'entity.deleted', 'This entity was deleted');
            const summary = await q.summary.get(e.id);
            const revs = summary ? await revisions.list(summary.id, { limit: 200 }) : [];
            return {
                entity: await entityView(e),
                aggregates: (await q.aggregates.all(e.id, 200)).map(aggregateView),
                summary_revisions: summary ? (await Promise.all((await Promise.all(revs.map(async (r) => ((editor || await publicRevision(summary, r)) ? r : null)))).filter(Boolean)
                    .map(async (r) => await summaryRevisionView(summary, r, e.id, { editor })))) : [],
                merges: (await Promise.all((await q.mergeLinksOf.all(e.id, e.id)).map(async (l) => ({
                    id: l.id, from: await entityView(await q.entity.get(l.from_entity)), to: await entityView(await q.entity.get(l.to_entity)), note: l.note,
                    merged_at: toIso(l.created_at), merged_by: editor ? l.created_by : null, split_at: toIso(l.ended_at), split_by: editor ? l.ended_by : null, split_note: l.end_note,
                })))),
                signals: (await Promise.all((await allSignalsIn(await closure(e.id))).map(signalView))),
                audit: (await q.auditOf.all(e.id, e.id)).map((r) => ({
                    id: r.id, at: toIso(r.at), action: r.action, target: editor || !/^correction\./.test(r.action) ? r.target : null,
                    actor: editor ? r.actor : (/^usr_/.test(r.actor) ? 'an editor' : r.actor), detail: auditDetail(r, editor),
                })),
            };
        },

        async summaryRevision(e, n, actor) {
            if (e.state === 'deleted' && !access.isEditor(actor)) fail(410, 'entity.deleted', 'This entity was deleted');
            const summary = await q.summary.get(e.id);
            if (!summary) fail(404, 'summary.not_found', 'This entity has no summary');
            const rev = await revisions.get(summary.id, Number(n));
            if (!rev) fail(404, 'revision.not_found', `No revision ${n}`);
            const editor = access.isEditor(actor);
            if (!editor && !await publicRevision(summary, rev)) fail(404, 'revision.not_found', `No revision ${n}`);
            return await summaryRevisionView(summary, rev, e.id, { editor });
        },

        // Resolve (reviews.entity.resolve) ---------------------------------------------------
        /** { name?, url?, sku?, gtin?, mpn?, source?, external? } → { match, entity, via, rule, candidates } */
        async resolve(input = {}) {
            const strong = [];
            for (const t of ['source', 'external', 'url', 'gtin', 'sku', 'mpn']) if (input[t]) strong.push({ type: t, value: String(input[t]) });
            const names = input.name ? [String(input.name)] : [];
            if (!strong.length && !names.length) fail(422, 'resolve.empty', 'Give at least one of name, url, gtin, sku, mpn, source, external');
            const r = await resolveIdentifiers({ strong, names });
            const canon = r.entity_id ? await canonicalOf(r.entity_id) : null;
            return {
                match: r.resolution === 'resolved' ? 'exact' : r.resolution === 'ambiguous' ? 'ambiguous' : 'none',
                entity: canon ? await entityView(await q.entity.get(canon)) : null,
                via: r.entity_id && r.entity_id !== canon ? await entityView(await q.entity.get(r.entity_id)) : null,
                rule: r.rule,
                candidates: (await Promise.all(r.candidates.map(async (c) => ({ rule: c.rule, entity: await entityView(await q.entity.get(c.entity_id)) })))),
            };
        },

        // Entities (editors) -----------------------------------------------------------------
        async createEntity({ name, kind = 'other', description = null, slug = null, aliases = [] } = {}, actor) {
            requireEditor(actor, 'Creating an entity');
            const clean = checkName(name);
            if (!ENTITY_KINDS.includes(kind)) fail(422, 'entity.invalid_kind', `kind is one of ${ENTITY_KINDS.join(', ')}`);
            if (!Array.isArray(aliases)) fail(422, 'alias.invalid', 'aliases is a list of { type, value }');
            return await tx(async () => {
                const t = now();
                const id = `ent_${ulid(t)}`;
                const s = slug ? norm.slug(slug) : null;
                if (slug && !s) fail(422, 'entity.invalid_slug', 'That slug has no letters or digits');
                if (s && (await q.entityBySlug.get(s))) fail(409, 'entity.slug_taken', `/e/${s} is taken`);
                const finalSlug = s || await uniqueSlug(clean);
                await redirects.release(`/e/${finalSlug}`);
                await q.insertEntity.run({ id, slug: finalSlug, name: clean, kind, description: description ? String(description).trim().slice(0, 2000) || null : null, created_by: actorId(actor), now: t });
                await insertAlias(id, 'name', clean, actor);
                for (const a of aliases) await insertAlias(id, a && a.type, a && a.value, actor);
                await audit(actor, 'entity.created', id, null, { name: clean, kind, aliases });
                const settled = await reresolvePending(actor);
                await syncEntity(id);
                return { entity: await q.entity.get(id), settled_items: settled };
            });
        },

        // Members' reviews ---------------------------------------------------------------------
        MEMBER_KINDS, LOCAL_KINDS,

        /** Reviews by OpenVibe members of an entity (merged ones included): their numbers, the newest first, the viewer's own. */
        async memberReviews(e, actor, { limit = 50 } = {}) {
            const ids = await closure(e.id);
            const rows = [];
            for (const id of ids) rows.push(...await q.memberReviewsOf.all(id, limit));
            rows.sort((a, b) => Number(b.created_at) - Number(a.created_at));
            const mine = actor && actor.subject ? await q.memberReviewBy.get(e.id, actor.subject) : null;
            return { stats: await memberStats(ids), reviews: rows.slice(0, limit).map((r) => memberReviewView(r, actor)), mine: mine && mine.status === 'published' ? memberReviewView(mine, actor) : null };
        },

        /**
         * What a member wants to review, found or added: { kind, name, place?, url? } → { entity, created }. The same
         * thing is found by its website, else by its name and kind (and place, for local kinds); otherwise it is added
         * with the member as its creator, and an editor can merge a duplicate later.
         */
        async memberEntity({ kind, name, place = null, url = null } = {}, actor) {
            const who = requirePerson(actor, 'Adding something to review');
            if (!MEMBER_KINDS.includes(kind)) fail(422, 'entity.invalid_kind', `kind is one of ${MEMBER_KINDS.join(', ')}`);
            const clean = checkName(name);
            const where = place ? String(place).replace(/\s+/g, ' ').trim().slice(0, 120) || null : null;
            if (LOCAL_KINDS.has(kind) && !where) fail(422, 'entity.place_required', 'Say where it is: a city, and a state or country');
            let site = null;
            if (url && String(url).trim()) {
                try {
                    const raw = String(url).trim();
                    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
                    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) throw new Error('not a web address');
                    site = `https://${u.hostname.toLowerCase().replace(/^www\./, '')}/`;
                } catch { fail(422, 'entity.invalid_url', 'The website is a web address like example.com'); }
            }
            return await tx(async () => {
                if (site) {
                    const a = await q.strongAlias.get('url', norm.alias('url', site));
                    if (a) return { entity: await q.entity.get(await canonicalOf(a.entity_id)), created: false };
                }
                const same = (await q.sameNamedOfKind.all(norm.alias('name', clean), kind))
                    .filter((x) => !LOCAL_KINDS.has(kind) || String(x.description || '').toLowerCase() === String(where || '').toLowerCase());
                if (same.length) return { entity: await q.entity.get(await canonicalOf(same[0].id)), created: false };
                const t = now();
                if ((await q.memberEntitiesSince.get(who, t - DAY_MS)).n >= MEMBER_ENTITIES_PER_DAY) fail(429, 'entity.member_limit', `You can add ${MEMBER_ENTITIES_PER_DAY} things a day`);
                const id = `ent_${ulid(t)}`;
                const slug = await uniqueSlug(LOCAL_KINDS.has(kind) ? `${clean} ${where}` : clean);
                await redirects.release(`/e/${slug}`);
                await q.insertEntity.run({ id, slug, name: clean, kind, description: where, created_by: who, now: t });
                await insertAlias(id, 'name', clean, actor);
                if (site) await insertAlias(id, 'url', site, actor);
                await audit(actor, 'entity.added_by_member', id, null, { name: clean, kind, place: where, url: site });
                await syncEntity(id);
                return { entity: await q.entity.get(id), created: true };
            });
        },

        /** Write, or rewrite, the viewer's review of an entity: { rating 1–5, title, body, relation? }. */
        async writeMemberReview(ref, { rating, title, body, relation = null } = {}, actor) {
            const who = requirePerson(actor, 'Writing a review');
            const r = Number(rating);
            if (!Number.isInteger(r) || r < 1 || r > 5) fail(422, 'review.invalid_rating', 'Pick a rating from 1 to 5 stars');
            const tt = String(title == null ? '' : title).replace(/\s+/g, ' ').trim();
            if (!tt || tt.length > 120) fail(422, 'review.invalid_title', 'Give it a title of up to 120 characters');
            const bb = String(body == null ? '' : body).replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
            if (bb.length < 30 || bb.length > 5000) fail(422, 'review.invalid_body', 'Say what it was like in 30 to 5,000 characters');
            const rel = relation ? String(relation).replace(/\s+/g, ' ').trim().slice(0, 60) || null : null;
            return await tx(async () => {
                const e = await entityOrFail(ref);
                if (e.state !== 'active') fail(409, 'entity.not_active', `This entity is ${e.state}`);
                const t = now();
                const prior = await q.memberReviewBy.get(e.id, who);
                if (!prior && (await q.memberReviewsSince.get(who, t - DAY_MS)).n >= MEMBER_REVIEWS_PER_DAY) fail(429, 'review.daily_limit', `You can write ${MEMBER_REVIEWS_PER_DAY} reviews a day`);
                const row = { rating: r, title: tt, body: bb, relation: rel, author_name: memberName(actor), now: t };
                let id;
                if (prior) { id = prior.id; await q.updateMemberReview.run({ ...row, id }); }
                else { id = `mrv_${ulid(t)}`; await q.insertMemberReview.run({ ...row, id, entity_id: e.id, author: who }); }
                await touchEntity(e.id);
                await audit(actor, prior ? 'member_review.edited' : 'member_review.written', e.id, id, { rating: r });
                await syncEntity(await canonicalOf(e.id));
                return memberReviewView(await q.memberReview.get(id), actor);
            });
        },

        /** Take a review down: its author, or an editor (with the reason, kept in the audit log). */
        async removeMemberReview(id, actor, reason = null) {
            const who = requirePerson(actor, 'Removing a review');
            return await tx(async () => {
                const r = await q.memberReview.get(String(id || ''));
                if (!r || r.status !== 'published') fail(404, 'review.not_found', 'No such review');
                const own = r.author === who;
                if (!own && !access.isEditor(actor)) fail(403, 'reviews.editor_required', 'Only its author or an editor can remove a review');
                const why = own ? 'removed by its author' : String(reason || '').trim().slice(0, 300) || 'removed by an editor';
                const t = now();
                await q.removeMemberReview.run(who, why, t, t, r.id);
                await audit(actor, 'member_review.removed', r.entity_id, r.id, { reason: why });
                await syncEntity(await canonicalOf(r.entity_id));
                return { removed: true, entity_id: r.entity_id };
            });
        },

        // Ratings other sites show, as members saw them -------------------------------------------
        SEEN_SITES, seenSiteOf,

        /** The latest look at each site for an entity (merged ones included), with how many members saw that site. */
        async seenRatings(e) { return await seenBySite(e.id); },
        async records(e) { return await recordsView(e.id); },

        /**
         * A member brings the rating a page of another site states: { site?, url, value, best, count?, via } for an
         * entity ref (or { kind, name, place?, website? } to find or add one, as /review does) → { entity, seen }. The
         * page must be on that site; one row per member, site and entity (a later look replaces theirs).
         */
        async saveSeenRating(target, { url, value, best = 5, count = null, via = 'form' } = {}, actor) {
            const who = requirePerson(actor, 'Saving a rating');
            const site = seenSiteOf(url);
            if (!site) fail(422, 'seen.invalid_page', `The page must be an https address on ${Object.values(SEEN_SITES).map((x) => x.name).join(', ')}`);
            const v = Number(value);
            const b = Number(best);
            if (!Number.isFinite(b) || b <= 0 || b > 100) fail(422, 'seen.invalid_scale', 'The scale is the best rating the site gives, like 5');
            if (!Number.isFinite(v) || v < 0 || v > b) fail(422, 'seen.invalid_value', `The rating is a number from 0 to ${b}`);
            const n = count == null || count === '' ? null : Number(String(count).replace(/[,\s]/g, ''));
            if (n != null && (!Number.isInteger(n) || n < 0 || n > 1e9)) fail(422, 'seen.invalid_count', 'How many ratings it is from is a whole number');
            const how = via === 'companion' ? 'companion' : 'form';
            const entity = typeof target === 'string' ? await entityOrFail(target) : (await svc.memberEntity({ ...target, kind: target.kind || SEEN_SITES[site].kind, url: target.website || null }, actor)).entity;
            return await tx(async () => {
                const e = await q.entity.get(await canonicalOf(entity.id));
                if (!e || e.state !== 'active') fail(409, 'entity.not_active', 'That is not reviewed here any more');
                const t = now();
                const prior = await q.seenRatingBy.get(e.id, site, who);
                if (!prior && (await q.seenRatingsSince.get(who, t - DAY_MS)).n >= SEEN_PER_DAY) fail(429, 'seen.daily_limit', `You can save ${SEEN_PER_DAY} ratings a day`);
                const row = { page_url: String(url).slice(0, 1000), rating_value: v, rating_best: b, rating_count: n, now: t, via: how };
                let id;
                if (prior) { id = prior.id; await q.updateSeenRating.run({ ...row, id }); }
                else { id = `srt_${ulid(t)}`; await q.insertSeenRating.run({ ...row, id, entity_id: e.id, site, seen_by: who }); }
                await touchEntity(e.id);
                await syncEntity(e.id);
                await audit(actor, 'seen_rating.saved', e.id, id, { site, value: v, best: b, count: n, via: how });
                return { entity: e, seen: { id, site, value: v, best: b, count: n } };
            });
        },

        /** Take a saved rating down: the member who saved it, or an editor (with the reason, kept in the audit log). */
        async removeSeenRating(id, actor, reason = null) {
            const who = requirePerson(actor, 'Removing a rating');
            return await tx(async () => {
                const r = await q.seenRating.get(String(id || ''));
                if (!r || r.status !== 'shown') fail(404, 'seen.not_found', 'No such rating');
                const own = r.seen_by === who;
                if (!own && !access.isEditor(actor)) fail(403, 'reviews.editor_required', 'Only the member who saved it or an editor can remove it');
                const why = own ? 'removed by the member who saved it' : String(reason || '').trim().slice(0, 300) || 'removed by an editor';
                await q.removeSeenRating.run(who, why, r.id);
                await syncEntity(await canonicalOf(r.entity_id));
                await audit(actor, 'seen_rating.removed', r.entity_id, r.id, { reason: why });
                return { removed: true, entity_id: r.entity_id };
            });
        },

        async recentMemberReviews(limit = 8) {
            return (await q.recentMemberReviews.all(limit)).map((r) => ({ ...memberReviewView(r, null), entity: { slug: r.entity_slug, name: r.entity_name, kind: r.entity_kind, place: r.entity_place } }));
        },
        async entitiesOfKind(kind, { limit = 60, offset = 0 } = {}) {
            if (!ENTITY_KINDS.includes(kind)) fail(404, 'kind.not_found', 'No such kind');
            const rows = await q.entitiesOfKind.all(kind, limit, offset);
            return {
                total: Number((await q.countOfKind.get(kind)).n),
                entities: rows.map((x) => ({ ...x, member_count: Number(x.member_count) || 0, member_avg: x.member_avg == null ? null : Math.round(Number(x.member_avg) * 10) / 10,
                    complaints: x.complaints == null ? null : Number(x.complaints) })),
            };
        },
        async kindCounts() { return Object.fromEntries((await q.kindCounts.all()).map((x) => [x.kind, Number(x.n)])); },

        async updateEntity(ref, { name, kind, description, slug, noindex } = {}, actor) {
            requireEditorPerson(actor, 'Editing an entity');
            return await tx(async () => {
                const e = await entityOrFail(ref);
                if (e.state !== 'active') fail(409, 'entity.not_active', `This entity is ${e.state}`);
                const next = { ...e };
                const changes = {};
                if (name != null && name !== e.name) { next.name = checkName(name); changes.name = [e.name, next.name]; await insertAlias(e.id, 'name', next.name, actor); }
                if (kind != null && kind !== e.kind) { if (!ENTITY_KINDS.includes(kind)) fail(422, 'entity.invalid_kind', `kind is one of ${ENTITY_KINDS.join(', ')}`); next.kind = kind; changes.kind = [e.kind, kind]; }
                if (description !== undefined && (description || null) !== e.description) { next.description = description ? String(description).trim().slice(0, 2000) || null : null; changes.description = true; }
                if (noindex != null && !!noindex !== !!e.noindex) { next.noindex = noindex ? 1 : 0; changes.noindex = !!noindex; }
                if (slug != null && slug !== e.slug) {
                    const s = norm.slug(slug);
                    if (!s) fail(422, 'entity.invalid_slug', 'That slug has no letters or digits');
                    const other = await q.entityBySlug.get(s);
                    if (other && other.id !== e.id) fail(409, 'entity.slug_taken', `/e/${s} is taken`);
                    await redirects.recordMove(e.id, `/e/${e.slug}`, `/e/${s}`, { reason: 'renamed' });
                    next.slug = s; changes.slug = [e.slug, s];
                }
                await db.prepare('UPDATE review_entities SET name = ?, kind = ?, description = ?, slug = ?, noindex = ?, updated_at = ? WHERE id = ?')
                    .run(next.name, next.kind, next.description, next.slug, next.noindex, now(), e.id);
                if (Object.keys(changes).length) await audit(actor, 'entity.updated', e.id, null, changes);
                await syncEntity(e.id);
                return await q.entity.get(e.id);
            });
        },

        async deleteEntity(ref, { note = null } = {}, actor) {
            requireEditorPerson(actor, 'Deleting an entity');
            return await tx(async () => {
                const e = await entityOrFail(ref);
                if (e.state !== 'active') fail(409, 'entity.not_active', `This entity is ${e.state}`);
                if ((await q.mergedInto.all(e.id)).length) fail(409, 'entity.has_merges', 'Split the entities merged into this one first');
                const active = await q.activeSignalsOfEntity.all(e.id);
                if (active.length) fail(409, 'entity.has_signals', 'This entity has live signals: reattribute or ignore their items first');
                await db.prepare("UPDATE review_entities SET state = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), e.id);
                await audit(actor, 'entity.deleted', e.id, null, { note });
                await syncEntity(e.id);
                return await q.entity.get(e.id);
            });
        },

        async addAlias(ref, { type, value } = {}, actor) {
            requireEditorPerson(actor, 'Adding an alias');
            return await tx(async () => {
                const e = await entityOrFail(ref);
                if (e.state === 'deleted') fail(409, 'entity.not_active', 'This entity was deleted');
                const a = await insertAlias(e.id, type, value, actor);
                await audit(actor, 'alias.added', e.id, a.id, { type: a.type, value: a.value });
                const settled = await reresolvePending(actor);
                return { alias: a, settled_items: settled };
            });
        },

        async removeAlias(ref, aliasId, actor) {
            requireEditorPerson(actor, 'Removing an alias');
            return await tx(async () => {
                const e = await entityOrFail(ref);
                const a = await q.alias.get(String(aliasId));
                if (!a || a.entity_id !== e.id || a.removed_at) fail(404, 'alias.not_found', 'No such alias');
                await q.removeAlias.run(now(), actorId(actor), a.id);
                await audit(actor, 'alias.removed', e.id, a.id, { type: a.type, value: a.value });
                return await q.alias.get(a.id);
            });
        },

        async addLink(ref, { type, to = null, ref: entityRef = null, note = null } = {}, actor) {
            requireEditorPerson(actor, 'Linking entities');
            if (!LINK_TYPES.includes(type) || type === 'merged_into') fail(422, 'link.invalid', `type is one of ${LINK_TYPES.filter((t) => t !== 'merged_into').join(', ')} (merges go through merge)`);
            return await tx(async () => {
                const e = await entityOrFail(ref);
                let target = null;
                let refJson = null;
                if (type === 'external_ref') {
                    const { entityRef: mk } = require('openvibe-publishing/discussion');
                    try { refJson = JSON.stringify(mk(entityRef || {})); } catch (err) { fail(422, 'link.invalid', err.message); }
                } else {
                    target = await entityOrFail(to);
                    if (target.id === e.id) fail(422, 'link.invalid', 'An entity cannot link to itself');
                }
                const t = now();
                const id = `lnk_${ulid(t)}`;
                await q.insertLink.run({ id, from: e.id, to: target ? target.id : null, type, ref: refJson, note: note ? String(note).slice(0, 500) : null, by: actorId(actor), now: t });
                await audit(actor, 'link.added', e.id, id, { type, to: target ? target.id : null, ref: parse(refJson, null) });
                return await q.link.get(id);
            });
        },

        async endLink(ref, linkId, { note = null } = {}, actor) {
            requireEditorPerson(actor, 'Removing a link');
            return await tx(async () => {
                const e = await entityOrFail(ref);
                const l = await q.link.get(String(linkId));
                if (!l || (l.from_entity !== e.id && l.to_entity !== e.id) || l.ended_at || l.type === 'merged_into') fail(404, 'link.not_found', 'No such link (merges are undone with split)');
                await q.endLink.run(now(), actorId(actor), note ? String(note).slice(0, 500) : null, l.id);
                await audit(actor, 'link.ended', e.id, l.id, { type: l.type });
                return await q.link.get(l.id);
            });
        },

        // Merge and split (reviews.entity.merge | reviews.entity.split) ----------------------
        /**
         * Merge `ref` into `into`. Nothing is rewritten: the merged entity keeps its aliases and its
         * signals keep their attribution; it becomes state `merged` with an active `merged_into`
         * link, and the target's aggregate is recomputed over both. That is why a split restores
         * the pre-merge attribution exactly.
         */
        async merge(ref, { into, note = null } = {}, actor) {
            const who = requireEditorPerson(actor, 'Merging entities');
            return await tx(async () => {
                const src = await entityOrFail(ref);
                const tgt = await entityOrFail(into);
                if (src.id === tgt.id) fail(422, 'merge.same_entity', 'An entity cannot be merged into itself');
                if (src.state !== 'active') fail(409, 'merge.not_active', `"${src.name}" is ${src.state}`);
                if (tgt.state !== 'active') fail(409, 'merge.target_not_active', `"${tgt.name}" is ${tgt.state}${tgt.state === 'merged' ? `; merge into ${await canonicalOf(tgt.id)} instead` : ''}`, { canonical_id: await canonicalOf(tgt.id) });
                if ((await closure(src.id)).has(tgt.id)) fail(409, 'merge.cycle', 'The target is merged into this entity');
                const t = now();
                const linkId = `lnk_${ulid(t)}`;
                const moved = (await activeSignalsIn(await closure(src.id))).map((s) => s.id);
                await q.insertLink.run({ id: linkId, from: src.id, to: tgt.id, type: 'merged_into', ref: null, note: note ? String(note).slice(0, 500) : null, by: who, now: t });
                await db.prepare("UPDATE review_entities SET state = 'merged', merged_into = ?, updated_at = ? WHERE id = ?").run(tgt.id, t, src.id);
                await audit(actor, 'entity.merged', src.id, tgt.id, {
                    link_id: linkId, into: tgt.id, note, signals: moved,
                    aliases: (await q.aliasesOf.all(src.id)).map((a) => a.id),
                    merged_members: [...await closure(src.id)].filter((id) => id !== src.id),
                });
                await refreshAggregate(tgt.id, 'merge');
                await touchEntity(tgt.id);
                await syncEntity(src.id);
                await syncEntity(tgt.id);
                await entityEvent('reviews.entity.merged', src, actor, {
                    entity_id: src.id, into_entity_id: tgt.id, link_id: linkId, signal_count: moved.length,
                    url: entityUrl(src), into_url: entityUrl(tgt), note: note ? String(note).slice(0, 500) : null,
                });
                return { link: await q.link.get(linkId), entity: await q.entity.get(src.id), into: await q.entity.get(tgt.id), signals: moved };
            });
        },

        async split(ref, { note = null } = {}, actor) {
            const who = requireEditorPerson(actor, 'Splitting entities');
            return await tx(async () => {
                const src = await entityOrFail(ref);
                if (src.state !== 'merged') fail(409, 'split.not_merged', `"${src.name}" is not merged into another entity`);
                const link = await q.activeMerge.get(src.id);
                if (!link) fail(409, 'split.no_merge_link', 'No active merge link for this entity');
                const t = now();
                await q.endLink.run(t, who, note ? String(note).slice(0, 500) : null, link.id);
                await db.prepare("UPDATE review_entities SET state = 'active', merged_into = NULL, updated_at = ? WHERE id = ?").run(t, src.id);
                const restored = (await activeSignalsIn(await closure(src.id))).map((s) => s.id);
                await audit(actor, 'entity.split', src.id, link.to_entity, { link_id: link.id, from: link.to_entity, note, signals: restored });
                await refreshAggregate(src.id, 'split');
                await refreshAggregate(link.to_entity, 'split');
                // The former target's summary may cite signals that went back with the split.
                const tgtCanon = await canonicalOf(link.to_entity);
                const tgtSummary = tgtCanon && await q.summary.get(tgtCanon);
                if (tgtSummary) await flagSummary(tgtSummary.id, 'Entities were split: a cited signal now belongs to another entity', restored);
                await touchEntity(src.id);
                if (tgtCanon) await touchEntity(tgtCanon);
                await syncEntity(src.id);
                if (tgtCanon) await syncEntity(tgtCanon);
                const from = await q.entity.get(link.to_entity);
                await entityEvent('reviews.entity.split', src, actor, {
                    entity_id: src.id, from_entity_id: link.to_entity, link_id: link.id, signal_count: restored.length,
                    url: entityUrl(await q.entity.get(src.id)), from_url: from ? entityUrl(from) : null, note: note ? String(note).slice(0, 500) : null,
                });
                return { link: await q.link.get(link.id), entity: await q.entity.get(src.id), from: from, signals: restored };
            });
        },

        // Sources items and signals (reviews.signal.import) ----------------------------------
        applyItem,
        /** Run fn in one transaction; aggregates of touched entities are recomputed once at the end. */
        batch,
        /** Fetch one item from Sources and apply it (the ingest chassis' SourcesError → ReviewsError). */
        async importItem(itemId, sources, actor) {
            if (!ITEM_RE.test(String(itemId || ''))) fail(422, 'signal.invalid_source_item', 'A Sources item id looks like itm_<ULID>');
            let item; let source;
            try { ({ item, source } = await sources.getItem(String(itemId))); } catch (err) {
                if (!err || typeof err.code !== 'string' || !err.code.startsWith('sources.')) throw err;
                if (err.code === 'sources.http_404') fail(404, 'signal.source_item_not_found', err.message);
                fail(Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 503, 'sources.unavailable', err.message);
            }
            let info = source || null;
            if (!await q.source.get(item.source_key)) {
                try { const full = await sources.getSource(item.source_key); if (full) info = { ...full, ...(source || {}) }; } catch { /* the notes come with the item */ }
            }
            return await applyItem(item, { sourceInfo: info, actor });
        },

        /** A source item removal we heard about (sources.item.removed event). */
        async removeItem(itemId, reason, actor) {
            const row = await q.item.get(String(itemId));
            if (!row) return { outcome: 'ignored:unknown_item' };
            if (row.state === 'removed') return { outcome: 'unchanged' };
            return await tx(async () => {
                await q.removeItem.run(new Date(now()).toISOString(), String(reason || 'removed by its source').slice(0, 500), now(), row.id);
                await reconcileItemSignal(await q.item.get(row.id), actor);
                return { outcome: 'removed', item: await q.item.get(row.id) };
            });
        },

        async item(itemId) { return await q.item.get(String(itemId)) || null; },
        async itemView(row) {
            if (!row) return null;
            const fields = parse(row.fields, {});
            return {
                id: row.id, source_key: row.source_key, kind: row.kind, identity: row.identity, canonical_url: row.canonical_url, title: row.title,
                item_revision: row.item_revision, published_at: row.published_at, retrieved_at: row.retrieved_at, license_note: row.license_note, terms_note: row.terms_note,
                fields, state: row.state, removed_at: row.removed_at, removed_reason: row.removed_reason,
                resolution: row.resolution, entity_id: row.entity_id, resolution_rule: row.resolution_rule,
                candidates: (await Promise.all(parse(row.candidates, []).map(async (c) => ({ ...c, entity: await q.entity.get(c.entity_id) ? await entityView(await q.entity.get(c.entity_id)) : null })))),
                signal_note: row.signal_note, signal: (async () => { const s = await q.activeSignalOfItem.get(row.id); return s ? await signalPayload(s) : null; })(),
            };
        },
        async resolutionQueue(limit = 200) { return await q.queueItems.all(Math.min(500, limit)); },

        /** An editor settles an item: attach it to an entity (optionally remember the identifier). */
        async confirmResolution(itemId, { entity: entityRef, add_alias: addAlias = null } = {}, actor) {
            const who = requireEditorPerson(actor, 'Confirming a resolution');
            return await tx(async () => {
                const row = await q.item.get(String(itemId));
                if (!row) fail(404, 'item.not_found', 'Reviews has not read that item');
                if (row.state !== 'active') fail(409, 'item.removed', 'Its source removed this item');
                const e = await entityOrFail(entityRef);
                if (e.state !== 'active') fail(409, 'entity.not_active', `"${e.name}" is ${e.state}`);
                const before = { resolution: row.resolution, entity_id: row.entity_id };
                if (addAlias) {
                    const ids = itemIdentifiers(row);
                    const pick = addAlias === 'name' ? (ids.names[0] ? { type: 'name', value: ids.names[0] } : null) : ids.strong.find((x) => x.type === addAlias);
                    if (!pick) fail(422, 'alias.invalid', `The item has no ${addAlias} to remember`);
                    await insertAlias(e.id, pick.type, pick.value, actor);
                }
                const fresh = await setItemResolution(row, { resolution: 'resolved', entity_id: e.id, rule: 'editor', candidates: [] }, who);
                const out = await reconcileItemSignal(fresh, actor);
                await audit(actor, 'item.resolved', e.id, row.id, { before, rule: 'editor', add_alias: addAlias || null, signal: out.signal ? out.signal.id : null });
                const settled = addAlias ? await reresolvePending(actor) : 0;
                return { item: await q.item.get(row.id), signal: out.signal || null, settled_items: settled };
            });
        },

        async ignoreItem(itemId, { note = null } = {}, actor) {
            requireEditorPerson(actor, 'Ignoring an item');
            return await tx(async () => {
                const row = await q.item.get(String(itemId));
                if (!row) fail(404, 'item.not_found', 'Reviews has not read that item');
                const fresh = await setItemResolution(row, { resolution: 'ignored', entity_id: null, rule: 'editor', candidates: [] }, actorId(actor));
                await reconcileItemSignal(fresh, actor);
                await audit(actor, 'item.ignored', row.entity_id, row.id, { note });
                return await q.item.get(row.id);
            });
        },

        // Trust metadata --------------------------------------------------------------------
        async setTrust({ scope, scope_id: scopeId, key, value, note = null } = {}, actor) {
            requireEditorPerson(actor, 'Trust decisions');
            if (!['source', 'signal', 'entity'].includes(scope)) fail(422, 'trust.invalid', 'scope is source, signal or entity');
            if (!TRUST_KEYS.includes(key)) fail(422, 'trust.invalid', `key is one of ${TRUST_KEYS.join(', ')}`);
            const v = value == null ? '' : String(value).trim().slice(0, 1000);
            if (key === 'aggregate' && !['include', 'exclude'].includes(v)) fail(422, 'trust.invalid', 'aggregate is include or exclude');
            if (key === 'aggregate' && v === 'exclude' && !String(note || '').trim()) fail(422, 'trust.reason_required', 'Excluding from the aggregate needs a reason readers can see');
            if (key === 'aggregate' && scope === 'entity') fail(422, 'trust.invalid', 'Exclude a source or a signal, not a whole entity');
            return await tx(async () => {
                let entityIds = [];
                if (scope === 'source') { if (!await q.source.get(String(scopeId))) fail(404, 'source.not_found', 'Reviews has not seen that source'); entityIds = (await q.entitiesWithSourceSignals.all(String(scopeId))).map((r) => r.entity_id); }
                if (scope === 'signal') { const s = await q.signal.get(String(scopeId)); if (!s) fail(404, 'signal.not_found', 'No such signal'); entityIds = [s.entity_id]; }
                if (scope === 'entity') { const e = await entityOrFail(scopeId); scopeId = e.id; entityIds = [e.id]; }
                const cur = await q.trustOne.get(scope, String(scopeId), key);
                const who = actorId(actor);
                if (cur) await q.trustEnd.run(now(), who, cur.id);
                if (v && !(key === 'aggregate' && v === 'include')) await q.trustInsert.run(scope, String(scopeId), key, v, note ? String(note).slice(0, 1000) : null, who, now());
                await audit(actor, 'trust.set', scope === 'entity' ? scopeId : (entityIds.length === 1 ? await canonicalOf(entityIds[0]) : null), `${scope}:${scopeId}`, { key, value: v, note, previous: cur ? { value: cur.value, note: cur.note } : null });
                const canon = [...new Set((await Promise.all(entityIds.map(canonicalOf))).filter(Boolean))];
                for (const id of canon) { await refreshAggregate(id, 'trust'); await touchEntity(id); await syncEntity(id); }
                return { scope, scope_id: scopeId, key, current: await q.trustOne.get(scope, String(scopeId), key) || null, affected_entities: canon };
            });
        },
        async trustHistory(scope, id) { return await q.trustHistory.all(scope, id); },
        trustMap,

        // Summaries (reviews.summary.publish | reviews.summary.propose) ----------------------
        /**
         * An editor writes a summary revision; publish: true publishes it at once. With a
         * correction_note (and optionally the correction_id of a reader's request it answers) the
         * revision corrects the published summary: it carries the note and is published at once.
         */
        async writeSummary(ref, input = {}, actor) {
            const who = requireEditorPerson(actor, 'Writing a summary');
            return await tx(async () => {
                const e = await entityOrFail(ref);
                if (e.state !== 'active') fail(409, 'entity.not_active', `This entity is ${e.state}`);
                if (wantsCorrection(input)) return await correctSummary(e, input, { note: input.correction_note, requestId: input.correction_id }, actor, who);
                const body = await checkSummaryInput(e.id, input);
                const summary = await ensureSummary(e.id);
                const revision = await createRevision({
                    entityId: summary.id, expectedRevision: expectedOf(input, await revisions.headNumber(summary.id)), content: body.content, fields: body.fields,
                    meta: { authorship: authorship.record({ mode: 'human', authors: [who] }) }, author: who,
                    message: input.message ? String(input.message).slice(0, 500) : null, allowUnchanged: true,
                });
                await writeCitations(summary, revision);
                await audit(actor, 'summary.revision', e.id, summary.id, { revision: revision.number });
                let published = null;
                if (input.publish === true || input.publish === 'true' || input.publish === '1') published = await svc.publishSummary(e.id, { revision: revision.number }, actor);
                return { summary: await q.summary.get(e.id), revision: await summaryRevisionView(await q.summary.get(e.id), revision, e.id), published: !!published };
            });
        },

        /**
         * The OpenVibe.AI seam (workflow reviews.summarize_entity): a draft revision with ai
         * authorship (workflow + run id). Never published by this call, noindex until a person
         * approves it, and it can never state a rating: its text is checked, and summaries have no
         * field that could carry one.
         */
        async proposeSummary(ref, input = {}, actor) {
            if (!actor || (actor.kind !== 'service' && actor.kind !== 'system')) fail(403, 'summary.service_only', 'AI proposals come from a service principal');
            const wf = input.workflow || {};
            const runId = wf.run_id || wf.runId;
            if (!wf.id || !runId) fail(400, 'authorship.workflow_required', `An AI proposal names its OpenVibe.AI workflow (workflow.id, e.g. ${SUMMARY_WORKFLOW}) and run (workflow.run_id)`);
            let rec;
            try { rec = authorship.record({ mode: 'ai', workflow: { id: String(wf.id), runId: String(runId), version: wf.version, model: wf.model }, stubProvider: !!(input.stub_provider || input.stubProvider) }); } catch (err) { fail(422, 'authorship.invalid', err.message); }
            return await tx(async () => {
                const e = await entityOrFail(ref);
                if (e.state !== 'active') fail(409, 'entity.not_active', `This entity is ${e.state}`);
                const body = await checkSummaryInput(e.id, input, { ai: true });
                const summary = await ensureSummary(e.id);
                const head = await revisions.headNumber(summary.id);
                const { revision } = await revisions.create({
                    entityId: summary.id, expectedRevision: head, content: body.content, fields: body.fields,
                    meta: { authorship: rec }, author: actorId(actor), message: input.note ? `AI proposal: ${String(input.note).slice(0, 200)}` : 'AI proposal', allowUnchanged: true,
                });
                await writeCitations(summary, revision);
                await audit(actor, 'summary.proposed', e.id, summary.id, { revision: revision.number, workflow: rec.workflow, stub_provider: !!rec.stubProvider });
                return { summary: await q.summary.get(e.id), revision: await summaryRevisionView(await q.summary.get(e.id), revision, e.id) };
            });
        },

        /** An editor approves (and by default publishes) or rejects a revision. */
        async reviewSummary(ref, n, { decision, note = null, publish = true } = {}, actor) {
            const who = requireEditorPerson(actor, 'Reviewing a summary');
            if (decision !== 'approved' && decision !== 'rejected') fail(422, 'review.invalid_decision', 'decision is approved or rejected');
            return await tx(async () => {
                const e = await entityOrFail(ref);
                const summary = await q.summary.get(e.id);
                if (!summary) fail(404, 'summary.not_found', 'This entity has no summary');
                const rev = await revisions.get(summary.id, Number(n));
                if (!rev) fail(404, 'revision.not_found', `No revision ${n}`);
                const review = await reviews.record({ entityId: summary.id, revision: rev.number, reviewer: who, decision, note });
                await audit(actor, `summary.${decision}`, e.id, summary.id, { revision: rev.number, note });
                let published = false;
                if (decision === 'approved' && publish !== false && publish !== 'false') { await svc.publishSummary(e.id, { revision: rev.number }, actor); published = true; }
                if (decision === 'approved' && !published && summary.state === 'published' && summary.published_revision === rev.number) await syncEntity(e.id);
                return { review, published, summary: await q.summary.get(e.id) };
            });
        },

        async publishSummary(ref, { revision } = {}, actor) {
            requireEditorPerson(actor, 'Publishing a summary');
            return await tx(async () => {
                const e = await entityOrFail(ref);
                if (e.state !== 'active') fail(409, 'entity.not_active', `This entity is ${e.state}`);
                const summary = await q.summary.get(e.id);
                if (!summary) fail(404, 'summary.not_found', 'This entity has no summary');
                const n = revision == null ? await revisions.headNumber(summary.id) : Number(revision);
                const rev = await revisions.get(summary.id, n);
                if (!rev) fail(404, 'revision.not_found', `No revision ${revision}`);
                const review = await reviews.latest(summary.id, n);
                if (review && review.decision === 'rejected') fail(409, 'summary.rejected', 'This revision was rejected by an editor');
                const rec = rev.meta && rev.meta.authorship;
                if (rec) { const ok = authorship.canPublish(rec, review); if (!ok.ok) fail(409, ok.reason, 'AI-drafted summaries are published only after a person approves them'); }
                if (rev.meta && rev.meta.system && !(review && review.decision === 'approved')) fail(409, 'summary.review_required', 'A revision prepared after a source change is published only after an editor approves it');
                const bad = (await citationState(e.id, rev)).filter((p) => !p.supported);
                if (bad.length) fail(409, 'summary.unsupported_points', `${bad.length} point(s) cite no live signal of this entity`, { points: bad.map((p) => p.key) });
                const wasPublished = summary.state === 'published';
                const before = summary.published_revision;
                await q.publishSummary.run({ id: summary.id, n, now: now() });
                await audit(actor, 'summary.published', e.id, summary.id, { revision: n, previous: before });
                await touchEntity(e.id);
                const doc = await syncEntity(e.id);
                const fresh = await q.entity.get(e.id);
                const decision = await decide(fresh);
                const action = !wasPublished ? 'published' : (before !== n ? 'updated' : null);
                if (action) {
                    await emit(hooks.publicationEvent({
                        product: 'reviews', type: 'summary', action, id: summary.id, revision: n,
                        actor: hooks.subjectRef(actorId(actor)), decision, now: now(),
                        document: { owner: 'reviews', type: 'summary', id: summary.id, revision: doc ? doc.revision : 0, deleted: false, visibility: 'public', canonical_url: entityUrl(fresh), publication_state: 'published', indexability: hooks.searchIndexability(decision) },
                        extra: { entity_id: e.id, entity_slug: fresh.slug, authorship: rec ? hooks.AUTHORSHIP[rec.mode] : null, ...(rev.meta && rev.meta.correction ? { correction: { note: rev.meta.correction.note, corrects: rev.meta.correction.corrects } } : {}) },
                    }));
                }
                return await q.summary.get(e.id);
            });
        },

        async unpublishSummary(ref, actor) {
            requireEditorPerson(actor, 'Unpublishing a summary');
            return await tx(async () => {
                const e = await entityOrFail(ref);
                const summary = await q.summary.get(e.id);
                if (!summary || summary.state !== 'published') fail(409, 'summary.not_published', 'Nothing is published');
                await q.unpublishSummary.run(now(), summary.id);
                await audit(actor, 'summary.unpublished', e.id, summary.id, { revision: summary.published_revision });
                const doc = await syncEntity(e.id);
                const fresh = await q.entity.get(e.id);
                const decision = await decide(fresh);
                await emit(hooks.publicationEvent({
                    product: 'reviews', type: 'summary', action: 'unpublished', id: summary.id, revision: summary.published_revision,
                    actor: hooks.subjectRef(actorId(actor)), decision, now: now(),
                    document: { owner: 'reviews', type: 'summary', id: summary.id, revision: doc ? doc.revision : 0, deleted: true },
                    extra: { entity_id: e.id, entity_slug: fresh.slug },
                }));
                return await q.summary.get(e.id);
            });
        },

        async flaggedSummaries() { return (await Promise.all((await q.flaggedSummaries.all()).map(async (s) => ({ ...s, entity: await q.entity.get(s.entity_id) })))); },
        async pendingSummaries() {
            return (await Promise.all((await q.allSummaries.all()).map(async (s) => ({ summary: s, entity: await q.entity.get(s.entity_id), pending: await pendingRevisions(s) }))))
                .filter((x) => x.pending.length && x.entity && x.entity.state === 'active')
                .map((x) => ({ entity: x.entity, summary: x.summary, pending: x.pending.map((p) => ({ number: p.rev.number, status: p.status, message: p.rev.message, created_at: p.rev.createdAt })) }));
        },

        /** Published summaries for the feed, newest first, with the gate's decision for the entity. */
        async recentSummaries(limit = 50) {
            return (await Promise.all((await q.publishedSummaries.all(limit)).map(async (s) => {
                const e = await q.entity.get(s.entity_id);
                if (!e || e.state !== 'active') return null;
                const rev = await revisions.get(s.id, s.published_revision);
                return { summary: s, entity: e, rev, decision: await decide(e) };
            }))).filter(Boolean);
        },

        /** Every active entity with its decision (sitemaps). */
        async publicEntities() {
            return (await Promise.all((await db.prepare("SELECT * FROM review_entities WHERE state = 'active' ORDER BY id").all()).map(async (e) => ({ entity: e, decision: await decide(e) }))));
        },

        /** Entities with at least one live signal or a published summary (the home page). */
        async entitiesWithData(limit = 60) {
            return (await Promise.all((await db.prepare(`SELECT e.* FROM review_entities e WHERE e.state = 'active' AND (
                    EXISTS (SELECT 1 FROM review_signals s JOIN review_entities m ON m.id = s.entity_id WHERE s.status = 'active' AND (m.id = e.id OR m.merged_into = e.id))
                    OR EXISTS (SELECT 1 FROM review_summaries u WHERE u.entity_id = e.id AND u.state = 'published'))
                ORDER BY e.updated_at DESC LIMIT ?`).all(limit)).map(async (e) => ({ entity: e, aggregate: aggregateView(await q.lastAggregate.get(e.id)) }))));
        },

        // Corrections (reviews.correction.submit) --------------------------------------------
        async submitCorrection(ref, { target_type: targetType = 'entity', target_id: targetId = null, body, evidence_url: evidenceUrl = null } = {}, actor) {
            if (!access.isPerson(actor)) fail(403, 'reviews.person_required', 'Corrections come from a signed-in person (a service must name them in X-OV-Subject)');
            if (!['entity', 'alias', 'signal', 'summary', 'aggregate'].includes(targetType)) fail(422, 'correction.invalid', 'target_type is entity, alias, signal, summary or aggregate');
            const text = String(body == null ? '' : body).trim();
            if (text.length < 10) fail(422, 'correction.invalid', 'Tell the editors what is wrong (at least 10 characters)');
            if (text.length > 4000) fail(422, 'correction.invalid', 'At most 4000 characters');
            let url = null;
            if (evidenceUrl) {
                try { const u = new URL(String(evidenceUrl)); if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('x'); url = u.toString(); } catch { fail(422, 'correction.invalid', 'evidence_url must be an http(s) URL'); }
            }
            return await tx(async () => {
                const e = await entityOrFail(ref);
                if (e.state === 'deleted') fail(410, 'entity.deleted', 'This entity was deleted');
                const t = now();
                const entityId = await canonicalOf(e.id) || e.id;
                // One person cannot bury the editors' queue: a daily allowance, and the same open request once.
                if (await q.sameOpenCorrection.get(actor.subject, entityId, text)) fail(409, 'correction.duplicate', 'You already sent this correction; it is waiting for an editor');
                if ((await q.correctionsSince.get(actor.subject, t - DAY_MS)).n >= CORRECTIONS_PER_PERSON_DAY) fail(429, 'correction.rate_limited', `At most ${CORRECTIONS_PER_PERSON_DAY} corrections a day; the editors will read the ones you sent`);
                const id = `cor_${ulid(t)}`;
                const target = targetId ? String(targetId).slice(0, 100) : null;
                await q.insertCorrection.run({ id, entity_id: entityId, target_type: targetType, target_id: target, body: text, evidence_url: url ? url.slice(0, 2000) : null, submitted_by: actor.subject, via: actor.kind === 'service' ? actor.service : null, now: t });
                await audit(actor, 'correction.submitted', entityId, id, { target_type: targetType, target_id: target });
                return await q.correction.get(id);
            });
        },
        async openCorrections() {
            return (await Promise.all((await q.openCorrections.all()).map(async (c) => {
                const entity = await q.entity.get(await canonicalOf(c.entity_id) || c.entity_id);
                const s = entity && entity.state === 'active' ? await q.summary.get(entity.id) : null;
                return { ...c, entity, summary_published: !!(s && s.state === 'published') };
            })));
        },
        async correction(id) { return await q.correction.get(String(id)) || null; },
        /**
         * An editor accepts or rejects a correction request. `note` stays with the editors. Accepting
         * a request about an entity whose summary is published corrects that summary: a new revision
         * with the public `correction_note` (and the new text in `summary`, or the published text
         * carried forward). Rejecting creates nothing.
         */
        async resolveCorrection(id, { status, note = null, correction_note: correctionNote = null, summary: body = null } = {}, actor) {
            const who = requireEditorPerson(actor, 'Resolving a correction');
            if (!['accepted', 'rejected'].includes(status)) fail(422, 'correction.invalid', 'status is accepted or rejected');
            if (body != null && (typeof body !== 'object' || Array.isArray(body))) fail(422, 'summary.invalid', 'summary is { overview, overview_signals, pros, cons }');
            return await tx(async () => {
                const c = await q.correction.get(String(id));
                if (!c) fail(404, 'correction.not_found', 'No such correction');
                if (c.status !== 'open') fail(409, 'correction.closed', `Already ${c.status}`);
                const internal = note ? String(note).slice(0, 2000) : null;
                if (status === 'accepted') {
                    const e = await q.entity.get(await canonicalOf(c.entity_id) || c.entity_id);
                    const s = e && e.state === 'active' ? await q.summary.get(e.id) : null;
                    if (s && s.state === 'published') {
                        const out = await correctSummary(e, { ...(body || {}) }, { note: correctionNote, requestId: c.id, resolutionNote: internal }, actor, who);
                        return { correction: out.correction, revision: out.revision };
                    }
                }
                await q.resolveCorrection.run(status, who, internal, now(), c.id);
                await audit(actor, `correction.${status}`, c.entity_id, c.id, { note: internal });
                return { correction: await q.correction.get(c.id), revision: null };
            });
        },

        // Discussion (Community, referenced) -------------------------------------------------
        async knownThread(entityId) { const d = await discussions.get(entityId); return d ? d.threadId : null; },
        async discussionThread(e, client) {
            const known = await discussions.get(e.id);
            if (known) return known.threadId;
            if (e.state !== 'active') return null;
            const out = await discussions.threadFor(e.id, { service: 'reviews', type: 'entity', id: e.id, label: e.name.slice(0, 200) }, { client });
            return out.threadId;
        },

        // Search reconciliation ---------------------------------------------------------------
        /** Stamp + enqueue the entity's current document on the caller's handle (used by tests/ops). */
        syncIndex: syncEntity,
        /** Re-send every entity's document that differs from what Search holds; one short transaction per entity, so a
         *  running service is never held up behind it. `stopped()` ends it early (a shutdown). */
        async reconcileIndex({ stopped = () => false } = {}) {
            let sent = 0;
            for (const { id } of await q.allEntityIds.all()) {
                if (stopped()) break;
                sent += await tx(async () => {
                    const before = await sequencer.current('reviews', 'entity', id);
                    if (before == null && (await q.entity.get(id)).state !== 'active') return 0;
                    const doc = await syncEntity(id);
                    return doc && doc.revision !== before ? 1 : 0;
                });
            }
            return { sent };
        },

        async stats() {
            const one = async (sql) => (await db.prepare(sql).get()).n;
            return {
                entities: await one("SELECT COUNT(*) AS n FROM review_entities WHERE state = 'active'"),
                signals: await one("SELECT COUNT(*) AS n FROM review_signals WHERE status = 'active'"),
                items_unresolved: await one("SELECT COUNT(*) AS n FROM review_source_items WHERE resolution IN ('ambiguous','unmatched') AND state = 'active'"),
                corrections_open: await one("SELECT COUNT(*) AS n FROM review_corrections WHERE status = 'open'"),
                summaries_flagged: await one('SELECT COUNT(*) AS n FROM review_summaries WHERE flagged = 1'),
            };
        },
    };
    return svc;
}

module.exports = { createReviewsService, ReviewsError, SUMMARY_WORKFLOW, RATING_TEXT_RE, recordName };
