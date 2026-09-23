'use strict';
/**
 * Reviews' own SQLite database (one per service, WAL, created on boot, idempotent).
 *
 * The nine authority tables of roadmap §15.13:
 *   review_entities            the things reviewed; merged entities point at their canonical entity
 *   review_entity_aliases      names, URLs, SKUs/GTINs, source bindings used to resolve source items
 *   review_sources             the OpenVibe.Sources sources Reviews has seen (key, notes, health)
 *   review_source_items        Sources items Reviews read (signal fields only, never review text),
 *                              their provenance and how they were resolved to an entity
 *   review_signals             typed observations extracted from one item revision, attributed to
 *                              one entity; values and provenance are immutable, only status moves
 *   review_summaries           one editorial summary per entity and its publication state
 *   review_summary_revisions   immutable summary revisions (openvibe-publishing/revisions, prefix review_summary)
 *   review_trust_metadata      editor-set trust facts per source / signal / entity (include/exclude
 *                              from aggregates, limitations, verification), history kept
 *   review_entity_links        typed links between entities; a merge is a `merged_into` link, a split
 *                              ends it (who, when, why: the audit of the merge itself)
 *
 * Helper tables (not authority): review_aggregates (every computed aggregate revision, immutable),
 * review_summary_citations (which signal each summary point cites, immutable), review_corrections
 * (the correction queue), review_audit (append-only log of editorial actions), review_import_queue
 * and review_sync_state (Sources consumption). The Publishing packages add review_summary_drafts,
 * review_summary_revision_purges, review_summary_reviews, review_entity_redirects,
 * review_discussion_refs and review_index_revisions; the SDK adds review_event_outbox and the
 * inbox table review_event_inbox.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { createRevisionStore } = require('openvibe-publishing/revisions');
const { createDiscussionRefs } = require('openvibe-publishing/discussion');
const { createReviewLog } = require('openvibe-publishing/authorship');
const { createIndexSequencer } = require('openvibe-publishing/index-hooks');
const seo = require('openvibe-publishing/seo');

const ENTITY_KINDS = ['product', 'game', 'software', 'service', 'place', 'organization', 'media', 'other'];
const ALIAS_TYPES = ['name', 'url', 'sku', 'gtin', 'mpn', 'source', 'external'];
const SIGNAL_TYPES = ['recommendation', 'recommendation_tally', 'rating', 'rating_aggregate'];
const LINK_TYPES = ['merged_into', 'related', 'edition_of', 'successor_of', 'part_of', 'external_ref'];
const TRUST_KEYS = ['aggregate', 'limitation', 'verification'];

const q = (list) => list.map((s) => `'${s}'`).join(',');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS review_entities (
    id           TEXT PRIMARY KEY,
    slug         TEXT NOT NULL UNIQUE,
    name         TEXT NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN (${q(ENTITY_KINDS)})),
    description  TEXT,
    state        TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','merged','deleted')),
    merged_into  TEXT REFERENCES review_entities(id),
    noindex      INTEGER NOT NULL DEFAULT 0,
    created_by   TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    deleted_at   INTEGER,
    CHECK ((state = 'merged') = (merged_into IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS review_entities_merged ON review_entities (merged_into);
CREATE INDEX IF NOT EXISTS review_entities_name ON review_entities (name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS review_entity_aliases (
    id          TEXT PRIMARY KEY,
    entity_id   TEXT NOT NULL REFERENCES review_entities(id),
    type        TEXT NOT NULL CHECK (type IN (${q(ALIAS_TYPES)})),
    value       TEXT NOT NULL,
    norm        TEXT NOT NULL,
    created_by  TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    removed_at  INTEGER,
    removed_by  TEXT
);
-- A strong identifier (URL, SKU, GTIN, MPN, source binding, external id) names one entity at a time;
-- names may be shared (two things called "Portal" is why names need an editor's confirmation).
CREATE UNIQUE INDEX IF NOT EXISTS review_entity_aliases_strong ON review_entity_aliases (type, norm) WHERE removed_at IS NULL AND type != 'name';
CREATE UNIQUE INDEX IF NOT EXISTS review_entity_aliases_name ON review_entity_aliases (norm, entity_id) WHERE removed_at IS NULL AND type = 'name';
CREATE INDEX IF NOT EXISTS review_entity_aliases_entity ON review_entity_aliases (entity_id);

CREATE TABLE IF NOT EXISTS review_sources (
    key              TEXT PRIMARY KEY,
    name             TEXT,
    homepage_url     TEXT,
    category         TEXT,
    license_note     TEXT,
    terms_note       TEXT,
    status           TEXT,
    stale            INTEGER,
    last_success_at  TEXT,
    first_seen_at    INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS review_source_items (
    id               TEXT PRIMARY KEY,
    source_key       TEXT NOT NULL REFERENCES review_sources(key),
    kind             TEXT NOT NULL,
    identity         TEXT NOT NULL,
    canonical_url    TEXT,
    title            TEXT,
    item_revision    INTEGER NOT NULL,
    content_hash     TEXT NOT NULL,
    published_at     TEXT,
    retrieved_at     TEXT NOT NULL,
    parser_version   TEXT,
    license_note     TEXT,
    terms_note       TEXT,
    fields           TEXT NOT NULL DEFAULT '{}',
    state            TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','removed')),
    removed_at       TEXT,
    removed_reason   TEXT,
    resolution       TEXT NOT NULL DEFAULT 'unmatched' CHECK (resolution IN ('resolved','ambiguous','unmatched','ignored')),
    entity_id        TEXT REFERENCES review_entities(id),
    resolution_rule  TEXT,
    candidates       TEXT NOT NULL DEFAULT '[]',
    resolved_by      TEXT,
    resolved_at      INTEGER,
    signal_note      TEXT,
    first_seen_at    INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    CHECK ((resolution = 'resolved') = (entity_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS review_source_items_resolution ON review_source_items (resolution, updated_at);
CREATE INDEX IF NOT EXISTS review_source_items_entity ON review_source_items (entity_id);
CREATE INDEX IF NOT EXISTS review_source_items_source ON review_source_items (source_key);

CREATE TABLE IF NOT EXISTS review_signals (
    id                  TEXT PRIMARY KEY,
    entity_id           TEXT NOT NULL REFERENCES review_entities(id),
    source_item_id      TEXT NOT NULL REFERENCES review_source_items(id),
    source_key          TEXT NOT NULL REFERENCES review_sources(key),
    item_revision       INTEGER NOT NULL,
    type                TEXT NOT NULL CHECK (type IN (${q(SIGNAL_TYPES)})),
    recommended         INTEGER CHECK (recommended IN (0,1)),
    positive_count      INTEGER,
    total_count         INTEGER,
    rating_value        REAL,
    rating_best         REAL,
    rating_worst        REAL,
    rating_count        INTEGER,
    observed_at         TEXT NOT NULL,
    source_published_at TEXT,
    canonical_url       TEXT,
    license_note        TEXT,
    trust               TEXT NOT NULL DEFAULT '{}',
    status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','withdrawn')),
    status_reason       TEXT,
    status_at           INTEGER,
    superseded_by       TEXT,
    created_by          TEXT NOT NULL,
    created_at          INTEGER NOT NULL,
    CHECK (type != 'recommendation' OR recommended IS NOT NULL),
    CHECK (type != 'recommendation_tally' OR (positive_count IS NOT NULL AND total_count IS NOT NULL AND positive_count >= 0 AND total_count >= positive_count)),
    CHECK (type NOT IN ('rating','rating_aggregate') OR rating_value IS NOT NULL)
);
-- At most one active signal per source item: an update supersedes, a removal withdraws.
CREATE UNIQUE INDEX IF NOT EXISTS review_signals_active_item ON review_signals (source_item_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS review_signals_entity ON review_signals (entity_id, status);
-- Provenance and values never change after the signal exists; only its status moves.
CREATE TRIGGER IF NOT EXISTS review_signals_immutable BEFORE UPDATE OF id, entity_id, source_item_id, source_key, item_revision, type,
    recommended, positive_count, total_count, rating_value, rating_best, rating_worst, rating_count, observed_at,
    source_published_at, canonical_url, license_note, trust, created_by, created_at ON review_signals
BEGIN SELECT RAISE(ABORT, 'review_signals values and provenance are immutable'); END;
CREATE TRIGGER IF NOT EXISTS review_signals_no_delete BEFORE DELETE ON review_signals
BEGIN SELECT RAISE(ABORT, 'review_signals rows are withdrawn, never deleted'); END;

CREATE TABLE IF NOT EXISTS review_summaries (
    id                     TEXT PRIMARY KEY,
    entity_id              TEXT NOT NULL UNIQUE REFERENCES review_entities(id),
    state                  TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','published','unpublished')),
    published_revision     INTEGER,
    published_at           INTEGER,
    revision_published_at  INTEGER,
    flagged                INTEGER NOT NULL DEFAULT 0,
    flag_reason            TEXT,
    flagged_at             INTEGER,
    created_at             INTEGER NOT NULL,
    updated_at             INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS review_summary_citations (
    summary_id      TEXT NOT NULL REFERENCES review_summaries(id),
    revision        INTEGER NOT NULL,
    point           TEXT NOT NULL,
    signal_id       TEXT NOT NULL REFERENCES review_signals(id),
    PRIMARY KEY (summary_id, revision, point, signal_id)
);
CREATE INDEX IF NOT EXISTS review_summary_citations_signal ON review_summary_citations (signal_id);
CREATE TRIGGER IF NOT EXISTS review_summary_citations_no_update BEFORE UPDATE ON review_summary_citations
BEGIN SELECT RAISE(ABORT, 'review_summary_citations rows are immutable'); END;
CREATE TRIGGER IF NOT EXISTS review_summary_citations_no_delete BEFORE DELETE ON review_summary_citations
BEGIN SELECT RAISE(ABORT, 'review_summary_citations rows are never deleted'); END;

CREATE TABLE IF NOT EXISTS review_trust_metadata (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    scope     TEXT NOT NULL CHECK (scope IN ('source','signal','entity')),
    scope_id  TEXT NOT NULL,
    key       TEXT NOT NULL CHECK (key IN (${q(TRUST_KEYS)})),
    value     TEXT NOT NULL,
    note      TEXT,
    set_by    TEXT NOT NULL,
    set_at    INTEGER NOT NULL,
    ended_at  INTEGER,
    ended_by  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS review_trust_current ON review_trust_metadata (scope, scope_id, key) WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS review_entity_links (
    id           TEXT PRIMARY KEY,
    from_entity  TEXT NOT NULL REFERENCES review_entities(id),
    to_entity    TEXT REFERENCES review_entities(id),
    type         TEXT NOT NULL CHECK (type IN (${q(LINK_TYPES)})),
    ref          TEXT,
    note         TEXT,
    created_by   TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    ended_at     INTEGER,
    ended_by     TEXT,
    end_note     TEXT,
    CHECK ((type = 'external_ref') = (ref IS NOT NULL AND to_entity IS NULL))
);
CREATE INDEX IF NOT EXISTS review_entity_links_from ON review_entity_links (from_entity, type);
CREATE INDEX IF NOT EXISTS review_entity_links_to ON review_entity_links (to_entity, type);
CREATE UNIQUE INDEX IF NOT EXISTS review_entity_links_one_merge ON review_entity_links (from_entity) WHERE type = 'merged_into' AND ended_at IS NULL;

CREATE TABLE IF NOT EXISTS review_aggregates (
    entity_id    TEXT NOT NULL REFERENCES review_entities(id),
    revision     INTEGER NOT NULL,
    computed_at  INTEGER NOT NULL,
    trigger      TEXT NOT NULL,
    inputs_hash  TEXT NOT NULL,
    result       TEXT,
    PRIMARY KEY (entity_id, revision)
);
CREATE TRIGGER IF NOT EXISTS review_aggregates_no_update BEFORE UPDATE ON review_aggregates
BEGIN SELECT RAISE(ABORT, 'review_aggregates rows are immutable'); END;
CREATE TRIGGER IF NOT EXISTS review_aggregates_no_delete BEFORE DELETE ON review_aggregates
BEGIN SELECT RAISE(ABORT, 'review_aggregates rows are never deleted'); END;

CREATE TABLE IF NOT EXISTS review_corrections (
    id               TEXT PRIMARY KEY,
    entity_id        TEXT NOT NULL REFERENCES review_entities(id),
    target_type      TEXT NOT NULL CHECK (target_type IN ('entity','alias','signal','summary','aggregate')),
    target_id        TEXT,
    body             TEXT NOT NULL,
    evidence_url     TEXT,
    submitted_by     TEXT NOT NULL,
    via              TEXT,
    status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','rejected')),
    resolved_by      TEXT,
    resolution_note  TEXT,
    resolved_at      INTEGER,
    created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS review_corrections_status ON review_corrections (status, created_at);
CREATE INDEX IF NOT EXISTS review_corrections_entity ON review_corrections (entity_id, status);

CREATE TABLE IF NOT EXISTS review_audit (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    at         INTEGER NOT NULL,
    actor      TEXT NOT NULL,
    action     TEXT NOT NULL,
    entity_id  TEXT,
    target     TEXT,
    detail     TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS review_audit_entity ON review_audit (entity_id, id);
CREATE TRIGGER IF NOT EXISTS review_audit_no_update BEFORE UPDATE ON review_audit
BEGIN SELECT RAISE(ABORT, 'review_audit rows are immutable'); END;
CREATE TRIGGER IF NOT EXISTS review_audit_no_delete BEFORE DELETE ON review_audit
BEGIN SELECT RAISE(ABORT, 'review_audit rows are never deleted'); END;

CREATE TABLE IF NOT EXISTS review_import_queue (
    item_id          TEXT PRIMARY KEY,
    reason           TEXT NOT NULL,
    enqueued_at      INTEGER NOT NULL,
    attempts         INTEGER NOT NULL DEFAULT 0,
    next_attempt_at  INTEGER NOT NULL DEFAULT 0,
    last_error       TEXT
);

CREATE TABLE IF NOT EXISTS review_sync_state (
    name        TEXT PRIMARY KEY,
    value       TEXT,
    updated_at  INTEGER NOT NULL
);
`;

function openDb(dbPath) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    return db;
}

/** Creates every table and returns the Publishing package stores bound to this database. */
function createStores(db, { now = () => Date.now() } = {}) {
    db.exec(SCHEMA);
    const revisions = createRevisionStore(db, { prefix: 'review_summary', now });
    return {
        revisions,
        reviews: createReviewLog(db, { prefix: 'review_summary', now }),
        redirects: seo.createRedirectStore(db, { prefix: 'review_entity', now }),
        discussions: createDiscussionRefs(db, { prefix: 'review', now }),
        sequencer: createIndexSequencer(db, { prefix: 'review', now }),
    };
}

const AUTHORITY_TABLES = Object.freeze([
    'review_entities', 'review_entity_aliases', 'review_sources', 'review_source_items', 'review_signals',
    'review_summaries', 'review_summary_revisions', 'review_trust_metadata', 'review_entity_links',
]);

module.exports = { openDb, createStores, SCHEMA, AUTHORITY_TABLES, ENTITY_KINDS, ALIAS_TYPES, SIGNAL_TYPES, LINK_TYPES, TRUST_KEYS };
