# OpenVibe.Reviews

> Review signals gathered across sources with provenance, entity resolution and honest aggregates.

**Status:** placeholder — planning only, no runnable code yet.  
**Domain:** `openvibe.reviews`  
**Plan:** OpenVibe End-to-End Realignment & Implementation Plan, revision 3 (20 Sep 2026), §12.8.  
**License:** AGPL-3.0 (same as every OpenVibe service).

## Purpose

Entity resolution plus the interpretation/publication layer for review signals. It never fabricates ratings or presents AI output as user reviews.

## Owns

- `review_entities`, `review_entity_aliases`, `review_sources`, `review_source_items`, `review_signals`, `review_summaries`, `review_summary_revisions`, `review_trust_metadata`, `review_entity_links`

## Does not own

- discussion (Community)
- source adapter policy

## Planned surfaces

- resolve names/URLs/SKUs/places to entities with audited merge/split, provenance for every excerpt, pros/cons/themes with source references, coverage/trust limitations, correction/dispute workflow

## Data (authority tables / families)

- see above

## Capabilities and events

- `reviews.entity.resolve|merge|split`, `reviews.signal.import`, `reviews.summary.publish`, `reviews.correction.submit`

Events: ``reviews.entity.merged|split``, ``reviews.signal.added|removed``, ``reviews.summary.published|updated``

## Depends on

- source registry
- OpenVibe.AI
- Search
- OpenVibe.Community
- OpenVibe.Events

## Acceptance (must be true before "done")

- entity merges are reversible and audited
- every signal retains source identity and timestamp
- no generated star rating exists without supporting source data
- source removal updates the next aggregate revision

## Bootstrap / extraction source

No current implementation; Wave 15.

## Launch rule

This repository does not make the product real, and the domain keeps its placeholder page on
[OpenVibers/OpenVibe.Sites](https://github.com/OpenVibers/OpenVibe.Sites) until all of the
following exist here (plan §12.12):

1. an owning runtime with health/readiness endpoints and observability;
2. canonical identity/auth integration (OpenVibe.Network subjects, scoped service principals);
3. server-rendered or static public routes that are useful without JavaScript;
4. real persistence and end-to-end workflows;
5. capability and event registration against `OpenVibe.Contracts`;
6. a migration/seed strategy, a security/threat review, and sitemap/robots/feed behaviour;
7. acceptance tests proving the advertised functionality.

The launch release removes the domain from `OpenVibe.Sites/sites.json`, switches routing and
registers maturity in the ecosystem registry atomically. A placeholder is never counted as an
implemented service.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).
