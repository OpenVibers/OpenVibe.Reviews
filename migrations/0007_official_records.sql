-- phase: expand
-- Official records (server/reviews/service.js, "Official records"): what a public body published about an entity, read
-- through OpenVibe.Sources — the CFPB complaint database's count for a company (complaint_tally) and NYC Health's
-- inspection results for a restaurant (inspection_violation, one row per violation cited, or per clean inspection).
-- They are records, not reviews: shown in their own section and never part of the aggregate.
CREATE TABLE review_records (
    id             text COLLATE "C" PRIMARY KEY,                -- rec_<ULID>
    entity_id      text COLLATE "C" NOT NULL REFERENCES review_entities(id),
    source_key     text COLLATE "C" NOT NULL,
    source_item_id text COLLATE "C" NOT NULL UNIQUE,            -- itm_<ULID>
    kind           text COLLATE "C" NOT NULL CHECK (kind IN ('complaint_tally', 'inspection_violation')),
    occurred_on    text COLLATE "C",                            -- YYYY-MM-DD: the inspection's day
    fields         jsonb NOT NULL DEFAULT '{}',
    item_revision  bigint NOT NULL,
    retrieved_at   text COLLATE "C" NOT NULL,
    status         text COLLATE "C" NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
    created_at     bigint NOT NULL,
    updated_at     bigint NOT NULL
);
CREATE INDEX review_records_entity ON review_records (entity_id, kind, occurred_on DESC) WHERE status = 'active';

-- Communities and platforms (the owner's list of what Reviews covers).
ALTER TABLE review_entities DROP CONSTRAINT IF EXISTS review_entities_kind_check;
ALTER TABLE review_entities ADD CONSTRAINT review_entities_kind_check CHECK (kind IN ('product','game','software','service','place','organization','media','other',
    'employer','landlord','restaurant','business','hosting','app','vehicle','community','platform'));
