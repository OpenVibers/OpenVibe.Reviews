'use strict';
/**
 * Reviews' own PostgreSQL database (ADR-035, roadmap WS-X2): the schema is migrations/NNNN_*.sql, applied at boot.
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
const { createDb } = require('openvibe-sdk/db');
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

const MIGRATIONS = path.join(__dirname, '..', 'migrations');
const DEV_PGLITE = path.join(__dirname, '..', 'data', 'pglite');

/**
 * The serving handle (ADR-035): DATABASE_URL through PgBouncer; in development without it, an embedded PGlite database
 * in data/pglite. Migrations run first, as the owner (DATABASE_DIRECT_URL), or on the embedded handle.
 */
async function openDb(config, { log = console, registry } = {}) {
    if (!config.db.url) {
        if (config.isProduction) throw new Error('DATABASE_URL is not set: production serves from PostgreSQL (OpenVibe.Host roles/data add-service.sh reviews)');
        log.warn(`[Reviews] DATABASE_URL unset: embedded PGlite database in ${DEV_PGLITE} (development only, one process)`);
        fs.mkdirSync(DEV_PGLITE, { recursive: true });
        const db = createDb({ pglite: DEV_PGLITE, service: 'reviews', registry, log });
        await db.migrate({ dir: MIGRATIONS, log });
        return db;
    }
    if (!config.db.directUrl) throw new Error('DATABASE_DIRECT_URL is not set: migrations run with the owner role on a direct connection');
    const owner = createDb({ url: config.db.directUrl, service: 'reviews-migrate', max: 1, log });
    try { await owner.migrate({ dir: MIGRATIONS, log }); } finally { await owner.close(); }
    return createDb({ url: config.db.url, service: 'reviews', registry, log });
}

/** The Publishing package stores bound to this (migrated) database. */
function createStores(db, { now = () => Date.now() } = {}) {
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

module.exports = { openDb, createStores, MIGRATIONS, AUTHORITY_TABLES, ENTITY_KINDS, ALIAS_TYPES, SIGNAL_TYPES, LINK_TYPES, TRUST_KEYS };
