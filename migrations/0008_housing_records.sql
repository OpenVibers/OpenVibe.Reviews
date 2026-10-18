-- phase: expand
-- NYC HPD housing-code violations (server/reviews/service.js, "Official records"): one tally per apartment building of
-- the violations HPD lists as open, by class (C immediately hazardous, B hazardous, A non-hazardous), read through
-- OpenVibe.Sources (housing_violation_tally). The building is a landlord entity named by its address.
ALTER TABLE review_records DROP CONSTRAINT IF EXISTS review_records_kind_check;
ALTER TABLE review_records ADD CONSTRAINT review_records_kind_check CHECK (kind IN ('complaint_tally', 'inspection_violation', 'housing_violation_tally'));
