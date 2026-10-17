-- phase: expand
-- Ratings other review sites show, as members saw them (owner, 2026-10-17: Reviews should combine "glassdoor reviews of
-- employers, yelp, … BBB"). A member on a Glassdoor, Indeed, Yelp, BBB, Trustpilot, Google Maps or Tripadvisor page
-- saves the rating the page states (the OpenVibe Companion reads it from the page they have open, or they type it): the
-- site, the page, the value on its scale and how many ratings it is from, who saw it and when. One row per member, site
-- and entity (the latest look); never mixed into the sources' aggregate or the members' own reviews.
CREATE TABLE review_seen_ratings (
    id            text COLLATE "C" PRIMARY KEY,
    entity_id     text COLLATE "C" NOT NULL REFERENCES review_entities(id),
    site          text COLLATE "C" NOT NULL CHECK (site IN ('glassdoor','indeed','yelp','bbb','trustpilot','google','tripadvisor')),
    page_url      text COLLATE "C" NOT NULL CHECK (length(page_url) <= 1000),
    rating_value  numeric NOT NULL CHECK (rating_value >= 0),
    rating_best   numeric NOT NULL CHECK (rating_best > 0 AND rating_value <= rating_best),
    rating_count  bigint CHECK (rating_count IS NULL OR rating_count >= 0),
    seen_by       text COLLATE "C" NOT NULL,
    seen_at       bigint NOT NULL,
    via           text COLLATE "C" NOT NULL DEFAULT 'form' CHECK (via IN ('companion','form')),
    status        text COLLATE "C" NOT NULL DEFAULT 'shown' CHECK (status IN ('shown','removed')),
    removed_by    text COLLATE "C",
    removed_reason text COLLATE "C",
    UNIQUE (entity_id, site, seen_by)
);
CREATE INDEX review_seen_ratings_entity ON review_seen_ratings (entity_id, site, seen_at DESC) WHERE status = 'shown';
CREATE INDEX review_seen_ratings_member ON review_seen_ratings (seen_by);
