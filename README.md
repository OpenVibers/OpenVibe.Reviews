# OpenVibe.Reviews

> Review signals gathered across sources with provenance, entity resolution and honest aggregates.

**Status:** alpha (roadmap Wave 17, Reviews half). Runs and is tested against stub upstreams; **not deployed**, and `openvibe.reviews` still shows its placeholder on OpenVibe.Sites.
**Domain:** `openvibe.reviews` · **Port:** 4830 · **Service id:** `reviews`
**Plan:** OpenVibe End-to-End Realignment & Implementation Plan, revision 3 — roadmap Wave 17, §15.13, §29, §32.
**License:** AGPL-3.0 (same as every OpenVibe service).

## Purpose

Entity resolution plus the interpretation and publication layer for review signals. Reviews reads
what sources stated (through OpenVibe.Sources), attributes each observation to the thing it is
about, shows every number with where it came from and when it was read, and computes an aggregate
only from the signals that exist. It **never fabricates a rating and never presents AI output as
user reviews**: summaries are text written or approved by a person, every point cites the signals
it rests on, and nothing a summary says can become a number.

## Owns

The nine authority tables of §15.13, in Reviews' own SQLite database:

| Table | What it holds |
|---|---|
| `review_entities` | the things reviewed (kind, slug, state `active`/`merged`/`deleted`, `merged_into`) |
| `review_entity_aliases` | names, URLs, GTIN/SKU/MPN, source bindings and external ids used for resolution (strong identifiers are unique) |
| `review_sources` | the OpenVibe.Sources sources Reviews has seen: name, homepage, licence and terms notes, health |
| `review_source_items` | Sources items Reviews read — signal fields only, **never review text** — with provenance and how each was resolved |
| `review_signals` | typed observations (`recommendation`, `recommendation_tally`, `rating`, `rating_aggregate`) from one item revision, with provenance; values immutable (SQLite triggers), status `active`/`superseded`/`withdrawn` |
| `review_summaries` | one editorial summary per entity, its publication state and review flag |
| `review_summary_revisions` | immutable summary revisions (openvibe-publishing/revisions) with authorship |
| `review_trust_metadata` | editor trust decisions per source / signal / entity (exclude from the aggregate with a visible reason, limitation and verification notes), history kept |
| `review_entity_links` | typed links between entities or to another service's EntityRef; a merge is a `merged_into` link (who, when, why), a split ends it |

Helper tables: `review_aggregates` (every aggregate revision, immutable), `review_summary_citations`,
`review_corrections`, `review_audit` (append-only editorial log), `review_import_queue`,
`review_sync_state`, plus the Publishing packages' `review_summary_reviews`, `review_summary_drafts`,
`review_entity_redirects`, `review_discussion_refs`, `review_index_revisions` and the SDK's
`review_event_outbox` / `review_event_inbox`.

## Does not own

- **discussion** — OpenVibe.Community holds the threads and comments; Reviews stores the thread id and shows the comments as Community serves them
- **source adapter policy and ingestion** — OpenVibe.Sources decides what is fetched, under which terms, and keeps the items
- **AI generation** — OpenVibe.AI runs `reviews.summarize_entity`; Reviews only accepts its output as a draft
- **search** — OpenVibe.Search indexes the documents Reviews sends

## What works

**Signals from Sources.** Two paths feed one `applyItem()`: a pull of `GET /api/v1/items?category=reviews&include_removed=1`
in change order (cursor stored per page, a restart resumes) and the `sources.item.*` events through a
signed webhook + inbox (created/updated items are queued and fetched by id; removals apply at once).
An item becomes at most one signal: Steam `appreviews` items (`review_signal`, the Sources seed) give a
`recommendation` from `voted_up`, with the reviewer facts Steam states (bought on Steam, received for
free, playtime) as trust metadata; `total_positive/total_reviews` give a `recommendation_tally`;
JSON-LD products give a `rating_aggregate` only when the page states a count; JSON-LD reviews give a
`rating`. A rating whose source did not state the scale is recorded but left out of the aggregate
with the reason shown. Each signal keeps the Sources item id and revision, the retrieval time, the
source's publication time, the canonical URL and the licence note; a later revision of the item
supersedes it, a removal withdraws it. A Sources outage changes nothing and invents nothing.

**Resolution.** Deterministic rules, strongest first: a source binding (every item of that source is
about one entity), the item's URL (normalised), GTIN (normalised to 14 digits), SKU, MPN. One entity →
resolved. Identifiers naming different entities → ambiguous. A name alone never resolves: it yields
candidates for an editor. Nothing → unmatched, listed on the editor desk. Editors confirm (optionally
remembering the identifier, which settles other waiting items), re-attribute or ignore; every decision
is in the audit log.

**Merge and split.** A merge rewrites nothing: the merged entity keeps its aliases and its signals keep
their attribution; it becomes `merged` with an active `merged_into` link and its page answers 301 to
the target, whose aggregate spans both. A split ends the link and restores the pre-merge attribution
exactly (tested as a round trip), recomputes both aggregates and flags the former target's summary if
it cited signals that went back. Both are audited (link row, audit log, `reviews.entity.merged|split`).

**Aggregates** (method `reviews-aggregate@1`, a pure function in `server/reviews/aggregate.js`):
recommendation share = positives ÷ total (a source's own tally replaces its single recommendations);
rating = count-weighted mean of value ÷ best, as a percentage and on the shared scale when there is
one. Editors can exclude a source or signal, with a reason shown on the page. The aggregate lists its
inputs, exclusions and computation. **With no qualifying signal it is absent — `null`, not zero, not
a placeholder** — and every change of inputs records a new aggregate revision (including the one where
nothing is left).

**Summaries.** Editors write overview + pros + cons; every pro and con cites signals of the entity
(uncited points, foreign or inactive signals, and any field that looks like a rating are refused).
OpenVibe.AI's `reviews.summarize_entity` is a seam: `POST …/summary/proposals` stores a draft
revision with ai authorship (workflow and run id, stub flag); it is never published by that call, stays
off the page, feeds and Search, cannot be published until a person approves it, and AI text that states
a rating ("4.5/5", "9 out of 10", star glyphs) is refused. When a cited signal is withdrawn or replaced,
the summary is flagged on the page, the gate marks it `unsupported_claims` (noindex), and a pending
revision (citations moved to replacements, unsupported points dropped) waits for an editor's approval.

**Corrections.** Signed-in people send corrections (entity, alias, signal, summary, aggregate, optional
evidence URL) from the entity page or `reviews.correction.submit`; editors accept or reject them on the
desk. Correction text is not published.

**Pages (SSR, useful without JavaScript).** `/`, `/about`, `/search`, `/e/:slug` (aggregate with inputs
and computation, summary with citations, signal table with provenance and timestamps, sources and
limitations, discussion), `/e/:slug.json`, `/e/:slug/history` (aggregate revisions, summary revisions,
merges and splits, every signal including withdrawn ones, editorial log), `/e/:slug/summary/:n`,
`/e/:slug/correct`, and the editor desk (`/editor`, new entity, edit, summary form with signal pickers,
merge/split, item resolution, trust decisions, corrections) — all plain form posts behind Network SSO.
Old slugs 301, merged entities 301, deleted ones 410.

**Structured data and discovery.** JSON-LD `Product` / `VideoGame` / `SoftwareApplication` / … with
`AggregateRating`, and a `Review` for a summary, are emitted **only when the aggregate exists** (i.e.
real signals back it); without signals the page carries breadcrumbs only (tested). A recommendation
share is expressed as `ratingValue` 0–100 with `bestRating: 100` and the real count; a summary's
`Review` never has a `reviewRating`. The openvibe-publishing v0.2.0 gate decides robots per entity
(no live signal → `unsourced`, summary under the word minimum → `thin`, unsupported points →
`unsupported_claims`, unreviewed AI → hidden); sitemaps list indexable entities only, Atom/JSON feeds
list published summaries, `robots.txt` and `llms.txt` are served, and Search receives
`reviews.index_document.upserted|deleted` with Sources items as provenance.

**Operations.** `/api/health`, `/api/ready` (DB required; Network key, Sources, Events relay, webhook
secret, Community and editors reported), `/release.json`, `/metrics` (outbox and backlog gauges).

## Routes

| Path | What |
|---|---|
| `GET /`, `/about`, `/search?q=` | home (entities with source data), method, search |
| `GET /e/:slug`, `/e/:slug.json`, `/e/:slug/history`, `/e/:slug/summary/:n` | entity page, JSON, history, one summary revision |
| `GET|POST /e/:slug/correct`, `POST /e/:slug/discuss` | correction (signed in), comment via Community |
| `/editor`, `/editor/entities/new`, `/e/:slug/edit`, `/editor/items/:id`, … | editor desk (editors only) |
| `/robots.txt`, `/sitemap.xml`, `/sitemaps/*.xml`, `/feed.atom`, `/feed.json`, `/llms.txt` | discovery |
| `POST /internal/events` | OpenVibe.Events deliveries (`sources.item.*`), HMAC-signed; not proxied publicly |
| `/auth/*` | Network SSO (client `reviews`) |

## API `/api/v1`

People use their Network JWT; services use a client-credentials token for audience
`openvibe.reviews` and act for the person in `X-OV-Subject`. One capability per route; editorial
writes need an editor who is a person (staff or `REVIEWS_EDITORS`). Errors are RFC 9457 problem+json.

| Capability | Routes |
|---|---|
| `reviews.entity.resolve` | `POST /resolve`, `GET /entities`, `GET /entities/:ref`, `/history`, `/aggregate`, `/summary/revisions/:n`, `GET /items`, `GET /items/:id`, `POST /items/:id/resolution` |
| `reviews.entity.manage` | `POST|PATCH|DELETE /entities[/:ref]`, aliases, links, `POST /trust`, `GET /corrections`, `PATCH /corrections/:id` |
| `reviews.entity.merge` / `reviews.entity.split` | `POST /entities/:ref/merge` `{ into, note }`, `POST /entities/:ref/split` `{ note }` |
| `reviews.signal.import` | `POST /signals/import` `{ source_item_id }`, `POST /sources/sync` |
| `reviews.summary.propose` | `POST /entities/:ref/summary/proposals` (OpenVibe.AI) |
| `reviews.summary.publish` | `POST /entities/:ref/summary/revisions`, `…/revisions/:n/review`, `…/summary/publish`, `…/summary/unpublish` |
| `reviews.correction.submit` | `POST /entities/:ref/corrections` |

The ids are proposed in [docs/capabilities-proposal/](docs/capabilities-proposal/) (with
[docs/service-manifest-proposal.json](docs/service-manifest-proposal.json)); `server/auth/capabilities.js`
decides them with the contracts grant rule until a release defines them. `reviews.entity.manage` and
`reviews.summary.propose` are additions to the §15.13 minimum list.

## Events

Produced (transactional outbox → OpenVibe.Events when `EVENTS_URL` is set): `reviews.entity.merged`,
`reviews.entity.split`, `reviews.signal.added` (with `replaces`), `reviews.signal.removed` (status,
reason, `replaced_by`), `reviews.summary.published|updated|unpublished`, and the Search index events
`reviews.index_document.upserted|deleted`. Consumed: `sources.item.created|updated|removed`
(subscription created with `scripts/subscribe.js`).

## Running it

```bash
fnm exec --using=22.22.1 npm install
cp .env.example .env
fnm exec --using=22.22.1 npm run dev      # http://127.0.0.1:4830
fnm exec --using=22.22.1 npm test         # every test/*.test.js on temp databases with stub upstreams
```

Production: `/opt/openvibe.reviews`, env `/etc/openvibe/reviews.env`, unit
[deploy/systemd/openvibe-reviews.service](deploy/systemd/openvibe-reviews.service), store
`/var/lib/openvibe-reviews/reviews.db`, nginx [deploy/nginx/openvibe.reviews.conf](deploy/nginx/openvibe.reviews.conf).
There is **no seed**: a fresh database holds no entity, signal, summary or rating. Entities are created
by editors; signals arrive only from Sources.

## Depends on

- OpenVibe.Network — SSO (OAuth client `reviews`), signing key, service principal `svc:reviews`
- OpenVibe.Sources — review items (`sources.item.read`, `sources.source.read`); its reviews seed (Steam appreviews for Portal 2) is disabled until a person verifies its terms, so until then Reviews has nothing to show
- OpenVibe.Events — outbound events (`events.event.publish`) and the `sources.item.*` subscription
- OpenVibe.Community — discussion threads (`community.comment.write`)
- OpenVibe.AI — optional, proposes summaries through `reviews.summary.propose`
- OpenVibe.Search — consumes the index events
- packages: openvibe-publishing v0.2.0, openvibe-contracts v0.19.0, openvibe-shared v1.3.0, openvibe-sdk v0.2.2

## Acceptance (tested in `test/`)

- **no aggregate without signals**: `null`, no aggregate row, and it disappears again (as a recorded revision) when the last signal is withdrawn (`signals.test.js`, `aggregate.test.js`)
- **AggregateRating JSON-LD absent without signals**, present with the real value and count while signals back it, gone after removal (`nojs.test.js`)
- **merge → split round trip exact**: attribution, aliases and aggregates restored; merge/split audited and evented (`merge.test.js`)
- **source removal changes the next aggregate** (webhook and pull paths); an item update supersedes its signal (`signals.test.js`)
- **AI text never yields a rating**: rating fields and rating text refused; an AI draft is never published, shown, fed or indexed before a person approves it (`summaries.test.js`)
- **provenance on every signal**, enforced by the schema, immutable by trigger; review text never stored (`signals.test.js`)
- **no-JS**: every public page and every editor workflow works with plain HTML and form posts; Community comments are shown, never copied (`nojs.test.js`)
- a withdrawn cited signal flags the summary and prepares a pending revision that only a person can publish (`summaries.test.js`)
- deterministic resolution; a name alone never resolves; permissions and capabilities enforced (`resolution.test.js`)
- every event validates as `events.event-envelope@1` and every index document as `search.index-document@1`; proposals validate against the contracts schemas; nothing seeded (`signals.test.js`, `proposals.test.js`)

Not yet demonstrated: a run against the deployed Sources with a real, enabled review source (none is
enabled), a real OpenVibe.AI `reviews.summarize_entity` run, and delivery through the deployed Events.

## Launch rule

This repository does not make the product real on its own. `openvibe.reviews` keeps its placeholder
page on [OpenVibers/OpenVibe.Sites](https://github.com/OpenVibers/OpenVibe.Sites) until all of the
following hold (plan §12.12):

1. an owning runtime with health/readiness endpoints and observability — **built** (`/api/health`, `/api/ready`, `/metrics`);
2. canonical identity/auth integration (Network subjects, a scoped service principal) — **built**, principal and grants not provisioned yet;
3. server-rendered public routes useful without JavaScript — **built**;
4. real persistence and end-to-end workflows — **built**, not deployed, and no Sources review source is enabled yet;
5. capability and event registration against OpenVibe.Contracts — **proposed** in `docs/`, not released;
6. a migration/seed strategy (none: nothing to migrate, nothing seeded), a security/threat review, sitemap/robots/feed behaviour — discovery **built**; the security review is the lead's;
7. acceptance tests proving the advertised functionality — **built** (`npm test`).

The launch release removes `openvibe.reviews` from `OpenVibe.Sites/sites.json`, switches routing to
this service and registers its maturity in the ecosystem registry **in the same release it goes live**.
A placeholder is never counted as an implemented service, and this README does not call the product
live until that release has happened.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).
