-- phase: expand
-- Account export and deletion (ADR-033) now that Reviews holds what people write (members' reviews, 0004):
-- account_data_events keeps one receipt per export or deletion delivery Reviews applied, so a redelivered deletion
-- never erases twice and a confirmation that failed is sent again (openvibe-sdk/account-data, its ACCOUNT_DATA_SCHEMA).
CREATE TABLE IF NOT EXISTS account_data_events (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    subject TEXT NOT NULL,
    outcome JSONB,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at TIMESTAMPTZ
);
