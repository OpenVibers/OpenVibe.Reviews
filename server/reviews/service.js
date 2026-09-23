'use strict';
/**
 * The reviews domain: entities and aliases, resolution of Sources items to entities, signals with
 * provenance, aggregates, reversible merges, summaries, corrections. Reviews owns the
 * interpretation and publication layer; OpenVibe.Sources owns the items, Community the discussion,
 * OpenVibe.AI only proposes drafts.
 *
 * Every write runs in one SQLite transaction together with the events it causes (transactional
 * outbox): reviews.entity.merged|split, reviews.signal.added|removed,
 * reviews.summary.published|updated|unpublished (a correction is an `updated` carrying
 * `correction`), and the Search index events reviews.index_document.upserted|deleted.
 *
 * Methods take an actor (server/reviews/access.js) and throw ReviewsError (status + stable code).
 */
const seo = require('openvibe-publishing/seo');
const hooks = require('openvibe-publishing/index-hooks');
const authorship = require('openvibe-publishing/authorship');
const ssr = require('openvibe-publishing/ssr');
const { ulid } = require('openvibe-contracts').ids;
const norm = require('./normalize');
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
// A summary is text with citations. Nothing in it can carry a score.
const SUMMARY_KEYS = new Set(['overview', 'pros', 'cons', 'overview_signals', 'expected_revision', 'expectedRevision', 'message', 'publish', 'workflow', 'stub_provider', 'stubProvider', 'note', 'correction_note', 'correction_id']);
const BODY_KEYS = ['overview', 'overview_signals', 'pros', 'cons'];
const RATING_KEY_RE = /(rating|stars?|score|grade|verdict_value)/i;
// Numeric ratings in AI text ("4.5/5", "8 out of 10", "★★★★"): AI output never states a rating.
const RATING_TEXT_RE = /(\b\d+(?:[.,]\d+)?\s*(?:\/|out of)\s*(?:5|10|100)\b)|[★☆⭐]|\b\d+(?:[.,]\d+)?\s*stars?\b/i;

const toIso = (ms) => (ms == null ? null : new Date(ms).toISOString());

function createReviewsService({ db, stores, outbox, config, now = () => Date.now(), log = console }) {
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
        listActive: db.prepare(`SELECT e.* FROM review_entities e WHERE e.state = 'active' ORDER BY e.name COLLATE NOCASE LIMIT ? OFFSET ?`),
        countActive: db.prepare("SELECT COUNT(*) AS n FROM review_entities WHERE state = 'active'"),
        searchEntities: db.prepare(`SELECT DISTINCT e.* FROM review_entities e LEFT JOIN review_entity_aliases a ON a.entity_id = e.id AND a.removed_at IS NULL AND a.type = 'name'
                                    WHERE e.state = 'active' AND (e.name LIKE @like ESCAPE '\\' OR a.norm LIKE @nlike ESCAPE '\\')
                                    ORDER BY e.name COLLATE NOCASE LIMIT @limit`),
        alias: db.prepare('SELECT * FROM review_entity_aliases WHERE id = ?'),
        aliasesOf: db.prepare('SELECT * FROM review_entity_aliases WHERE entity_id = ? AND removed_at IS NULL ORDER BY type, norm'),
        strongAlias: db.prepare("SELECT * FROM review_entity_aliases WHERE type = ? AND norm = ? AND removed_at IS NULL AND type != 'name'"),
        nameAliases: db.prepare("SELECT * FROM review_entity_aliases WHERE type = 'name' AND norm = ? AND removed_at IS NULL"),
        insertAlias: db.prepare(`INSERT INTO review_entity_aliases (id, entity_id, type, value, norm, created_by, created_at) VALUES (@id, @entity_id, @type, @value, @norm, @by, @now)`),
        removeAlias: db.prepare('UPDATE review_entity_aliases SET removed_at = ?, removed_by = ? WHERE id = ? AND removed_at IS NULL'),
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
        insertCitation: db.prepare('INSERT OR IGNORE INTO review_summary_citations (summary_id, revision, point, signal_id) VALUES (?, ?, ?, ?)'),
        citationsOf: db.prepare('SELECT * FROM review_summary_citations WHERE summary_id = ? AND revision = ? ORDER BY point, signal_id'),
        summariesCiting: db.prepare('SELECT DISTINCT summary_id FROM review_summary_citations WHERE signal_id = ?'),
        flaggedSummaries: db.prepare('SELECT * FROM review_summaries WHERE flagged = 1 ORDER BY flagged_at DESC LIMIT 200'),
        allSummaries: db.prepare('SELECT * FROM review_summaries ORDER BY updated_at DESC LIMIT 500'),
        publishedSummaries: db.prepare("SELECT * FROM review_summaries WHERE state = 'published' ORDER BY revision_published_at DESC LIMIT ?"),
        correction: db.prepare('SELECT * FROM review_corrections WHERE id = ?'),
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
    const tx = (fn) => db.transaction(fn)();
    const entityPath = (e) => `/e/${encodeURIComponent(e.slug)}`;
    const entityUrl = (e) => seo.canonicalUrl(origin, entityPath(e));
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
    function audit(actor, action, entityId, target, detail = {}) {
        q.audit.run(now(), typeof actor === 'string' ? actor : actorId(actor), action, entityId || null, target || null, JSON.stringify(detail));
    }
    function emit(envelope) { return outbox.enqueue(envelope); }

    function entityOrFail(ref) {
        const s = String(ref == null ? '' : ref);
        const e = ENTITY_ID_RE.test(s) ? q.entity.get(s) : q.entityBySlug.get(s);
        if (!e) fail(404, 'entity.not_found', 'No such entity');
        return e;
    }

    /** The entity a merged entity now lives under (follows merged_into). */
    function canonicalOf(entityId) {
        let e = q.entity.get(entityId);
        const seen = new Set();
        while (e && e.state === 'merged' && e.merged_into && !seen.has(e.id)) { seen.add(e.id); e = q.entity.get(e.merged_into); }
        return e ? e.id : null;
    }

    /** The entity and every entity merged into it, transitively. */
    function closure(entityId) {
        const out = new Set([entityId]);
        const stack = [entityId];
        while (stack.length) {
            const id = stack.pop();
            for (const r of q.mergedInto.all(id)) if (!out.has(r.id)) { out.add(r.id); stack.push(r.id); }
        }
        return out;
    }

    function activeSignalsIn(ids) {
        const out = [];
        for (const id of ids) out.push(...q.activeSignalsOfEntity.all(id));
        return out.sort((a, b) => (a.observed_at < b.observed_at ? 1 : a.observed_at > b.observed_at ? -1 : (a.id < b.id ? 1 : -1)));
    }
    function allSignalsIn(ids) {
        const out = [];
        for (const id of ids) out.push(...q.signalsOfEntity.all(id));
        return out.sort((a, b) => (a.observed_at < b.observed_at ? 1 : a.observed_at > b.observed_at ? -1 : (a.id < b.id ? 1 : -1)));
    }

    // ── Aggregates ───────────────────────────────────────────
    function exclusions() {
        return {
            sources: new Map(q.excludedSources.all().map((r) => [r.scope_id, r.note])),
            signals: new Map(q.excludedSignals.all().map((r) => [r.scope_id, r.note])),
        };
    }

    function computeFor(canonicalId) {
        return computeAggregate(activeSignalsIn(closure(canonicalId)), { exclusions: exclusions() });
    }

    /**
     * Records the next aggregate revision of the canonical entity when the result changed. A change
     * to nothing (every signal gone) is recorded as a revision whose result is null; an entity
     * that never had a qualifying signal has no aggregate row at all.
     */
    function refreshAggregate(entityId, trigger) {
        const canon = canonicalOf(entityId);
        const e = canon && q.entity.get(canon);
        if (!e || e.state !== 'active') return null;
        const result = computeFor(canon);
        const hash = hashOf(result);
        const last = q.lastAggregate.get(canon);
        if (last && last.inputs_hash === hash) return last;
        if (!last && result === null) return null;
        const revision = last ? last.revision + 1 : 1;
        q.insertAggregate.run(canon, revision, now(), String(trigger).slice(0, 60), hash, result ? JSON.stringify(result) : null);
        return q.lastAggregate.get(canon);
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
    function citationState(canonicalId, rev) {
        const members = closure(canonicalId);
        return summaryPoints(rev).map((p) => {
            const cites = p.signals.map((id) => {
                const s = q.signal.get(id);
                const ok = !!(s && s.status === 'active' && members.has(s.entity_id));
                return { signal_id: id, ok, status: s ? s.status : 'missing', in_entity: !!(s && members.has(s.entity_id)), superseded_by: s ? s.superseded_by : null };
            });
            return { ...p, cites, supported: cites.some((c) => c.ok) };
        });
    }

    function unsupportedCount(canonicalId, rev) {
        return citationState(canonicalId, rev).filter((p) => !p.supported).length;
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
    function checkSummaryInput(canonicalId, input, { ai = false } = {}) {
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
        const members = closure(canonicalId);
        for (const id of [...overviewSignals, ...pros.flatMap((p) => p.signals), ...cons.flatMap((p) => p.signals)]) {
            if (!SIGNAL_ID_RE.test(id)) fail(422, 'summary.invalid_citation', `${id} is not a signal id`);
            const s = q.signal.get(id);
            if (!s || !members.has(s.entity_id)) fail(422, 'summary.invalid_citation', `Signal ${id} does not belong to this entity`);
            if (s.status !== 'active') fail(422, 'summary.invalid_citation', `Signal ${id} is ${s.status}; cite the current signal`);
        }
        return { content: overview, fields: { pros, cons, overview_signals: overviewSignals } };
    }

    function ensureSummary(entityId) {
        let s = q.summary.get(entityId);
        if (!s) {
            const t = now();
            q.insertSummary.run(`sum_${ulid(t)}`, entityId, t, t);
            s = q.summary.get(entityId);
        }
        return s;
    }

    function writeCitations(summary, rev) {
        for (const p of summaryPoints(rev)) for (const id of p.signals) q.insertCitation.run(summary.id, rev.number, p.key, id);
    }

    function expectedOf(input, head) {
        if (input.expected_revision != null && input.expected_revision !== '') return Number(input.expected_revision);
        if (input.expectedRevision != null && input.expectedRevision !== '') return Number(input.expectedRevision);
        return head;
    }

    function createRevision(args) {
        try {
            return revisions.create(args).revision;
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
    function correctSummary(e, input, { note, requestId = null, resolutionNote = null }, actor, who) {
        const text = checkCorrectionNote(note);
        const summary = q.summary.get(e.id);
        if (!summary || summary.state !== 'published' || !summary.published_revision) fail(409, 'summary.not_published', 'Only a published summary is corrected; save and publish a revision instead');
        let request = null;
        if (requestId != null && String(requestId).trim() !== '') {
            request = q.correction.get(String(requestId).trim());
            if (!request) fail(404, 'correction.not_found', 'No such correction');
            if (canonicalOf(request.entity_id) !== e.id) fail(409, 'correction.other_entity', 'That correction is about another entity');
            if (request.status !== 'open') fail(409, 'correction.closed', `Already ${request.status}`);
        }
        const pub = revisions.get(summary.id, summary.published_revision);
        const body = checkSummaryInput(e.id, BODY_KEYS.some((k) => input[k] !== undefined) ? input : carryForward(pub));
        const revision = createRevision({
            entityId: summary.id, expectedRevision: expectedOf(input, revisions.headNumber(summary.id)), content: body.content, fields: body.fields,
            meta: {
                authorship: correctionAuthorship(pub.meta && pub.meta.authorship, who),
                correction: { note: text, request: request ? request.id : null, corrects: pub.number },
            },
            author: who, message: input.message ? String(input.message).slice(0, 500) : `Correction: ${text.slice(0, 200)}`, allowUnchanged: true,
        });
        writeCitations(summary, revision);
        reviews.record({ entityId: summary.id, revision: revision.number, reviewer: who, decision: 'approved', note: 'correction' });
        if (request) {
            q.resolveCorrection.run('accepted', who, resolutionNote, now(), request.id);
            audit(actor, 'correction.accepted', e.id, request.id, { note: resolutionNote, summary_revision: revision.number });
        }
        audit(actor, 'summary.corrected', e.id, summary.id, { revision: revision.number, corrects: pub.number, correction_id: request ? request.id : null });
        svc.publishSummary(e.id, { revision: revision.number }, actor);
        const fresh = q.summary.get(e.id);
        return { summary: fresh, revision: summaryRevisionView(fresh, revisions.get(summary.id, revision.number), e.id), published: true, correction: request ? q.correction.get(request.id) : null };
    }

    function revisionStatus(summary, rev) {
        const review = reviews.latest(summary.id, rev.number);
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
    function publicRevision(summary, rev) {
        if (!summary || summary.state !== 'published' || !summary.published_revision || rev.number > summary.published_revision) return false;
        const review = reviews.latest(summary.id, rev.number);
        if (review && review.decision === 'rejected') return false;
        const rec = rev.meta && rev.meta.authorship;
        return !(rec && !authorship.canPublish(rec, review).ok);
    }

    function pendingRevisions(summary) {
        const head = revisions.headNumber(summary.id);
        const out = [];
        for (let n = (summary.published_revision || 0) + 1; n <= head; n++) {
            const rev = revisions.get(summary.id, n);
            const st = revisionStatus(summary, rev);
            if (st !== 'rejected') out.push({ rev, status: st });
        }
        return out;
    }

    // ── The gate, the Search document ────────────────────────
    function publishedSummaryRevision(entityId) {
        const s = q.summary.get(entityId);
        if (!s || s.state !== 'published' || !s.published_revision) return { summary: s || null, rev: null };
        return { summary: s, rev: revisions.get(s.id, s.published_revision) };
    }

    function gateFacts(e) {
        const members = closure(e.id);
        const active = activeSignalsIn(members);
        const { summary, rev } = publishedSummaryRevision(e.id);
        const rec = rev && rev.meta && rev.meta.authorship;
        return {
            state: e.state === 'deleted' ? 'deleted' : 'published',
            visibility: 'public',
            canonicalUrl: entityUrl(e),
            wordCount: rev ? ssr.wordCount(summaryText(rev)) : 0,
            citationCount: active.length,
            unsupportedClaims: rev ? unsupportedCount(e.id, rev) : 0,
            noindex: !!e.noindex,
            ...(rec ? authorship.gateFacts(rec, reviews.latest(summary.id, rev.number)) : {}),
        };
    }

    function decide(e) {
        return seo.evaluate(gateFacts(e), { policy, now: now() });
    }

    /** Sends Search the entity's current document (or a tombstone) when it differs from the last one. */
    function syncEntity(entityId) {
        const e = q.entity.get(entityId);
        if (!e) return null;
        const live = e.state === 'active';
        const decision = live ? decide(e) : null;
        const before = sequencer.current('reviews', 'entity', e.id);
        const { rev } = live ? publishedSummaryRevision(e.id) : { rev: null };
        const agg = live ? aggregateView(q.lastAggregate.get(e.id)) : null;
        const signals = live ? activeSignalsIn(closure(e.id)) : [];
        const lines = [];
        if (agg && agg.result) lines.push(...agg.result.computation);
        const doc = sequencer.stamp(hooks.buildIndexDocument({
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
        }));
        if (doc.revision !== before) emit(hooks.indexEvent({ document: doc, now: now() }));
        return doc;
    }

    function touchEntity(entityId) {
        db.prepare('UPDATE review_entities SET updated_at = ? WHERE id = ?').run(now(), entityId);
    }

    // Inside batch() (a sync page, an alias that settles many items) the aggregate of each touched
    // entity is recomputed once at the end: one editorial action or one Sources page → at most one
    // new aggregate revision per entity.
    let batchDepth = 0;
    const dirty = new Map();
    function flushEntity(canon, trigger) {
        refreshAggregate(canon, trigger);
        touchEntity(canon);
        syncEntity(canon);
    }
    function batch(fn) {
        return tx(() => {
            batchDepth++;
            try {
                return fn();
            } finally {
                batchDepth--;
                if (batchDepth === 0) {
                    const list = [...dirty];
                    dirty.clear();
                    for (const [canon, trigger] of list) flushEntity(canon, trigger);
                }
            }
        });
    }

    /** After signals of an entity changed: next aggregate revision, Search document. */
    function afterSignalChange(entityId, trigger) {
        const canon = canonicalOf(entityId);
        if (!canon) return;
        if (batchDepth > 0) { if (!dirty.has(canon)) dirty.set(canon, trigger); return; }
        flushEntity(canon, trigger);
    }

    // ── Events ───────────────────────────────────────────────
    function signalPayload(s) {
        const p = {
            signal_id: s.id, entity_id: s.entity_id, canonical_entity_id: canonicalOf(s.entity_id), type: s.type,
            source_key: s.source_key, source_item_id: s.source_item_id, item_revision: s.item_revision,
            observed_at: s.observed_at, source_published_at: s.source_published_at, canonical_url: s.canonical_url, license_note: s.license_note,
        };
        if (s.type === 'recommendation') p.recommended = s.recommended === 1;
        if (s.type === 'recommendation_tally') { p.positive_count = s.positive_count; p.total_count = s.total_count; }
        if (s.type === 'rating' || s.type === 'rating_aggregate') { p.rating_value = s.rating_value; p.rating_best = s.rating_best; p.rating_worst = s.rating_worst; p.rating_count = s.rating_count; }
        return p;
    }
    function signalEvent(type, s, actor, extra = {}) {
        emit({
            event_type: type,
            actor: hooks.subjectRef(actorId(actor)),
            subject: { type: 'signal', id: s.id },
            visibility: 'public',
            payload: { ...signalPayload(s), ...extra },
        });
    }
    function entityEvent(type, e, actor, payload) {
        emit({ event_type: type, actor: hooks.subjectRef(actorId(actor)), subject: { type: 'entity', id: e.id }, visibility: 'public', payload });
    }

    // ── Summary flags when cited signals leave ───────────────
    /**
     * A summary whose current revision cites a signal that is no longer active (withdrawn by its
     * source, replaced by a newer revision of the item, or outside the entity after a split) gets a
     * flag and a pending revision: citations of replaced signals move to their replacement, points
     * left without a live citation are dropped. The pending revision is published only after an
     * editor approves it; until then the published text stays up with the flag shown next to it.
     */
    function flagSummary(summaryId, reason, signalIds) {
        const s = q.summaryById.get(summaryId);
        if (!s) return null;
        const canon = canonicalOf(s.entity_id);
        const e = q.entity.get(s.entity_id);
        if (!e || e.state !== 'active') return null;
        const headN = revisions.headNumber(s.id);
        if (!headN) return null;
        const head = revisions.get(s.id, headN);
        const base = s.published_revision && !(headN > s.published_revision && head.meta && head.meta.system)
            ? revisions.get(s.id, s.published_revision) : head;
        const state = citationState(canon, base);
        if (state.every((p) => p.cites.every((c) => c.ok))) return null;
        const members = closure(canon);
        const carry = (id) => {
            let sig = q.signal.get(id);
            const seen = new Set();
            while (sig && sig.status === 'superseded' && sig.superseded_by && !seen.has(sig.id)) { seen.add(sig.id); sig = q.signal.get(sig.superseded_by); }
            return sig && sig.status === 'active' && members.has(sig.entity_id) ? sig.id : null;
        };
        const mapPoints = (list) => (list || []).map((p) => ({ text: p.text, signals: [...new Set(p.signals.map(carry).filter(Boolean))] }));
        const f = base.fields || {};
        const pros = mapPoints(f.pros);
        const cons = mapPoints(f.cons);
        const overviewSignals = [...new Set((f.overview_signals || []).map(carry).filter(Boolean))];
        const dropped = [...pros, ...cons].filter((p) => !p.signals.length).map((p) => p.text);
        const t = now();
        q.flagSummary.run(String(reason).slice(0, 300), t, t, s.id);
        const { revision } = revisions.create({
            entityId: s.id, expectedRevision: headN, content: base.content,
            fields: { pros: pros.filter((p) => p.signals.length), cons: cons.filter((p) => p.signals.length), overview_signals: overviewSignals },
            meta: { ...(base.meta && base.meta.authorship ? { authorship: base.meta.authorship } : {}), system: { reason: String(reason).slice(0, 300), signals: signalIds, base_revision: base.number, dropped_points: dropped } },
            author: 'svc:reviews', message: `Pending: ${reason}`, allowUnchanged: true,
        });
        writeCitations(s, revision);
        audit('svc:reviews', 'summary.flagged', s.entity_id, s.id, { reason, signals: signalIds, pending_revision: revision.number, dropped_points: dropped.length });
        syncEntity(canon);
        return revision;
    }

    function flagSummariesCiting(signalIds, reason) {
        const ids = new Set();
        for (const sid of signalIds) for (const r of q.summariesCiting.all(sid)) ids.add(r.summary_id);
        for (const id of ids) flagSummary(id, reason, signalIds);
    }

    // ── Signals ──────────────────────────────────────────────
    function withdrawSignal(sig, reason, actor, { status = 'withdrawn', supersededBy = null } = {}) {
        const r = q.setSignalStatus.run({ id: sig.id, status, reason: String(reason).slice(0, 500), at: now(), superseded_by: supersededBy });
        if (!r.changes) return false;
        signalEvent('reviews.signal.removed', q.signal.get(sig.id), actor, { status, reason: String(reason).slice(0, 500), ...(supersededBy ? { replaced_by: supersededBy } : {}) });
        return true;
    }

    /** A new signal for an item revision; the item's previous active signal is superseded. */
    function createSignal(itemRow, entityId, sig, actor) {
        const prev = q.activeSignalOfItem.get(itemRow.id);
        if (prev && prev.item_revision === itemRow.item_revision && prev.entity_id === entityId) return { signal: prev, created: false };
        const t = now();
        const id = `sig_${ulid(t)}`;
        if (prev) {
            const why = prev.entity_id !== entityId ? 'reattributed by an editor' : `source item revised (r${prev.item_revision} → r${itemRow.item_revision})`;
            withdrawSignal(prev, why, actor, prev.entity_id !== entityId ? {} : { status: 'superseded', supersededBy: id });
        }
        q.insertSignal.run({
            id, entity_id: entityId, source_item_id: itemRow.id, source_key: itemRow.source_key, item_revision: itemRow.item_revision,
            type: sig.type, recommended: sig.recommended == null ? null : sig.recommended,
            positive_count: sig.positive_count == null ? null : sig.positive_count, total_count: sig.total_count == null ? null : sig.total_count,
            rating_value: sig.rating_value == null ? null : sig.rating_value, rating_best: sig.rating_best == null ? null : sig.rating_best,
            rating_worst: sig.rating_worst == null ? null : sig.rating_worst, rating_count: sig.rating_count == null ? null : sig.rating_count,
            observed_at: itemRow.retrieved_at, source_published_at: itemRow.published_at, canonical_url: itemRow.canonical_url,
            license_note: itemRow.license_note, trust: JSON.stringify(sig.trust || {}), created_by: actorId(actor), now: t,
        });
        const signal = q.signal.get(id);
        signalEvent('reviews.signal.added', signal, actor, prev ? { replaces: prev.id } : {});
        if (prev) {
            flagSummariesCiting([prev.id], prev.entity_id !== entityId ? 'A cited signal was reattributed to another entity' : 'A cited signal was replaced by a newer revision of its source item');
            if (canonicalOf(prev.entity_id) !== canonicalOf(entityId)) afterSignalChange(prev.entity_id, 'signal_reattributed');
        }
        afterSignalChange(entityId, prev ? 'signal_replaced' : 'signal_added');
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
    function resolveIdentifiers({ strong = [], names = [] }) {
        const hits = [];
        for (const id of strong) {
            const n = norm.tryAlias(id.type, id.value);
            if (!n) continue;
            const a = q.strongAlias.get(id.type, n);
            if (a) {
                const e = q.entity.get(a.entity_id);
                if (e && e.state !== 'deleted') hits.push({ rule: id.type, alias_id: a.id, entity_id: a.entity_id, canonical: canonicalOf(a.entity_id) });
            }
        }
        const canon = [...new Set(hits.map((h) => h.canonical))];
        if (canon.length === 1) return { resolution: 'resolved', entity_id: hits[0].entity_id, rule: hits.map((h) => h.rule).join('+'), candidates: [] };
        if (canon.length > 1) return { resolution: 'ambiguous', entity_id: null, rule: 'conflicting_identifiers', candidates: hits.map((h) => ({ entity_id: h.canonical, rule: h.rule })) };
        const named = [];
        for (const name of names) {
            const n = norm.tryAlias('name', name);
            if (!n) continue;
            for (const a of q.nameAliases.all(n)) {
                const c = canonicalOf(a.entity_id);
                const e = c && q.entity.get(c);
                if (e && e.state === 'active' && !named.some((x) => x.entity_id === c)) named.push({ entity_id: c, rule: 'name' });
            }
        }
        if (named.length) return { resolution: 'ambiguous', entity_id: null, rule: 'name_only', candidates: named };
        return { resolution: 'unmatched', entity_id: null, rule: null, candidates: [] };
    }

    function itemIdentifiers(row) {
        return extract.identifiers({ source_key: row.source_key, canonical_url: row.canonical_url, kind: row.kind, title: row.title, fields: parse(row.fields, {}) });
    }

    function setItemResolution(row, r, by) {
        q.setResolution.run({ id: row.id, resolution: r.resolution, entity_id: r.entity_id, rule: r.rule, candidates: JSON.stringify(r.candidates || []), by, at: r.resolution === 'resolved' ? now() : null, now: now() });
        return q.item.get(row.id);
    }

    /** Create/replace/withdraw the item's signal to match its current content and resolution. */
    function reconcileItemSignal(row, actor) {
        const active = q.activeSignalOfItem.get(row.id);
        if (row.state !== 'active' || row.resolution !== 'resolved') {
            if (active) {
                withdrawSignal(active, row.state !== 'active' ? `removed by its source: ${row.removed_reason || 'no reason given'}` : 'the item is no longer attributed to this entity', actor);
                flagSummariesCiting([active.id], row.state !== 'active' ? 'A cited signal was withdrawn: its source removed the item' : 'A cited signal was withdrawn');
                afterSignalChange(active.entity_id, 'signal_withdrawn');
            }
            return { signal: null };
        }
        const { signal } = extract.extractSignal({ kind: row.kind, fields: parse(row.fields, {}) });
        if (!signal) {
            if (active) {
                withdrawSignal(active, `the source no longer states a signal (${row.signal_note || 'no value'})`, actor);
                flagSummariesCiting([active.id], 'A cited signal was withdrawn: its source no longer states it');
                afterSignalChange(active.entity_id, 'signal_withdrawn');
            }
            return { signal: null };
        }
        return createSignal(row, row.entity_id, signal, actor);
    }

    function upsertSource(key, prov, info) {
        const t = now();
        const existing = q.source.get(key);
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
        if (existing) q.updateSource.run(values); else q.insertSource.run(values);
        return q.source.get(key);
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

    /**
     * Apply one Sources item (sources.item@1). Idempotent: the same item revision twice changes
     * nothing but the last-seen time. Synchronous (runs inside the caller's transaction).
     * → { outcome, item, signal }
     */
    function applyItem(item, { sourceInfo = null, actor = { kind: 'system', service: 'svc:reviews' } } = {}) {
        checkItem(item);
        if (item.category && item.category !== 'reviews') return { outcome: 'ignored:category', item: null, signal: null };
        const prov = item.provenance;
        const t = now();
        return tx(() => {
            upsertSource(item.source_key, prov, sourceInfo);
            let row = q.item.get(item.id);
            const retrievedAt = new Date(prov.retrieved_at).toISOString();
            if (item.removed) {
                const reason = String((item.removed && item.removed.reason) || 'removed').slice(0, 500);
                if (!row) {
                    // Known only as removed: kept for the record, never a signal.
                    const fields = extract.keptFields(item);
                    q.insertItem.run({
                        id: item.id, source_key: item.source_key, kind: String(item.kind || 'unknown').slice(0, 40), identity: String(item.identity || item.id).slice(0, 2048),
                        canonical_url: item.canonical_url || null, title: extract.keptTitle(item), item_revision: item.revision, content_hash: prov.content_hash,
                        published_at: item.published_at || null, retrieved_at: retrievedAt, parser_version: prov.parser_version || null,
                        license_note: prov.license_note || null, terms_note: prov.terms_note || null, fields: JSON.stringify(fields),
                        state: 'removed', removed_at: item.removed.at || retrievedAt, removed_reason: reason, resolution: 'unmatched', entity_id: null,
                        resolution_rule: null, candidates: '[]', resolved_by: null, resolved_at: null, signal_note: 'removed by its source before Reviews read it', now: t,
                    });
                    return { outcome: 'removed:unknown', item: q.item.get(item.id), signal: null };
                }
                if (row.state === 'removed') return { outcome: 'unchanged', item: row, signal: null };
                q.removeItem.run(item.removed.at || retrievedAt, reason, t, row.id);
                row = q.item.get(row.id);
                reconcileItemSignal(row, actor);
                return { outcome: 'removed', item: row, signal: null };
            }
            if (row && row.state === 'removed') return { outcome: 'ignored:removed', item: row, signal: null };
            if (row && item.revision < row.item_revision) return { outcome: 'ignored:older_revision', item: row, signal: null };
            if (row && item.revision === row.item_revision && row.content_hash === prov.content_hash) {
                q.touchItem.run(retrievedAt, t, row.id, retrievedAt);
                return { outcome: 'unchanged', item: q.item.get(row.id), signal: q.activeSignalOfItem.get(row.id) || null };
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
                q.insertItem.run({ ...values, state: 'active', removed_at: null, removed_reason: null, resolution: 'unmatched', entity_id: null, resolution_rule: null, candidates: '[]', resolved_by: null, resolved_at: null });
                outcome = 'created';
            } else {
                q.updateItemContent.run(values);
                outcome = 'updated';
            }
            row = q.item.get(item.id);
            if (row.resolution === 'unmatched' || row.resolution === 'ambiguous') row = setItemResolution(row, resolveIdentifiers(itemIdentifiers(row)), 'rule');
            const out = reconcileItemSignal(row, actor);
            return { outcome, item: q.item.get(item.id), signal: out.signal || null };
        });
    }

    /** New aliases may settle items that waited: re-run the rules for every unresolved item. */
    function reresolvePending(actor) {
        return batch(() => {
            let settled = 0;
            for (const row of q.unresolvedItems.all()) {
                const r = resolveIdentifiers(itemIdentifiers(row));
                if (r.resolution === row.resolution && JSON.stringify(r.candidates) === row.candidates) continue;
                const fresh = setItemResolution(row, r, 'rule');
                if (fresh.resolution === 'resolved') { reconcileItemSignal(fresh, actor); settled++; }
            }
            return settled;
        });
    }

    // ── Entities ─────────────────────────────────────────────
    function uniqueSlug(base) {
        const root = norm.slug(base) || 'entity';
        let s = root;
        for (let i = 2; q.entityBySlug.get(s) || redirects.resolve(`/e/${s}`, { currentPath: () => null }); i++) s = `${root}-${i}`.slice(0, 90);
        return s;
    }

    function checkName(name) {
        const t = String(name == null ? '' : name).replace(/\s+/g, ' ').trim();
        if (!t) fail(422, 'entity.invalid_name', 'An entity needs a name');
        if (t.length > 200) fail(422, 'entity.invalid_name', 'A name is at most 200 characters');
        norm.alias('name', t);
        return t;
    }

    function insertAlias(entityId, type, value, actor) {
        if (!ALIAS_TYPES.includes(type)) fail(422, 'alias.invalid', `alias type is one of ${ALIAS_TYPES.join(', ')}`);
        let n;
        try { n = norm.alias(type, value); } catch (err) { fail(422, 'alias.invalid', err.message); }
        if (type !== 'name') {
            const taken = q.strongAlias.get(type, n);
            if (taken) {
                if (taken.entity_id === entityId) return taken;
                const other = q.entity.get(taken.entity_id);
                fail(409, 'alias.taken', `${type} ${value} already identifies "${other ? other.name : taken.entity_id}"`, { entity_id: taken.entity_id });
            }
        } else if (q.nameAliases.all(n).some((a) => a.entity_id === entityId)) {
            return q.nameAliases.all(n).find((a) => a.entity_id === entityId);
        }
        const t = now();
        const id = `als_${ulid(t)}`;
        q.insertAlias.run({ id, entity_id: entityId, type, value: String(value).trim().slice(0, 1000), norm: n, by: actorId(actor), now: t });
        return q.alias.get(id);
    }

    function entityView(e) {
        return {
            id: e.id, slug: e.slug, name: e.name, kind: e.kind, description: e.description, state: e.state,
            merged_into: e.merged_into, canonical_id: canonicalOf(e.id), noindex: !!e.noindex,
            url: entityUrl(e), created_at: toIso(e.created_at), updated_at: toIso(e.updated_at),
        };
    }

    function trustMap(scope, id) {
        const out = {};
        for (const r of q.trustCurrent.all(scope, id)) out[r.key] = { value: r.value, note: r.note, set_at: toIso(r.set_at) };
        return out;
    }

    function signalView(s) {
        const item = q.item.get(s.source_item_id);
        const src = q.source.get(s.source_key);
        return {
            ...signalPayload(s), status: s.status, status_reason: s.status_reason, status_at: toIso(s.status_at), superseded_by: s.superseded_by,
            trust: parse(s.trust, {}), editor_trust: trustMap('signal', s.id), created_at: toIso(s.created_at),
            provenance: {
                source_key: s.source_key, source_name: src ? src.name : null, source_homepage: src ? src.homepage_url : null,
                source_item_id: s.source_item_id, item_revision: s.item_revision, item_kind: item ? item.kind : null,
                retrieved_at: s.observed_at, last_seen_at: item ? item.retrieved_at : null,
                canonical_url: s.canonical_url, license_note: s.license_note, terms_note: item ? item.terms_note : (src ? src.terms_note : null),
                item_state: item ? item.state : null, item_removed_reason: item ? item.removed_reason : null,
            },
        };
    }

    function summaryRevisionView(summary, rev, canonicalId) {
        if (!rev) return null;
        const rec = rev.meta && rev.meta.authorship;
        const review = reviews.latest(summary.id, rev.number);
        return {
            number: rev.number, status: revisionStatus(summary, rev), overview: rev.content,
            points: citationState(canonicalId, rev).map((p) => ({ key: p.key, kind: p.kind, text: p.kind === 'overview' ? null : p.text, supported: p.supported, citations: p.cites })),
            authorship: rec ? { mode: rec.mode, workflow: rec.workflow || null, stub_provider: !!rec.stubProvider } : null,
            disclosure: rec ? authorship.disclosure(rec, review) : null,
            review: review ? { decision: review.decision, reviewed_at: review.reviewedAt } : null,
            system: rev.meta && rev.meta.system ? rev.meta.system : null,
            correction: correctionView(rev),
            author: rev.author, message: rev.message, created_at: rev.createdAt,
        };
    }

    /** The public side of a correction: the note, which revision it corrects, and whether a reader asked for it. */
    function correctionView(rev) {
        const c = rev && rev.meta && rev.meta.correction;
        return c ? { note: c.note, corrects: c.corrects, requested: !!c.request } : null;
    }

    /** The summary's history as readers may see it, newest first (entity page). */
    function publicHistory(summary) {
        if (!summary) return [];
        return revisions.list(summary.id, { limit: 200 }).filter((r) => publicRevision(summary, r)).map((r) => {
            const d = r.meta && r.meta.authorship ? authorship.disclosure(r.meta.authorship, reviews.latest(summary.id, r.number)) : null;
            return { number: r.number, status: revisionStatus(summary, r), created_at: r.createdAt, disclosure: d ? d.short : null, correction: correctionView(r) };
        });
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
        findEntity(ref) { const s = String(ref || ''); return (ENTITY_ID_RE.test(s) ? q.entity.get(s) : q.entityBySlug.get(s)) || null; },
        entity(ref) { return entityOrFail(ref); },
        entityById(id) { return q.entity.get(id) || null; },
        resolveRedirect(path) {
            return redirects.resolve(path, { currentPath: (id) => { const e = q.entity.get(id); return e && e.state !== 'deleted' ? entityPath(e) : null; } });
        },
        listEntities({ limit = 50, offset = 0 } = {}) { return { entities: q.listActive.all(Math.min(200, limit), Math.max(0, offset)), total: q.countActive.get().n }; },
        search(text, { limit = 30 } = {}) {
            const s = String(text || '').trim().slice(0, 200);
            if (!s) return [];
            const esc = (x) => x.replace(/[\\%_]/g, (c) => `\\${c}`);
            const n = norm.tryAlias('name', s) || s.toLowerCase();
            return q.searchEntities.all({ like: `%${esc(s)}%`, nlike: `%${esc(n)}%`, limit: Math.min(100, limit) });
        },
        entityView,
        signalView,
        aggregateView,
        decide,
        gateFacts,

        /** Everything the entity page shows. `e` must be active (callers redirect merged entities). */
        page(e, actor) {
            const members = closure(e.id);
            const signals = allSignalsIn(members);
            const active = signals.filter((s) => s.status === 'active');
            const agg = aggregateView(q.lastAggregate.get(e.id));
            const summary = q.summary.get(e.id) || null;
            const pub = summary && summary.state === 'published' && summary.published_revision ? revisions.get(summary.id, summary.published_revision) : null;
            const sourceKeys = [...new Set(signals.map((s) => s.source_key))].sort();
            const editor = access.isEditor(actor);
            return {
                entity: entityView(e),
                aliases: q.aliasesOf.all(e.id).map((a) => ({ id: a.id, type: a.type, value: a.value })),
                merged_from: [...members].filter((id) => id !== e.id).map((id) => entityView(q.entity.get(id))),
                links: [...q.linksFrom.all(e.id), ...q.linksTo.all(e.id)].map((l) => ({
                    id: l.id, type: l.type, from: l.from_entity, to: l.to_entity, ref: parse(l.ref, null), note: l.note,
                    other: l.to_entity ? entityView(q.entity.get(l.from_entity === e.id ? l.to_entity : l.from_entity)) : null,
                    direction: l.from_entity === e.id ? 'out' : 'in', created_at: toIso(l.created_at),
                })),
                aggregate: agg && agg.result ? agg : null,
                aggregate_revision: agg ? agg.revision : null,
                signals: active.map(signalView),
                inactive_signals: signals.filter((s) => s.status !== 'active').map(signalView),
                sources: sourceKeys.map((k) => { const r = q.source.get(k); return { key: k, name: r && r.name, homepage_url: r && r.homepage_url, license_note: r && r.license_note, terms_note: r && r.terms_note, status: r && r.status, stale: r ? r.stale === 1 : null, last_success_at: r && r.last_success_at, trust: trustMap('source', k) }; }),
                entity_trust: trustMap('entity', e.id),
                summary: summary ? {
                    id: summary.id, state: summary.state, head_revision: revisions.headNumber(summary.id), flagged: !!summary.flagged, flag_reason: summary.flag_reason, flagged_at: toIso(summary.flagged_at),
                    published_at: toIso(summary.published_at), revision_published_at: toIso(summary.revision_published_at),
                    published: pub ? summaryRevisionView(summary, pub, e.id) : null,
                    pending: editor ? pendingRevisions(summary).map((p) => summaryRevisionView(summary, p.rev, e.id)) : pendingRevisions(summary).length,
                    history: publicHistory(summary),
                } : null,
                open_corrections: q.openCorrectionsOf.get(e.id).n,
                decision: decide(e),
                editor,
            };
        },

        history(e, actor) {
            const editor = access.isEditor(actor);
            if (e.state === 'deleted' && !editor) fail(410, 'entity.deleted', 'This entity was deleted');
            const summary = q.summary.get(e.id);
            const revs = summary ? revisions.list(summary.id, { limit: 200 }) : [];
            return {
                entity: entityView(e),
                aggregates: q.aggregates.all(e.id, 200).map(aggregateView),
                summary_revisions: summary ? revs.filter((r) => editor || publicRevision(summary, r))
                    .map((r) => summaryRevisionView(summary, r, e.id)) : [],
                merges: q.mergeLinksOf.all(e.id, e.id).map((l) => ({
                    id: l.id, from: entityView(q.entity.get(l.from_entity)), to: entityView(q.entity.get(l.to_entity)), note: l.note,
                    merged_at: toIso(l.created_at), merged_by: editor ? l.created_by : null, split_at: toIso(l.ended_at), split_by: editor ? l.ended_by : null, split_note: l.end_note,
                })),
                signals: allSignalsIn(closure(e.id)).map(signalView),
                audit: q.auditOf.all(e.id, e.id).map((r) => ({
                    id: r.id, at: toIso(r.at), action: r.action, target: editor || !/^correction\./.test(r.action) ? r.target : null,
                    actor: editor ? r.actor : (/^usr_/.test(r.actor) ? 'an editor' : r.actor), detail: auditDetail(r, editor),
                })),
            };
        },

        summaryRevision(e, n, actor) {
            if (e.state === 'deleted' && !access.isEditor(actor)) fail(410, 'entity.deleted', 'This entity was deleted');
            const summary = q.summary.get(e.id);
            if (!summary) fail(404, 'summary.not_found', 'This entity has no summary');
            const rev = revisions.get(summary.id, Number(n));
            if (!rev) fail(404, 'revision.not_found', `No revision ${n}`);
            const visible = access.isEditor(actor) || publicRevision(summary, rev);
            if (!visible) fail(404, 'revision.not_found', `No revision ${n}`);
            return summaryRevisionView(summary, rev, e.id);
        },

        // Resolve (reviews.entity.resolve) ---------------------------------------------------
        /** { name?, url?, sku?, gtin?, mpn?, source?, external? } → { match, entity, via, rule, candidates } */
        resolve(input = {}) {
            const strong = [];
            for (const t of ['source', 'external', 'url', 'gtin', 'sku', 'mpn']) if (input[t]) strong.push({ type: t, value: String(input[t]) });
            const names = input.name ? [String(input.name)] : [];
            if (!strong.length && !names.length) fail(422, 'resolve.empty', 'Give at least one of name, url, gtin, sku, mpn, source, external');
            const r = resolveIdentifiers({ strong, names });
            const canon = r.entity_id ? canonicalOf(r.entity_id) : null;
            return {
                match: r.resolution === 'resolved' ? 'exact' : r.resolution === 'ambiguous' ? 'ambiguous' : 'none',
                entity: canon ? entityView(q.entity.get(canon)) : null,
                via: r.entity_id && r.entity_id !== canon ? entityView(q.entity.get(r.entity_id)) : null,
                rule: r.rule,
                candidates: r.candidates.map((c) => ({ rule: c.rule, entity: entityView(q.entity.get(c.entity_id)) })),
            };
        },

        // Entities (editors) -----------------------------------------------------------------
        createEntity({ name, kind = 'other', description = null, slug = null, aliases = [] } = {}, actor) {
            requireEditor(actor, 'Creating an entity');
            const clean = checkName(name);
            if (!ENTITY_KINDS.includes(kind)) fail(422, 'entity.invalid_kind', `kind is one of ${ENTITY_KINDS.join(', ')}`);
            if (!Array.isArray(aliases)) fail(422, 'alias.invalid', 'aliases is a list of { type, value }');
            return tx(() => {
                const t = now();
                const id = `ent_${ulid(t)}`;
                const s = slug ? norm.slug(slug) : null;
                if (slug && !s) fail(422, 'entity.invalid_slug', 'That slug has no letters or digits');
                if (s && (q.entityBySlug.get(s))) fail(409, 'entity.slug_taken', `/e/${s} is taken`);
                const finalSlug = s || uniqueSlug(clean);
                redirects.release(`/e/${finalSlug}`);
                q.insertEntity.run({ id, slug: finalSlug, name: clean, kind, description: description ? String(description).trim().slice(0, 2000) || null : null, created_by: actorId(actor), now: t });
                insertAlias(id, 'name', clean, actor);
                for (const a of aliases) insertAlias(id, a && a.type, a && a.value, actor);
                audit(actor, 'entity.created', id, null, { name: clean, kind, aliases });
                const settled = reresolvePending(actor);
                syncEntity(id);
                return { entity: q.entity.get(id), settled_items: settled };
            });
        },

        updateEntity(ref, { name, kind, description, slug, noindex } = {}, actor) {
            requireEditorPerson(actor, 'Editing an entity');
            return tx(() => {
                const e = entityOrFail(ref);
                if (e.state !== 'active') fail(409, 'entity.not_active', `This entity is ${e.state}`);
                const next = { ...e };
                const changes = {};
                if (name != null && name !== e.name) { next.name = checkName(name); changes.name = [e.name, next.name]; insertAlias(e.id, 'name', next.name, actor); }
                if (kind != null && kind !== e.kind) { if (!ENTITY_KINDS.includes(kind)) fail(422, 'entity.invalid_kind', `kind is one of ${ENTITY_KINDS.join(', ')}`); next.kind = kind; changes.kind = [e.kind, kind]; }
                if (description !== undefined && (description || null) !== e.description) { next.description = description ? String(description).trim().slice(0, 2000) || null : null; changes.description = true; }
                if (noindex != null && !!noindex !== !!e.noindex) { next.noindex = noindex ? 1 : 0; changes.noindex = !!noindex; }
                if (slug != null && slug !== e.slug) {
                    const s = norm.slug(slug);
                    if (!s) fail(422, 'entity.invalid_slug', 'That slug has no letters or digits');
                    const other = q.entityBySlug.get(s);
                    if (other && other.id !== e.id) fail(409, 'entity.slug_taken', `/e/${s} is taken`);
                    redirects.recordMove(e.id, `/e/${e.slug}`, `/e/${s}`, { reason: 'renamed' });
                    next.slug = s; changes.slug = [e.slug, s];
                }
                db.prepare('UPDATE review_entities SET name = ?, kind = ?, description = ?, slug = ?, noindex = ?, updated_at = ? WHERE id = ?')
                    .run(next.name, next.kind, next.description, next.slug, next.noindex, now(), e.id);
                if (Object.keys(changes).length) audit(actor, 'entity.updated', e.id, null, changes);
                syncEntity(e.id);
                return q.entity.get(e.id);
            });
        },

        deleteEntity(ref, { note = null } = {}, actor) {
            requireEditorPerson(actor, 'Deleting an entity');
            return tx(() => {
                const e = entityOrFail(ref);
                if (e.state !== 'active') fail(409, 'entity.not_active', `This entity is ${e.state}`);
                if (q.mergedInto.all(e.id).length) fail(409, 'entity.has_merges', 'Split the entities merged into this one first');
                const active = q.activeSignalsOfEntity.all(e.id);
                if (active.length) fail(409, 'entity.has_signals', 'This entity has live signals: reattribute or ignore their items first');
                db.prepare("UPDATE review_entities SET state = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), e.id);
                audit(actor, 'entity.deleted', e.id, null, { note });
                syncEntity(e.id);
                return q.entity.get(e.id);
            });
        },

        addAlias(ref, { type, value } = {}, actor) {
            requireEditorPerson(actor, 'Adding an alias');
            return tx(() => {
                const e = entityOrFail(ref);
                if (e.state === 'deleted') fail(409, 'entity.not_active', 'This entity was deleted');
                const a = insertAlias(e.id, type, value, actor);
                audit(actor, 'alias.added', e.id, a.id, { type: a.type, value: a.value });
                const settled = reresolvePending(actor);
                return { alias: a, settled_items: settled };
            });
        },

        removeAlias(ref, aliasId, actor) {
            requireEditorPerson(actor, 'Removing an alias');
            return tx(() => {
                const e = entityOrFail(ref);
                const a = q.alias.get(String(aliasId));
                if (!a || a.entity_id !== e.id || a.removed_at) fail(404, 'alias.not_found', 'No such alias');
                q.removeAlias.run(now(), actorId(actor), a.id);
                audit(actor, 'alias.removed', e.id, a.id, { type: a.type, value: a.value });
                return q.alias.get(a.id);
            });
        },

        addLink(ref, { type, to = null, ref: entityRef = null, note = null } = {}, actor) {
            requireEditorPerson(actor, 'Linking entities');
            if (!LINK_TYPES.includes(type) || type === 'merged_into') fail(422, 'link.invalid', `type is one of ${LINK_TYPES.filter((t) => t !== 'merged_into').join(', ')} (merges go through merge)`);
            return tx(() => {
                const e = entityOrFail(ref);
                let target = null;
                let refJson = null;
                if (type === 'external_ref') {
                    const { entityRef: mk } = require('openvibe-publishing/discussion');
                    try { refJson = JSON.stringify(mk(entityRef || {})); } catch (err) { fail(422, 'link.invalid', err.message); }
                } else {
                    target = entityOrFail(to);
                    if (target.id === e.id) fail(422, 'link.invalid', 'An entity cannot link to itself');
                }
                const t = now();
                const id = `lnk_${ulid(t)}`;
                q.insertLink.run({ id, from: e.id, to: target ? target.id : null, type, ref: refJson, note: note ? String(note).slice(0, 500) : null, by: actorId(actor), now: t });
                audit(actor, 'link.added', e.id, id, { type, to: target ? target.id : null, ref: parse(refJson, null) });
                return q.link.get(id);
            });
        },

        endLink(ref, linkId, { note = null } = {}, actor) {
            requireEditorPerson(actor, 'Removing a link');
            return tx(() => {
                const e = entityOrFail(ref);
                const l = q.link.get(String(linkId));
                if (!l || (l.from_entity !== e.id && l.to_entity !== e.id) || l.ended_at || l.type === 'merged_into') fail(404, 'link.not_found', 'No such link (merges are undone with split)');
                q.endLink.run(now(), actorId(actor), note ? String(note).slice(0, 500) : null, l.id);
                audit(actor, 'link.ended', e.id, l.id, { type: l.type });
                return q.link.get(l.id);
            });
        },

        // Merge and split (reviews.entity.merge | reviews.entity.split) ----------------------
        /**
         * Merge `ref` into `into`. Nothing is rewritten: the merged entity keeps its aliases and its
         * signals keep their attribution; it becomes state `merged` with an active `merged_into`
         * link, and the target's aggregate is recomputed over both. That is why a split restores
         * the pre-merge attribution exactly.
         */
        merge(ref, { into, note = null } = {}, actor) {
            const who = requireEditorPerson(actor, 'Merging entities');
            return tx(() => {
                const src = entityOrFail(ref);
                const tgt = entityOrFail(into);
                if (src.id === tgt.id) fail(422, 'merge.same_entity', 'An entity cannot be merged into itself');
                if (src.state !== 'active') fail(409, 'merge.not_active', `"${src.name}" is ${src.state}`);
                if (tgt.state !== 'active') fail(409, 'merge.target_not_active', `"${tgt.name}" is ${tgt.state}${tgt.state === 'merged' ? `; merge into ${canonicalOf(tgt.id)} instead` : ''}`, { canonical_id: canonicalOf(tgt.id) });
                if (closure(src.id).has(tgt.id)) fail(409, 'merge.cycle', 'The target is merged into this entity');
                const t = now();
                const linkId = `lnk_${ulid(t)}`;
                const moved = activeSignalsIn(closure(src.id)).map((s) => s.id);
                q.insertLink.run({ id: linkId, from: src.id, to: tgt.id, type: 'merged_into', ref: null, note: note ? String(note).slice(0, 500) : null, by: who, now: t });
                db.prepare("UPDATE review_entities SET state = 'merged', merged_into = ?, updated_at = ? WHERE id = ?").run(tgt.id, t, src.id);
                audit(actor, 'entity.merged', src.id, tgt.id, {
                    link_id: linkId, into: tgt.id, note, signals: moved,
                    aliases: q.aliasesOf.all(src.id).map((a) => a.id),
                    merged_members: [...closure(src.id)].filter((id) => id !== src.id),
                });
                refreshAggregate(tgt.id, 'merge');
                touchEntity(tgt.id);
                syncEntity(src.id);
                syncEntity(tgt.id);
                entityEvent('reviews.entity.merged', src, actor, {
                    entity_id: src.id, into_entity_id: tgt.id, link_id: linkId, signal_count: moved.length,
                    url: entityUrl(src), into_url: entityUrl(tgt), note: note ? String(note).slice(0, 500) : null,
                });
                return { link: q.link.get(linkId), entity: q.entity.get(src.id), into: q.entity.get(tgt.id), signals: moved };
            });
        },

        split(ref, { note = null } = {}, actor) {
            const who = requireEditorPerson(actor, 'Splitting entities');
            return tx(() => {
                const src = entityOrFail(ref);
                if (src.state !== 'merged') fail(409, 'split.not_merged', `"${src.name}" is not merged into another entity`);
                const link = q.activeMerge.get(src.id);
                if (!link) fail(409, 'split.no_merge_link', 'No active merge link for this entity');
                const t = now();
                q.endLink.run(t, who, note ? String(note).slice(0, 500) : null, link.id);
                db.prepare("UPDATE review_entities SET state = 'active', merged_into = NULL, updated_at = ? WHERE id = ?").run(t, src.id);
                const restored = activeSignalsIn(closure(src.id)).map((s) => s.id);
                audit(actor, 'entity.split', src.id, link.to_entity, { link_id: link.id, from: link.to_entity, note, signals: restored });
                refreshAggregate(src.id, 'split');
                refreshAggregate(link.to_entity, 'split');
                // The former target's summary may cite signals that went back with the split.
                const tgtCanon = canonicalOf(link.to_entity);
                const tgtSummary = tgtCanon && q.summary.get(tgtCanon);
                if (tgtSummary) flagSummary(tgtSummary.id, 'Entities were split: a cited signal now belongs to another entity', restored);
                touchEntity(src.id);
                if (tgtCanon) touchEntity(tgtCanon);
                syncEntity(src.id);
                if (tgtCanon) syncEntity(tgtCanon);
                const from = q.entity.get(link.to_entity);
                entityEvent('reviews.entity.split', src, actor, {
                    entity_id: src.id, from_entity_id: link.to_entity, link_id: link.id, signal_count: restored.length,
                    url: entityUrl(q.entity.get(src.id)), from_url: from ? entityUrl(from) : null, note: note ? String(note).slice(0, 500) : null,
                });
                return { link: q.link.get(link.id), entity: q.entity.get(src.id), from: from, signals: restored };
            });
        },

        // Sources items and signals (reviews.signal.import) ----------------------------------
        applyItem,
        /** Run fn in one transaction; aggregates of touched entities are recomputed once at the end. */
        batch,
        /** Fetch one item from Sources and apply it. */
        async importItem(itemId, sources, actor) {
            const { item, source } = await sources.getItem(String(itemId || ''));
            let info = source || null;
            if (!q.source.get(item.source_key)) {
                try { const full = await sources.getSource(item.source_key); if (full) info = { ...full, ...(source || {}) }; } catch { /* the notes come with the item */ }
            }
            return applyItem(item, { sourceInfo: info, actor });
        },

        /** A source item removal we heard about (sources.item.removed event). */
        removeItem(itemId, reason, actor) {
            const row = q.item.get(String(itemId));
            if (!row) return { outcome: 'ignored:unknown_item' };
            if (row.state === 'removed') return { outcome: 'unchanged' };
            return tx(() => {
                q.removeItem.run(new Date(now()).toISOString(), String(reason || 'removed by its source').slice(0, 500), now(), row.id);
                reconcileItemSignal(q.item.get(row.id), actor);
                return { outcome: 'removed', item: q.item.get(row.id) };
            });
        },

        item(itemId) { return q.item.get(String(itemId)) || null; },
        itemView(row) {
            if (!row) return null;
            const fields = parse(row.fields, {});
            return {
                id: row.id, source_key: row.source_key, kind: row.kind, identity: row.identity, canonical_url: row.canonical_url, title: row.title,
                item_revision: row.item_revision, published_at: row.published_at, retrieved_at: row.retrieved_at, license_note: row.license_note, terms_note: row.terms_note,
                fields, state: row.state, removed_at: row.removed_at, removed_reason: row.removed_reason,
                resolution: row.resolution, entity_id: row.entity_id, resolution_rule: row.resolution_rule,
                candidates: parse(row.candidates, []).map((c) => ({ ...c, entity: q.entity.get(c.entity_id) ? entityView(q.entity.get(c.entity_id)) : null })),
                signal_note: row.signal_note, signal: (() => { const s = q.activeSignalOfItem.get(row.id); return s ? signalPayload(s) : null; })(),
            };
        },
        resolutionQueue(limit = 200) { return q.queueItems.all(Math.min(500, limit)); },

        /** An editor settles an item: attach it to an entity (optionally remember the identifier). */
        confirmResolution(itemId, { entity: entityRef, add_alias: addAlias = null } = {}, actor) {
            const who = requireEditorPerson(actor, 'Confirming a resolution');
            return tx(() => {
                const row = q.item.get(String(itemId));
                if (!row) fail(404, 'item.not_found', 'Reviews has not read that item');
                if (row.state !== 'active') fail(409, 'item.removed', 'Its source removed this item');
                const e = entityOrFail(entityRef);
                if (e.state !== 'active') fail(409, 'entity.not_active', `"${e.name}" is ${e.state}`);
                const before = { resolution: row.resolution, entity_id: row.entity_id };
                if (addAlias) {
                    const ids = itemIdentifiers(row);
                    const pick = addAlias === 'name' ? (ids.names[0] ? { type: 'name', value: ids.names[0] } : null) : ids.strong.find((x) => x.type === addAlias);
                    if (!pick) fail(422, 'alias.invalid', `The item has no ${addAlias} to remember`);
                    insertAlias(e.id, pick.type, pick.value, actor);
                }
                const fresh = setItemResolution(row, { resolution: 'resolved', entity_id: e.id, rule: 'editor', candidates: [] }, who);
                const out = reconcileItemSignal(fresh, actor);
                audit(actor, 'item.resolved', e.id, row.id, { before, rule: 'editor', add_alias: addAlias || null, signal: out.signal ? out.signal.id : null });
                const settled = addAlias ? reresolvePending(actor) : 0;
                return { item: q.item.get(row.id), signal: out.signal || null, settled_items: settled };
            });
        },

        ignoreItem(itemId, { note = null } = {}, actor) {
            requireEditorPerson(actor, 'Ignoring an item');
            return tx(() => {
                const row = q.item.get(String(itemId));
                if (!row) fail(404, 'item.not_found', 'Reviews has not read that item');
                const fresh = setItemResolution(row, { resolution: 'ignored', entity_id: null, rule: 'editor', candidates: [] }, actorId(actor));
                reconcileItemSignal(fresh, actor);
                audit(actor, 'item.ignored', row.entity_id, row.id, { note });
                return q.item.get(row.id);
            });
        },

        // Trust metadata --------------------------------------------------------------------
        setTrust({ scope, scope_id: scopeId, key, value, note = null } = {}, actor) {
            requireEditorPerson(actor, 'Trust decisions');
            if (!['source', 'signal', 'entity'].includes(scope)) fail(422, 'trust.invalid', 'scope is source, signal or entity');
            if (!TRUST_KEYS.includes(key)) fail(422, 'trust.invalid', `key is one of ${TRUST_KEYS.join(', ')}`);
            const v = value == null ? '' : String(value).trim().slice(0, 1000);
            if (key === 'aggregate' && !['include', 'exclude'].includes(v)) fail(422, 'trust.invalid', 'aggregate is include or exclude');
            if (key === 'aggregate' && v === 'exclude' && !String(note || '').trim()) fail(422, 'trust.reason_required', 'Excluding from the aggregate needs a reason readers can see');
            if (key === 'aggregate' && scope === 'entity') fail(422, 'trust.invalid', 'Exclude a source or a signal, not a whole entity');
            return tx(() => {
                let entityIds = [];
                if (scope === 'source') { if (!q.source.get(String(scopeId))) fail(404, 'source.not_found', 'Reviews has not seen that source'); entityIds = q.entitiesWithSourceSignals.all(String(scopeId)).map((r) => r.entity_id); }
                if (scope === 'signal') { const s = q.signal.get(String(scopeId)); if (!s) fail(404, 'signal.not_found', 'No such signal'); entityIds = [s.entity_id]; }
                if (scope === 'entity') { const e = entityOrFail(scopeId); scopeId = e.id; entityIds = [e.id]; }
                const cur = q.trustOne.get(scope, String(scopeId), key);
                const who = actorId(actor);
                if (cur) q.trustEnd.run(now(), who, cur.id);
                if (v && !(key === 'aggregate' && v === 'include')) q.trustInsert.run(scope, String(scopeId), key, v, note ? String(note).slice(0, 1000) : null, who, now());
                audit(actor, 'trust.set', scope === 'entity' ? scopeId : (entityIds.length === 1 ? canonicalOf(entityIds[0]) : null), `${scope}:${scopeId}`, { key, value: v, note, previous: cur ? { value: cur.value, note: cur.note } : null });
                const canon = [...new Set(entityIds.map(canonicalOf).filter(Boolean))];
                for (const id of canon) { refreshAggregate(id, 'trust'); touchEntity(id); syncEntity(id); }
                return { scope, scope_id: scopeId, key, current: q.trustOne.get(scope, String(scopeId), key) || null, affected_entities: canon };
            });
        },
        trustHistory(scope, id) { return q.trustHistory.all(scope, id); },
        trustMap,

        // Summaries (reviews.summary.publish | reviews.summary.propose) ----------------------
        /**
         * An editor writes a summary revision; publish: true publishes it at once. With a
         * correction_note (and optionally the correction_id of a reader's request it answers) the
         * revision corrects the published summary: it carries the note and is published at once.
         */
        writeSummary(ref, input = {}, actor) {
            const who = requireEditorPerson(actor, 'Writing a summary');
            return tx(() => {
                const e = entityOrFail(ref);
                if (e.state !== 'active') fail(409, 'entity.not_active', `This entity is ${e.state}`);
                if (wantsCorrection(input)) return correctSummary(e, input, { note: input.correction_note, requestId: input.correction_id }, actor, who);
                const body = checkSummaryInput(e.id, input);
                const summary = ensureSummary(e.id);
                const revision = createRevision({
                    entityId: summary.id, expectedRevision: expectedOf(input, revisions.headNumber(summary.id)), content: body.content, fields: body.fields,
                    meta: { authorship: authorship.record({ mode: 'human', authors: [who] }) }, author: who,
                    message: input.message ? String(input.message).slice(0, 500) : null, allowUnchanged: true,
                });
                writeCitations(summary, revision);
                audit(actor, 'summary.revision', e.id, summary.id, { revision: revision.number });
                let published = null;
                if (input.publish === true || input.publish === 'true' || input.publish === '1') published = svc.publishSummary(e.id, { revision: revision.number }, actor);
                return { summary: q.summary.get(e.id), revision: summaryRevisionView(q.summary.get(e.id), revision, e.id), published: !!published };
            });
        },

        /**
         * The OpenVibe.AI seam (workflow reviews.summarize_entity): a draft revision with ai
         * authorship (workflow + run id). Never published by this call, noindex until a person
         * approves it, and it can never state a rating: its text is checked, and summaries have no
         * field that could carry one.
         */
        proposeSummary(ref, input = {}, actor) {
            if (!actor || (actor.kind !== 'service' && actor.kind !== 'system')) fail(403, 'summary.service_only', 'AI proposals come from a service principal');
            const wf = input.workflow || {};
            const runId = wf.run_id || wf.runId;
            if (!wf.id || !runId) fail(400, 'authorship.workflow_required', `An AI proposal names its OpenVibe.AI workflow (workflow.id, e.g. ${SUMMARY_WORKFLOW}) and run (workflow.run_id)`);
            let rec;
            try { rec = authorship.record({ mode: 'ai', workflow: { id: String(wf.id), runId: String(runId), version: wf.version, model: wf.model }, stubProvider: !!(input.stub_provider || input.stubProvider) }); } catch (err) { fail(422, 'authorship.invalid', err.message); }
            return tx(() => {
                const e = entityOrFail(ref);
                if (e.state !== 'active') fail(409, 'entity.not_active', `This entity is ${e.state}`);
                const body = checkSummaryInput(e.id, input, { ai: true });
                const summary = ensureSummary(e.id);
                const head = revisions.headNumber(summary.id);
                const { revision } = revisions.create({
                    entityId: summary.id, expectedRevision: head, content: body.content, fields: body.fields,
                    meta: { authorship: rec }, author: actorId(actor), message: input.note ? `AI proposal: ${String(input.note).slice(0, 200)}` : 'AI proposal', allowUnchanged: true,
                });
                writeCitations(summary, revision);
                audit(actor, 'summary.proposed', e.id, summary.id, { revision: revision.number, workflow: rec.workflow, stub_provider: !!rec.stubProvider });
                return { summary: q.summary.get(e.id), revision: summaryRevisionView(q.summary.get(e.id), revision, e.id) };
            });
        },

        /** An editor approves (and by default publishes) or rejects a revision. */
        reviewSummary(ref, n, { decision, note = null, publish = true } = {}, actor) {
            const who = requireEditorPerson(actor, 'Reviewing a summary');
            if (decision !== 'approved' && decision !== 'rejected') fail(422, 'review.invalid_decision', 'decision is approved or rejected');
            return tx(() => {
                const e = entityOrFail(ref);
                const summary = q.summary.get(e.id);
                if (!summary) fail(404, 'summary.not_found', 'This entity has no summary');
                const rev = revisions.get(summary.id, Number(n));
                if (!rev) fail(404, 'revision.not_found', `No revision ${n}`);
                const review = reviews.record({ entityId: summary.id, revision: rev.number, reviewer: who, decision, note });
                audit(actor, `summary.${decision}`, e.id, summary.id, { revision: rev.number, note });
                let published = false;
                if (decision === 'approved' && publish !== false && publish !== 'false') { svc.publishSummary(e.id, { revision: rev.number }, actor); published = true; }
                if (decision === 'approved' && !published && summary.state === 'published' && summary.published_revision === rev.number) syncEntity(e.id);
                return { review, published, summary: q.summary.get(e.id) };
            });
        },

        publishSummary(ref, { revision } = {}, actor) {
            requireEditorPerson(actor, 'Publishing a summary');
            return tx(() => {
                const e = entityOrFail(ref);
                if (e.state !== 'active') fail(409, 'entity.not_active', `This entity is ${e.state}`);
                const summary = q.summary.get(e.id);
                if (!summary) fail(404, 'summary.not_found', 'This entity has no summary');
                const n = revision == null ? revisions.headNumber(summary.id) : Number(revision);
                const rev = revisions.get(summary.id, n);
                if (!rev) fail(404, 'revision.not_found', `No revision ${revision}`);
                const review = reviews.latest(summary.id, n);
                if (review && review.decision === 'rejected') fail(409, 'summary.rejected', 'This revision was rejected by an editor');
                const rec = rev.meta && rev.meta.authorship;
                if (rec) { const ok = authorship.canPublish(rec, review); if (!ok.ok) fail(409, ok.reason, 'AI-drafted summaries are published only after a person approves them'); }
                if (rev.meta && rev.meta.system && !(review && review.decision === 'approved')) fail(409, 'summary.review_required', 'A revision prepared after a source change is published only after an editor approves it');
                const bad = citationState(e.id, rev).filter((p) => !p.supported);
                if (bad.length) fail(409, 'summary.unsupported_points', `${bad.length} point(s) cite no live signal of this entity`, { points: bad.map((p) => p.key) });
                const wasPublished = summary.state === 'published';
                const before = summary.published_revision;
                q.publishSummary.run({ id: summary.id, n, now: now() });
                audit(actor, 'summary.published', e.id, summary.id, { revision: n, previous: before });
                touchEntity(e.id);
                const doc = syncEntity(e.id);
                const fresh = q.entity.get(e.id);
                const decision = decide(fresh);
                const action = !wasPublished ? 'published' : (before !== n ? 'updated' : null);
                if (action) {
                    emit(hooks.publicationEvent({
                        product: 'reviews', type: 'summary', action, id: summary.id, revision: n,
                        actor: hooks.subjectRef(actorId(actor)), decision, now: now(),
                        document: { owner: 'reviews', type: 'summary', id: summary.id, revision: doc ? doc.revision : 0, deleted: false, visibility: 'public', canonical_url: entityUrl(fresh), publication_state: 'published', indexability: hooks.searchIndexability(decision) },
                        extra: { entity_id: e.id, entity_slug: fresh.slug, authorship: rec ? hooks.AUTHORSHIP[rec.mode] : null, ...(rev.meta && rev.meta.correction ? { correction: { note: rev.meta.correction.note, corrects: rev.meta.correction.corrects } } : {}) },
                    }));
                }
                return q.summary.get(e.id);
            });
        },

        unpublishSummary(ref, actor) {
            requireEditorPerson(actor, 'Unpublishing a summary');
            return tx(() => {
                const e = entityOrFail(ref);
                const summary = q.summary.get(e.id);
                if (!summary || summary.state !== 'published') fail(409, 'summary.not_published', 'Nothing is published');
                q.unpublishSummary.run(now(), summary.id);
                audit(actor, 'summary.unpublished', e.id, summary.id, { revision: summary.published_revision });
                const doc = syncEntity(e.id);
                const fresh = q.entity.get(e.id);
                emit(hooks.publicationEvent({
                    product: 'reviews', type: 'summary', action: 'unpublished', id: summary.id, revision: summary.published_revision,
                    actor: hooks.subjectRef(actorId(actor)), decision: decide(fresh), now: now(),
                    document: { owner: 'reviews', type: 'summary', id: summary.id, revision: doc ? doc.revision : 0, deleted: true },
                    extra: { entity_id: e.id, entity_slug: fresh.slug },
                }));
                return q.summary.get(e.id);
            });
        },

        flaggedSummaries() { return q.flaggedSummaries.all().map((s) => ({ ...s, entity: q.entity.get(s.entity_id) })); },
        pendingSummaries() {
            return q.allSummaries.all().map((s) => ({ summary: s, entity: q.entity.get(s.entity_id), pending: pendingRevisions(s) }))
                .filter((x) => x.pending.length && x.entity && x.entity.state === 'active')
                .map((x) => ({ entity: x.entity, summary: x.summary, pending: x.pending.map((p) => ({ number: p.rev.number, status: p.status, message: p.rev.message, created_at: p.rev.createdAt })) }));
        },

        /** Published summaries for the feed, newest first, with the gate's decision for the entity. */
        recentSummaries(limit = 50) {
            return q.publishedSummaries.all(limit).map((s) => {
                const e = q.entity.get(s.entity_id);
                if (!e || e.state !== 'active') return null;
                const rev = revisions.get(s.id, s.published_revision);
                return { summary: s, entity: e, rev, decision: decide(e) };
            }).filter(Boolean);
        },

        /** Every active entity with its decision (sitemaps). */
        publicEntities() {
            return db.prepare("SELECT * FROM review_entities WHERE state = 'active' ORDER BY id").all().map((e) => ({ entity: e, decision: decide(e) }));
        },

        /** Entities with at least one live signal or a published summary (the home page). */
        entitiesWithData(limit = 60) {
            return db.prepare(`SELECT e.* FROM review_entities e WHERE e.state = 'active' AND (
                    EXISTS (SELECT 1 FROM review_signals s JOIN review_entities m ON m.id = s.entity_id WHERE s.status = 'active' AND (m.id = e.id OR m.merged_into = e.id))
                    OR EXISTS (SELECT 1 FROM review_summaries u WHERE u.entity_id = e.id AND u.state = 'published'))
                ORDER BY e.updated_at DESC LIMIT ?`).all(limit).map((e) => ({ entity: e, aggregate: aggregateView(q.lastAggregate.get(e.id)) }));
        },

        // Corrections (reviews.correction.submit) --------------------------------------------
        submitCorrection(ref, { target_type: targetType = 'entity', target_id: targetId = null, body, evidence_url: evidenceUrl = null } = {}, actor) {
            if (!access.isPerson(actor)) fail(403, 'reviews.person_required', 'Corrections come from a signed-in person (a service must name them in X-OV-Subject)');
            if (!['entity', 'alias', 'signal', 'summary', 'aggregate'].includes(targetType)) fail(422, 'correction.invalid', 'target_type is entity, alias, signal, summary or aggregate');
            const text = String(body == null ? '' : body).trim();
            if (text.length < 10) fail(422, 'correction.invalid', 'Tell the editors what is wrong (at least 10 characters)');
            if (text.length > 4000) fail(422, 'correction.invalid', 'At most 4000 characters');
            let url = null;
            if (evidenceUrl) {
                try { const u = new URL(String(evidenceUrl)); if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('x'); url = u.toString(); } catch { fail(422, 'correction.invalid', 'evidence_url must be an http(s) URL'); }
            }
            return tx(() => {
                const e = entityOrFail(ref);
                if (e.state === 'deleted') fail(410, 'entity.deleted', 'This entity was deleted');
                const t = now();
                const id = `cor_${ulid(t)}`;
                q.insertCorrection.run({ id, entity_id: canonicalOf(e.id) || e.id, target_type: targetType, target_id: targetId ? String(targetId).slice(0, 100) : null, body: text, evidence_url: url, submitted_by: actor.subject, via: actor.kind === 'service' ? actor.service : null, now: t });
                audit(actor, 'correction.submitted', canonicalOf(e.id) || e.id, id, { target_type: targetType, target_id: targetId });
                return q.correction.get(id);
            });
        },
        openCorrections() {
            return q.openCorrections.all().map((c) => {
                const entity = q.entity.get(canonicalOf(c.entity_id) || c.entity_id);
                const s = entity && entity.state === 'active' ? q.summary.get(entity.id) : null;
                return { ...c, entity, summary_published: !!(s && s.state === 'published') };
            });
        },
        correction(id) { return q.correction.get(String(id)) || null; },
        /**
         * An editor accepts or rejects a correction request. `note` stays with the editors. Accepting
         * a request about an entity whose summary is published corrects that summary: a new revision
         * with the public `correction_note` (and the new text in `summary`, or the published text
         * carried forward). Rejecting creates nothing.
         */
        resolveCorrection(id, { status, note = null, correction_note: correctionNote = null, summary: body = null } = {}, actor) {
            const who = requireEditorPerson(actor, 'Resolving a correction');
            if (!['accepted', 'rejected'].includes(status)) fail(422, 'correction.invalid', 'status is accepted or rejected');
            if (body != null && (typeof body !== 'object' || Array.isArray(body))) fail(422, 'summary.invalid', 'summary is { overview, overview_signals, pros, cons }');
            return tx(() => {
                const c = q.correction.get(String(id));
                if (!c) fail(404, 'correction.not_found', 'No such correction');
                if (c.status !== 'open') fail(409, 'correction.closed', `Already ${c.status}`);
                const internal = note ? String(note).slice(0, 2000) : null;
                if (status === 'accepted') {
                    const e = q.entity.get(canonicalOf(c.entity_id) || c.entity_id);
                    const s = e && e.state === 'active' ? q.summary.get(e.id) : null;
                    if (s && s.state === 'published') {
                        const out = correctSummary(e, { ...(body || {}) }, { note: correctionNote, requestId: c.id, resolutionNote: internal }, actor, who);
                        return { correction: out.correction, revision: out.revision };
                    }
                }
                q.resolveCorrection.run(status, who, internal, now(), c.id);
                audit(actor, `correction.${status}`, c.entity_id, c.id, { note: internal });
                return { correction: q.correction.get(c.id), revision: null };
            });
        },

        // Discussion (Community, referenced) -------------------------------------------------
        knownThread(entityId) { const d = discussions.get(entityId); return d ? d.threadId : null; },
        async discussionThread(e, client) {
            const known = discussions.get(e.id);
            if (known) return known.threadId;
            if (e.state !== 'active') return null;
            const out = await discussions.threadFor(e.id, { service: 'reviews', type: 'entity', id: e.id, label: e.name.slice(0, 200) }, { client });
            return out.threadId;
        },

        // Search reconciliation ---------------------------------------------------------------
        reconcileIndex() {
            return tx(() => {
                let sent = 0;
                for (const { id } of q.allEntityIds.all()) {
                    if (sequencer.current('reviews', 'entity', id) == null && q.entity.get(id).state !== 'active') continue;
                    const before = sequencer.current('reviews', 'entity', id);
                    const doc = syncEntity(id);
                    if (doc && doc.revision !== before) sent++;
                }
                return { sent };
            });
        },

        stats() {
            const one = (sql) => db.prepare(sql).get().n;
            return {
                entities: one("SELECT COUNT(*) AS n FROM review_entities WHERE state = 'active'"),
                signals: one("SELECT COUNT(*) AS n FROM review_signals WHERE status = 'active'"),
                items_unresolved: one("SELECT COUNT(*) AS n FROM review_source_items WHERE resolution IN ('ambiguous','unmatched') AND state = 'active'"),
                corrections_open: one("SELECT COUNT(*) AS n FROM review_corrections WHERE status = 'open'"),
                summaries_flagged: one('SELECT COUNT(*) AS n FROM review_summaries WHERE flagged = 1'),
            };
        },
    };
    return svc;
}

module.exports = { createReviewsService, ReviewsError, SUMMARY_WORKFLOW, RATING_TEXT_RE };
