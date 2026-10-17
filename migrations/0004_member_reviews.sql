-- phase: expand
-- Reviews by OpenVibe members (owner, 2026-10-17: Reviews collects reviews of "all kinds of things like glassdoor
-- reviews of employers, yelp, server hosting providers, BBB…"). One review per person per entity: a 1–5 rating, a title
-- and text, kept beside the source signals and never mixed into their aggregate. Members may add what they review, so
-- the kinds people review join the list: employers, landlords, restaurants, local businesses, hosting providers, apps
-- and vehicles. Widening the check is safe for the release before this one (it never writes the new kinds).
ALTER TABLE review_entities DROP CONSTRAINT IF EXISTS review_entities_kind_check;
ALTER TABLE review_entities ADD CONSTRAINT review_entities_kind_check CHECK (kind IN ('product','game','software','service','place','organization','media','other',
    'employer','landlord','restaurant','business','hosting','app','vehicle'));

CREATE TABLE review_member_reviews (
    id             text COLLATE "C" PRIMARY KEY,
    entity_id      text COLLATE "C" NOT NULL REFERENCES review_entities(id),
    author         text COLLATE "C" NOT NULL,
    author_name    text COLLATE "C",
    rating         smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
    title          text COLLATE "C" NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
    body           text COLLATE "C" NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
    relation       text COLLATE "C" CHECK (relation IS NULL OR length(relation) <= 60),
    status         text COLLATE "C" NOT NULL DEFAULT 'published' CHECK (status IN ('published','removed')),
    removed_by     text COLLATE "C",
    removed_reason text COLLATE "C",
    removed_at     bigint,
    created_at     bigint NOT NULL,
    updated_at     bigint NOT NULL,
    UNIQUE (entity_id, author)
);
CREATE INDEX review_member_reviews_entity ON review_member_reviews (entity_id, status, created_at DESC);
CREATE INDEX review_member_reviews_author ON review_member_reviews (author);
CREATE INDEX review_member_reviews_recent ON review_member_reviews (created_at DESC) WHERE status = 'published';
CREATE INDEX review_entities_kind ON review_entities (kind, updated_at DESC) WHERE state = 'active';
