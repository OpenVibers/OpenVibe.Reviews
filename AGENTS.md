# AGENTS.md — OpenVibe.Reviews

## Project Overview

OpenVibe.Reviews gathers review signals from sources with provenance, resolves them to entities, and publishes honest
aggregates and editor-written summaries. It also carries members' own reviews, the ratings other sites show (saved by
members), and official records (inspections, complaints, violations). "Every review site, one search" is the reader
promise; nothing is invented and no review text from a source is stored.

- **Domain:** `openvibe.reviews` · **Port:** 4830 · **Service id:** `reviews`
- **Runtime:** Node 22, Express 4, PostgreSQL 18 through `openvibe-sdk/db` (PGlite in development/tests), Valkey 9
  optional for shared per-actor limits.
- **Read first:** [README.md](README.md), [STATUS.json](STATUS.json), [docs/threat-review.md](docs/threat-review.md),
  [.env.example](.env.example).

**Network context:** identity, sessions and roles are OpenVibe.Network (`reviews` OAuth client, PKCE; service
principal `svc:reviews`). Source items and terms are OpenVibe.Sources (`sources.item.read`, `sources.source.read`) —
Reviews never fetches a site. Discussion threads are OpenVibe.Community (`community.comment.write`). AI summaries are
proposals from OpenVibe.AI (`reviews.summary.propose`); Reviews only accepts them as drafts. Search consumes the index
events. Event delivery is OpenVibe.Events.

## Commands

```bash
npm ci                         # install (contracts/sdk/shared/publishing pinned by tag)
npm run dev                    # http://localhost:4830, PGlite under data/
npm start                      # node server/index.js
npm test                       # every test/*.test.js, temp PGlite, mock Network/Sources/AI
npm run test:pg                # the same through PostgreSQL + PgBouncer
npm run subscribe              # create the sources.item.* subscription (first install)
npm test -- aggregate          # only test files whose name contains the word
node --check <file.js>         # syntax check (no linter configured)
```

No build step: pages are server-rendered; CSS only under [public/css/](public/css/) (`reviews`, `everywhere`,
`outcomes`). Every page and form works without JavaScript.

## Architecture at a Glance

- **Entry:** [server/index.js](server/index.js) — `start()` builds the app and (when asked) the Sources pull, import
  queue and Events outbox relay; tests call `start({ workers: false })`. Graceful stop. `REVIEWS_DRILL` keeps
  boot-time work off.
- **App factory:** [server/app.js](server/app.js) — CSP, session, `/auth`, `/internal/events`, `/shared`+static,
  pages, `/api/v1`, discovery, 404/error handler.
- **Config:** [server/config.js](server/config.js) — `load(env)` is pure; production `/etc/openvibe/reviews.env`.
- **Domain:** [server/reviews/](server/reviews/) — `service.js`, `source-items.js` (Sources ingest/resolution),
  `aggregate.js` (the honest aggregate), `extract.js` (signals and values), `home.js`, `everywhere.js` (the
  every-review-site search), `access.js`, `account-data.js`.
- **HTTP:** [server/http/api.js](server/http/api.js), [server/http/pages.js](server/http/pages.js),
  [server/http/events.js](server/http/events.js), [server/http/machine.js](server/http/machine.js) (robots,
  sitemaps, feeds, llms), [server/http/actor-limits.js](server/http/actor-limits.js), [server/http/common.js](server/http/common.js).
- **Auth/capabilities:** [server/auth/session.js](server/auth/session.js), [server/auth/viewer.js](server/auth/viewer.js),
  [server/auth/capabilities.js](server/auth/capabilities.js) (the Contracts grant rule), [server/auth/keys.js](server/auth/keys.js).
- **Clients/integrations:** [server/integrations/platform.js](server/integrations/platform.js), Sources through
  `openvibe-publishing/ingest`, Community and Events through the SDK.
- **Rendering:** [server/render/](server/render/) (`layout.js`, `views.js`, `short.js`); agent twins
  [server/agent-pages.js](server/agent-pages.js), [server/agent-descriptor.js](server/agent-descriptor.js).
- **Database:** [server/db.js](server/db.js) and [migrations/](migrations/). Authority tables: `review_entities`,
  `review_entity_aliases`, `review_sources`, `review_source_items`, `review_signals`, `review_summaries`,
  `review_summary_revisions`, `review_trust_metadata`, `review_entity_links`. Helpers: `review_aggregates`,
  `review_member_reviews`, `review_seen_ratings`, `review_records`, `review_summary_citations`, `review_corrections`,
  `review_audit`, `review_import_queue`, `review_sync_state`, `review_summary_reviews`, `review_summary_drafts`,
  `review_entity_redirects`, `review_discussion_refs`, `review_index_revisions`, `review_event_outbox`,
  `review_event_inbox`, `account_data_events`, `telemetry_samples`.
- **Deploy:** [deploy/systemd/openvibe-reviews.service](deploy/systemd/openvibe-reviews.service) (127.0.0.1:4830,
  `/etc/openvibe/reviews.env`, `/opt/openvibe.reviews`) and [deploy/nginx/openvibe.reviews.conf](deploy/nginx/openvibe.reviews.conf).
  `sudo ovhost deploy reviews` (git-checkout, database `ov_reviews`, migrations at boot add tables/columns only);
  rollback on a failed `/api/ready`, then `sudo ovhost rollback reviews --to <sha>`.

## Ownership and Boundaries

Reviews owns entities/aliases, the Sources items it read (signal fields only — **never review text**), typed signals
with provenance, summaries and immutable revisions, trust decisions with history, typed links/merges, aggregates,
member reviews, seen ratings, official records, corrections and the append-only editorial audit. It does **not** own
discussion (Community), source adapter policy or ingestion (Sources), AI generation (AI), the search index (Search),
accounts/roles (Network) or event delivery (Events). A merge is a `merged_into` link with who/when/why and can be
reversed by a split; never delete an entity to hide a merge.

## Auth and Capabilities

One capability per route, audience `openvibe.reviews`; a service acting for a person sends `X-OV-Subject`. Editorial
writes need a person who is staff or in `REVIEWS_EDITORS`. A cookie write started by another site is 403
`request.cross_site` (Bearer tokens are unaffected). Errors are RFC 9457 problem+json.

| Capability | Covers |
|---|---|
| `reviews.entity.resolve` | `POST /resolve`, reads, history/aggregate/summary revision, items and item resolution |
| `reviews.entity.manage` | entity CRUD, aliases, links, trust, corrections queue/resolve |
| `reviews.entity.merge` / `.split` | merge into another entity, split a merge |
| `reviews.signal.import` | signal import, source sync |
| `reviews.summary.propose` | AI proposal (the only AI write) |
| `reviews.summary.publish` | create/review/publish/unpublish a summary revision |
| `reviews.correction.submit` | a person's correction |

Outbound: `sources.item.read`, `sources.source.read`, `events.event.publish` + `events.subscription.manage`,
`community.comment.write`. Per-actor limits ([server/http/actor-limits.js](server/http/actor-limits.js)): reads
120/min–3000/h, entity writes 30/300, merge/split 10/100, item resolution and import 60/1200, sync now 2/20, summary
writes 30/300, proposals 60/1200, correction submit 5/20, correction resolve 30/300, discussion comment 20/300. A
form and its API route share one budget; forms count only a signed-in person. Never limit health/readiness/release/
metrics, sign-in, public reads (per-address only) or signed `/internal/events`.

## API and Pages

Pages: `/`, `/about`, `/search`, `/e/:slug` (+ `.json`, `/history`, `/summary/:n`), `GET|POST /e/:slug/correct`,
`POST /e/:slug/discuss`, the editor desk (`/editor/...`, `/e/:slug/edit`), and discovery
(`/robots.txt`, `/sitemap.xml`, `/sitemaps/*.xml`, `/feed.atom`, `/feed.json`, `/llms.txt`).
API `/api/v1`: `POST /resolve`, `GET /entities`, `/entities/:ref`, `/history`, `/aggregate`,
`/summary/revisions/:n`, `GET /items`, `/items/:id`, `POST /items/:id/resolution`, entity/alias/link/trust writes,
`POST /signals/import`, `POST /sources/sync`, summary proposals/revisions/review/publish/unpublish, correction
submit/resolve, merge/split, `GET /corrections`. `/internal/events` is loopback-only and HMAC-signed; machine
endpoints are loopback for `/metrics`.

## Conventions

- CommonJS, 4-space indent, single quotes, semicolons; no linter/formatter.
- **Provenance is mandatory** on every signal/aggregate: source item, revision, observed/retrieved date, the source's
  terms. The same item revision's signal values are immutable (database triggers); a changed value is a new signal and
  the old one is `superseded`/`withdrawn` with a reason.
- The aggregate never silently drops a signal: a trust exclusion needs a visible reason, limitation and verification
  notes (`review_trust_metadata`; history kept). Official records are labelled as records, separate from ratings.
- New schema = a new `migrations/NNNN_name.sql`; never edit one that has run. Keep `review_` prefixes.
- Source text is never copied: store signal fields and quotes only where the licence allows. A source removal drops
  its signals and recalculates, never leaves a stale number.
- Summaries: editor-written or AI proposal, immutable revisions, authorship, citations to the signals; an AI draft
  needs a person's review before publish. A correction is published at once with `correction_note`/`correction_id`.
- CSP: add origins to `helmet` in [server/app.js](server/app.js); Community comments are rendered from its API, never
  copied into Reviews' HTML storage. No Font Awesome; shared glyphs.
- Phone first: entity, search, editor and home pages fit 390 px; forms work without JS.
- Empty states use the shared kit. "Calm reduces, only Off removes": excluding a source from an aggregate is visible
  and reversible; only a takedown/delete removes data.
- Hostile text stays text in every page, JSON, JSON-LD, feed, sitemap and Search document.

## Key Pitfalls

- **Never fetch a source or a user-supplied URL.** Ingest only through Sources; an alias/URL is stored and rendered,
  never requested. [docs/threat-review.md](docs/threat-review.md) is the threat model.
- **Strong identifiers are unique** (GTIN/SKU/MPN, source binding, external id); a conflicting resolution is a review
  action, not a silent overwrite. Merges/splits are audited and reversible; old slugs redirect.
- **Signals are immutable:** a trigger rejects an UPDATE of the value fields. A re-import of the same revision is a
  no-op; a new revision supersedes the old with `replaces`.
- **Corrections:** anyone signed in may submit; only staff/editor resolves. Accepting with a correction also needs
  `reviews.summary.publish`, and the resulting revision carries the correction note.
- **Per-actor budgets** must be checked after the actor is resolved and the capability passed, before any work; a form
  budget is not a second allowance.
- **AI summaries** are drafts only; the stub provider's output is never public, and no AI call happens without the
  optional AI URL.
- **Drill mode** keeps the Sources pull, import queue, outbox relay and timers off.
- **`review_event_outbox`** needs its rejected partial index (migration 0009); keep it.
- Account deletion removes a person's member reviews/seen ratings and receipts through `/internal/events`; a
  redelivery changes nothing.

## Testing

`npm test` runs each file in its own process on temp PGlite with mock Network/Sources/AI: resolution/aliases,
signals/aggregates, summaries/proposals/publish, corrections, merges/splits, member reviews/seen ratings, official
records, home/sitemap/link-header/IndexNow, no-JS/pages, capabilities/delegation, actor limits, account data, CSP,
Ink/contrast, threat, service kit and perf budgets. `npm run test:pg` for PostgreSQL. Run the narrowest file first,
then the suite; always `node --check` changed files.

## Documentation

- [README.md](README.md) — purpose, every-review-site search, member reviews, outside ratings, official records,
  owns/does-not-own, what works, routes, API, limits, events, dependencies, capabilities, acceptance, security, deploy.
- [docs/threat-review.md](docs/threat-review.md) — the pre-launch threat review.
- [docs/capabilities-proposal/](docs/capabilities-proposal/) and [docs/service-manifest-proposal.json](docs/service-manifest-proposal.json).
- [STATUS.json](STATUS.json), [.env.example](.env.example), [CHANGELOG.md](CHANGELOG.md), [SECURITY.md](SECURITY.md).
