-- phase: expand
-- OpenVibe.Reviews on PostgreSQL (ADR-035, roadmap WS-X2): the tables as they were on SQLite (converted by openvibe-sdk
-- tools/asyncify/sqlite-schema-to-pg: text COLLATE "C" compares like SQLite, integers are bigint, identities keep their ids),
-- then the openvibe-publishing stores and the openvibe-sdk inbox and outbox. Generated once on 2026-09-28; never edited after it runs.

CREATE TABLE review_entities (
    id           text COLLATE "C" PRIMARY KEY,
    slug         text COLLATE "C" NOT NULL UNIQUE,
    name         text COLLATE "C" NOT NULL,
    kind         text COLLATE "C" NOT NULL CHECK (kind IN ('product','game','software','service','place','organization','media','other')),
    description  text COLLATE "C",
    state        text COLLATE "C" NOT NULL DEFAULT 'active' CHECK (state IN ('active','merged','deleted')),
    merged_into  text COLLATE "C" REFERENCES review_entities(id),
    noindex      bigint NOT NULL DEFAULT 0,
    created_by   text COLLATE "C" NOT NULL,
    created_at   bigint NOT NULL,
    updated_at   bigint NOT NULL,
    deleted_at   bigint,
    CHECK ((state = 'merged') = (merged_into IS NOT NULL))
);
CREATE INDEX review_entities_merged ON review_entities (merged_into);
CREATE INDEX review_entities_name ON review_entities (lower(name));

CREATE TABLE review_entity_aliases (
    id          text COLLATE "C" PRIMARY KEY,
    entity_id   text COLLATE "C" NOT NULL REFERENCES review_entities(id),
    type        text COLLATE "C" NOT NULL CHECK (type IN ('name','url','sku','gtin','mpn','source','external')),
    value       text COLLATE "C" NOT NULL,
    norm        text COLLATE "C" NOT NULL,
    created_by  text COLLATE "C" NOT NULL,
    created_at  bigint NOT NULL,
    removed_at  bigint,
    removed_by  text COLLATE "C"
);
-- A strong identifier (URL, SKU, GTIN, MPN, source binding, external id) names one entity at a time;
-- names may be shared (two things called "Portal" is why names need an editor's confirmation).
CREATE UNIQUE INDEX review_entity_aliases_strong ON review_entity_aliases (type, norm) WHERE removed_at IS NULL AND type != 'name';
CREATE UNIQUE INDEX review_entity_aliases_name ON review_entity_aliases (norm, entity_id) WHERE removed_at IS NULL AND type = 'name';
CREATE INDEX review_entity_aliases_entity ON review_entity_aliases (entity_id);

CREATE TABLE review_sources (
    key              text COLLATE "C" PRIMARY KEY,
    name             text COLLATE "C",
    homepage_url     text COLLATE "C",
    category         text COLLATE "C",
    license_note     text COLLATE "C",
    terms_note       text COLLATE "C",
    status           text COLLATE "C",
    stale            bigint,
    last_success_at  text COLLATE "C",
    first_seen_at    bigint NOT NULL,
    updated_at       bigint NOT NULL
);

CREATE TABLE review_source_items (
    id               text COLLATE "C" PRIMARY KEY,
    source_key       text COLLATE "C" NOT NULL REFERENCES review_sources(key),
    kind             text COLLATE "C" NOT NULL,
    identity         text COLLATE "C" NOT NULL,
    canonical_url    text COLLATE "C",
    title            text COLLATE "C",
    item_revision    bigint NOT NULL,
    content_hash     text COLLATE "C" NOT NULL,
    published_at     text COLLATE "C",
    retrieved_at     text COLLATE "C" NOT NULL,
    parser_version   text COLLATE "C",
    license_note     text COLLATE "C",
    terms_note       text COLLATE "C",
    fields           text COLLATE "C" NOT NULL DEFAULT '{}',
    state            text COLLATE "C" NOT NULL DEFAULT 'active' CHECK (state IN ('active','removed')),
    removed_at       text COLLATE "C",
    removed_reason   text COLLATE "C",
    resolution       text COLLATE "C" NOT NULL DEFAULT 'unmatched' CHECK (resolution IN ('resolved','ambiguous','unmatched','ignored')),
    entity_id        text COLLATE "C" REFERENCES review_entities(id),
    resolution_rule  text COLLATE "C",
    candidates       text COLLATE "C" NOT NULL DEFAULT '[]',
    resolved_by      text COLLATE "C",
    resolved_at      bigint,
    signal_note      text COLLATE "C",
    first_seen_at    bigint NOT NULL,
    updated_at       bigint NOT NULL,
    CHECK ((resolution = 'resolved') = (entity_id IS NOT NULL))
);
CREATE INDEX review_source_items_resolution ON review_source_items (resolution, updated_at);
CREATE INDEX review_source_items_entity ON review_source_items (entity_id);
CREATE INDEX review_source_items_source ON review_source_items (source_key);

CREATE TABLE review_signals (
    id                  text COLLATE "C" PRIMARY KEY,
    entity_id           text COLLATE "C" NOT NULL REFERENCES review_entities(id),
    source_item_id      text COLLATE "C" NOT NULL REFERENCES review_source_items(id),
    source_key          text COLLATE "C" NOT NULL REFERENCES review_sources(key),
    item_revision       bigint NOT NULL,
    type                text COLLATE "C" NOT NULL CHECK (type IN ('recommendation','recommendation_tally','rating','rating_aggregate')),
    recommended         bigint CHECK (recommended IN (0,1)),
    positive_count      bigint,
    total_count         bigint,
    rating_value        double precision,
    rating_best         double precision,
    rating_worst        double precision,
    rating_count        bigint,
    observed_at         text COLLATE "C" NOT NULL,
    source_published_at text COLLATE "C",
    canonical_url       text COLLATE "C",
    license_note        text COLLATE "C",
    trust               text COLLATE "C" NOT NULL DEFAULT '{}',
    status              text COLLATE "C" NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','withdrawn')),
    status_reason       text COLLATE "C",
    status_at           bigint,
    superseded_by       text COLLATE "C",
    created_by          text COLLATE "C" NOT NULL,
    created_at          bigint NOT NULL,
    CHECK (type != 'recommendation' OR recommended IS NOT NULL),
    CHECK (type != 'recommendation_tally' OR (positive_count IS NOT NULL AND total_count IS NOT NULL AND positive_count >= 0 AND total_count >= positive_count)),
    CHECK (type NOT IN ('rating','rating_aggregate') OR rating_value IS NOT NULL)
);
-- At most one active signal per source item: an update supersedes, a removal withdraws.
CREATE UNIQUE INDEX review_signals_active_item ON review_signals (source_item_id) WHERE status = 'active';
CREATE INDEX review_signals_entity ON review_signals (entity_id, status);
-- Provenance and values never change after the signal exists; only its status moves.
CREATE FUNCTION review_signals_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'review_signals values and provenance are immutable'; END $$;
CREATE TRIGGER review_signals_immutable BEFORE UPDATE OF id, entity_id, source_item_id, source_key, item_revision, type, recommended, positive_count, total_count, rating_value, rating_best, rating_worst, rating_count, observed_at, source_published_at, canonical_url, license_note, trust, created_by, created_at ON review_signals FOR EACH ROW EXECUTE FUNCTION review_signals_immutable();
CREATE FUNCTION review_signals_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'review_signals rows are withdrawn, never deleted'; END $$;
CREATE TRIGGER review_signals_no_delete BEFORE DELETE ON review_signals FOR EACH ROW EXECUTE FUNCTION review_signals_no_delete();

CREATE TABLE review_summaries (
    id                     text COLLATE "C" PRIMARY KEY,
    entity_id              text COLLATE "C" NOT NULL UNIQUE REFERENCES review_entities(id),
    state                  text COLLATE "C" NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','published','unpublished')),
    published_revision     bigint,
    published_at           bigint,
    revision_published_at  bigint,
    flagged                bigint NOT NULL DEFAULT 0,
    flag_reason            text COLLATE "C",
    flagged_at             bigint,
    created_at             bigint NOT NULL,
    updated_at             bigint NOT NULL
);

CREATE TABLE review_summary_citations (
    summary_id      text COLLATE "C" NOT NULL REFERENCES review_summaries(id),
    revision        bigint NOT NULL,
    point           text COLLATE "C" NOT NULL,
    signal_id       text COLLATE "C" NOT NULL REFERENCES review_signals(id),
    PRIMARY KEY (summary_id, revision, point, signal_id)
);
CREATE INDEX review_summary_citations_signal ON review_summary_citations (signal_id);
CREATE FUNCTION review_summary_citations_no_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'review_summary_citations rows are immutable'; END $$;
CREATE TRIGGER review_summary_citations_no_update BEFORE UPDATE ON review_summary_citations FOR EACH ROW EXECUTE FUNCTION review_summary_citations_no_update();
CREATE FUNCTION review_summary_citations_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'review_summary_citations rows are never deleted'; END $$;
CREATE TRIGGER review_summary_citations_no_delete BEFORE DELETE ON review_summary_citations FOR EACH ROW EXECUTE FUNCTION review_summary_citations_no_delete();

CREATE TABLE review_trust_metadata (
    id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    scope     text COLLATE "C" NOT NULL CHECK (scope IN ('source','signal','entity')),
    scope_id  text COLLATE "C" NOT NULL,
    key       text COLLATE "C" NOT NULL CHECK (key IN ('aggregate','limitation','verification')),
    value     text COLLATE "C" NOT NULL,
    note      text COLLATE "C",
    set_by    text COLLATE "C" NOT NULL,
    set_at    bigint NOT NULL,
    ended_at  bigint,
    ended_by  text COLLATE "C"
);
CREATE UNIQUE INDEX review_trust_current ON review_trust_metadata (scope, scope_id, key) WHERE ended_at IS NULL;

CREATE TABLE review_entity_links (
    id           text COLLATE "C" PRIMARY KEY,
    from_entity  text COLLATE "C" NOT NULL REFERENCES review_entities(id),
    to_entity    text COLLATE "C" REFERENCES review_entities(id),
    type         text COLLATE "C" NOT NULL CHECK (type IN ('merged_into','related','edition_of','successor_of','part_of','external_ref')),
    ref          text COLLATE "C",
    note         text COLLATE "C",
    created_by   text COLLATE "C" NOT NULL,
    created_at   bigint NOT NULL,
    ended_at     bigint,
    ended_by     text COLLATE "C",
    end_note     text COLLATE "C",
    CHECK ((type = 'external_ref') = (ref IS NOT NULL AND to_entity IS NULL))
);
CREATE INDEX review_entity_links_from ON review_entity_links (from_entity, type);
CREATE INDEX review_entity_links_to ON review_entity_links (to_entity, type);
CREATE UNIQUE INDEX review_entity_links_one_merge ON review_entity_links (from_entity) WHERE type = 'merged_into' AND ended_at IS NULL;

CREATE TABLE review_aggregates (
    entity_id    text COLLATE "C" NOT NULL REFERENCES review_entities(id),
    revision     bigint NOT NULL,
    computed_at  bigint NOT NULL,
    trigger      text COLLATE "C" NOT NULL,
    inputs_hash  text COLLATE "C" NOT NULL,
    result       text COLLATE "C",
    PRIMARY KEY (entity_id, revision)
);
CREATE FUNCTION review_aggregates_no_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'review_aggregates rows are immutable'; END $$;
CREATE TRIGGER review_aggregates_no_update BEFORE UPDATE ON review_aggregates FOR EACH ROW EXECUTE FUNCTION review_aggregates_no_update();
CREATE FUNCTION review_aggregates_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'review_aggregates rows are never deleted'; END $$;
CREATE TRIGGER review_aggregates_no_delete BEFORE DELETE ON review_aggregates FOR EACH ROW EXECUTE FUNCTION review_aggregates_no_delete();

CREATE TABLE review_corrections (
    id               text COLLATE "C" PRIMARY KEY,
    entity_id        text COLLATE "C" NOT NULL REFERENCES review_entities(id),
    target_type      text COLLATE "C" NOT NULL CHECK (target_type IN ('entity','alias','signal','summary','aggregate')),
    target_id        text COLLATE "C",
    body             text COLLATE "C" NOT NULL,
    evidence_url     text COLLATE "C",
    submitted_by     text COLLATE "C" NOT NULL,
    via              text COLLATE "C",
    status           text COLLATE "C" NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','rejected')),
    resolved_by      text COLLATE "C",
    resolution_note  text COLLATE "C",
    resolved_at      bigint,
    created_at       bigint NOT NULL
);
CREATE INDEX review_corrections_status ON review_corrections (status, created_at);
CREATE INDEX review_corrections_entity ON review_corrections (entity_id, status);
CREATE INDEX review_corrections_by ON review_corrections (submitted_by, created_at);

CREATE TABLE review_audit (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at         bigint NOT NULL,
    actor      text COLLATE "C" NOT NULL,
    action     text COLLATE "C" NOT NULL,
    entity_id  text COLLATE "C",
    target     text COLLATE "C",
    detail     text COLLATE "C" NOT NULL DEFAULT '{}'
);
CREATE INDEX review_audit_entity ON review_audit (entity_id, id);
CREATE FUNCTION review_audit_no_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'review_audit rows are immutable'; END $$;
CREATE TRIGGER review_audit_no_update BEFORE UPDATE ON review_audit FOR EACH ROW EXECUTE FUNCTION review_audit_no_update();
CREATE FUNCTION review_audit_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'review_audit rows are never deleted'; END $$;
CREATE TRIGGER review_audit_no_delete BEFORE DELETE ON review_audit FOR EACH ROW EXECUTE FUNCTION review_audit_no_delete();

CREATE TABLE review_import_queue (
    item_id          text COLLATE "C" PRIMARY KEY,
    reason           text COLLATE "C" NOT NULL,
    enqueued_at      bigint NOT NULL,
    attempts         bigint NOT NULL DEFAULT 0,
    next_attempt_at  bigint NOT NULL DEFAULT 0,
    last_error       text COLLATE "C"
);

CREATE TABLE review_sync_state (
    name        text COLLATE "C" PRIMARY KEY,
    value       text COLLATE "C",
    updated_at  bigint NOT NULL
);

-- openvibe-publishing/revisions (prefix review_summary)
CREATE TABLE IF NOT EXISTS review_summary_revisions (
    id            text PRIMARY KEY,
    entity_id     text COLLATE "C" NOT NULL,
    number        integer NOT NULL CHECK (number >= 1),
    parent_id     text,
    parent_number integer,
    kind          text NOT NULL CHECK (kind IN ('edit','revert','import')),
    reverted_to   integer,
    content       text NOT NULL,
    fields        jsonb NOT NULL DEFAULT '{}',
    meta          jsonb NOT NULL DEFAULT '{}',
    content_hash  text NOT NULL,
    author        text,
    message       text,
    created_at    bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS review_summary_revisions_entity_num ON review_summary_revisions (entity_id, number);
CREATE TABLE IF NOT EXISTS review_summary_drafts (
    entity_id     text COLLATE "C" NOT NULL,
    owner         text COLLATE "C" NOT NULL,
    base_revision integer NOT NULL,
    content       text NOT NULL,
    fields        jsonb NOT NULL DEFAULT '{}',
    meta          jsonb NOT NULL DEFAULT '{}',
    created_at    bigint NOT NULL,
    updated_at    bigint NOT NULL,
    PRIMARY KEY (entity_id, owner)
);
CREATE INDEX IF NOT EXISTS review_summary_drafts_updated ON review_summary_drafts (entity_id, updated_at DESC, owner);
CREATE TABLE IF NOT EXISTS review_summary_revision_purges (
    entity_id   text COLLATE "C" PRIMARY KEY,
    reason      text NOT NULL,
    purged_by   text,
    purged_at   bigint NOT NULL
);
CREATE OR REPLACE FUNCTION review_summary_revisions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'review_summary_revisions rows are immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM review_summary_revision_purges WHERE entity_id = OLD.entity_id) THEN
        RAISE EXCEPTION 'review_summary_revisions rows are never deleted outside a recorded purge' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END
$$;
CREATE OR REPLACE TRIGGER review_summary_revisions_no_update BEFORE UPDATE ON review_summary_revisions FOR EACH ROW EXECUTE FUNCTION review_summary_revisions_guard();
CREATE OR REPLACE TRIGGER review_summary_revisions_no_delete BEFORE DELETE ON review_summary_revisions FOR EACH ROW EXECUTE FUNCTION review_summary_revisions_guard();

-- openvibe-publishing/authorship (prefix review_summary)
CREATE TABLE IF NOT EXISTS review_summary_reviews (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entity_id   text COLLATE "C" NOT NULL,
    revision    integer NOT NULL,
    reviewer    text NOT NULL,
    decision    text NOT NULL CHECK (decision IN ('approved','rejected')),
    note        text,
    reviewed_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS review_summary_reviews_rev ON review_summary_reviews (entity_id, revision, id);
CREATE INDEX IF NOT EXISTS review_summary_reviews_entity ON review_summary_reviews (entity_id, id);
CREATE OR REPLACE FUNCTION review_summary_reviews_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'review_summary_reviews rows are immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END
$$;
CREATE OR REPLACE TRIGGER review_summary_reviews_no_update BEFORE UPDATE ON review_summary_reviews FOR EACH ROW EXECUTE FUNCTION review_summary_reviews_guard();

-- openvibe-publishing/seo (prefix review_entity)
CREATE TABLE IF NOT EXISTS review_entity_redirects (
    from_path  text COLLATE "C" PRIMARY KEY,
    entity_id  text COLLATE "C" NOT NULL,
    reason     text,
    created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS review_entity_redirects_entity ON review_entity_redirects (entity_id, created_at, from_path);

-- openvibe-publishing/discussion (prefix review)
CREATE TABLE IF NOT EXISTS review_discussion_refs (
    entity_id   text COLLATE "C" PRIMARY KEY,
    thread_id   text NOT NULL,
    ref         jsonb NOT NULL,
    resolved_at bigint NOT NULL
);

-- openvibe-publishing/index-hooks (prefix review)
CREATE TABLE IF NOT EXISTS review_index_revisions (
    owner      text COLLATE "C" NOT NULL,
    type       text COLLATE "C" NOT NULL,
    id         text COLLATE "C" NOT NULL,
    revision   integer NOT NULL,
    hash       text NOT NULL,
    updated_at bigint NOT NULL,
    PRIMARY KEY (owner, type, id)
);

-- openvibe-sdk/events inbox: one receipt per (consumer, event) handled
CREATE TABLE IF NOT EXISTS review_event_inbox (
    consumer     text NOT NULL,
    event_id     text NOT NULL,
    processed_at bigint NOT NULL,
    PRIMARY KEY (consumer, event_id)
);

-- openvibe-sdk/events PostgreSQL outbox
CREATE TABLE IF NOT EXISTS review_event_outbox (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id        text NOT NULL UNIQUE,
    envelope        jsonb NOT NULL,
    traceparent     text,
    created_at      bigint NOT NULL,
    attempts        integer NOT NULL DEFAULT 0,
    next_attempt_at bigint NOT NULL DEFAULT 0,
    sent_at         bigint,
    seq             bigint,
    rejected_at     bigint,
    last_error      text
);
CREATE INDEX IF NOT EXISTS review_event_outbox_due ON review_event_outbox (next_attempt_at, id) WHERE sent_at IS NULL AND rejected_at IS NULL;
CREATE INDEX IF NOT EXISTS review_event_outbox_sent ON review_event_outbox (sent_at) WHERE sent_at IS NOT NULL;
