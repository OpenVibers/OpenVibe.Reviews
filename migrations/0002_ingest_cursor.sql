-- phase: expand
-- The ingest cursor moves from review_sync_state ('sources.items.after') to the chassis' own table
-- (openvibe-publishing/ingest, prefix review → review_ingest_cursor). Additive: the old key is read
-- once here so a deployment continues from the cursor it had, never from zero. Generated from
-- require('openvibe-publishing').schema({ ingest: 'review' }).

CREATE TABLE IF NOT EXISTS review_ingest_cursor (
    name       text COLLATE "C" NOT NULL,
    cursor     bigint NOT NULL,
    updated_at bigint NOT NULL,
    PRIMARY KEY (name)
);

-- Continuity: carry the cursor already stored under the old key, once. review_sync_state.value is
-- text, so a numeric cursor is plain digits; anything else is ignored (the chassis cursor then starts
-- empty).
INSERT INTO review_ingest_cursor (name, cursor, updated_at)
SELECT 'sources', value::bigint, (EXTRACT(EPOCH FROM now()) * 1000)::bigint
FROM review_sync_state
WHERE name = 'sources.items.after' AND value ~ '^[0-9]+$'
ON CONFLICT (name) DO NOTHING;
