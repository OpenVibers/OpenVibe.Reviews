# OpenVibe.Reviews threat review

**Date:** 2026-09-23 · **Code reviewed:** `main` at `223262a` (every `file:line` below refers to that
commit) · **Scope:** this repository, its nginx vhost and systemd unit, and the parts of the pinned
packages it relies on (openvibe-publishing v0.2.1, openvibe-contracts v0.20.0, openvibe-sdk v0.4.0,
openvibe-shared v1.3.0).

This is the service authors' own review, written from the code. It is not an independent review.
Each section lists what an attacker would try, the controls that exist (with the lines that
implement them), and the gaps. A gap is either **fixed in this pass** (commit `223262a`, tested in
`test/threat.test.js`; the correction workflow in `91e613d`, tested in `test/corrections.test.js`)
or **remaining**, with the reason it was not fixed here.

## What is worth attacking

| Asset | Why someone wants it |
|---|---|
| The aggregate on an entity page (and its `AggregateRating` JSON-LD) | move a product's number up or down, in search results too |
| Entity attribution (aliases, merges, source bindings) | put a competitor's signals on the wrong product, hide bad ones |
| Published summaries | make the site say something false or promotional, with the editors' name on it |
| Correction requests | the reporter's identity and what they wrote are private; the queue is the editors' attention |
| Editor rights | every other asset follows from them |
| Search documents, sitemaps and feeds | anything in them is copied beyond this site |

Trust boundaries: browsers (anonymous or signed in with the Network `ov_token`); first-party
services with Network service tokens (`svc:…`); third-party apps and modules (`app:…`, `mod:…`);
OpenVibe.Sources (the only origin of signals); OpenVibe.Events (webhook deliveries); OpenVibe.AI
(summary drafts); OpenVibe.Community (discussion); OpenVibe.Search (receives documents).

## 1. Entities, claims, aliases and merges

**Threats.** Create a fake entity to collect traffic or look legitimate; attach signals to the wrong
entity through an alias or a source binding; merge two entities so that one inherits the other's
aggregate; "claim" an entity as its owner and suppress bad signals.

**Controls.**

- Only an editor creates an entity (`server/reviews/service.js:1084`); every other entity change
  needs an editor who is a person (`requireEditorPerson`, `service.js:167-171`; used at `:1107`,
  `:1134`, `:1149`, `:1161`, `:1173`, `:1195`, `:1214`, `:1245`, `:1318`, `:1341`, `:1354`).
- An entity with no live signal is `unsourced` for the indexability gate (`server/config.js:68-71`),
  so it is noindex and absent from sitemaps (`server/http/machine.js:31`); the home page lists only
  entities with a live signal or a published summary (`service.js:1535`).
- A strong identifier (URL, GTIN, SKU, MPN, source binding, external id) names one entity at a time
  (`server/db.js:77`, refused with `alias.taken` at `service.js:885`). A name alone never resolves an
  item (`service.js:717`), and conflicting identifiers make an item ambiguous instead of guessing
  (`service.js:706`); an editor confirms either (`service.js:1318`).
- A merge rewrites nothing: it needs an editor person, refuses self-merges and cycles
  (`service.js:1214-1221`), allows one active merge per entity (`db.js:225`), is written to the
  append-only audit log (triggers `db.js:270-273`) and emitted as `reviews.entity.merged`, is listed
  on the public history page, and a split restores the earlier attribution exactly (`merge.test.js`).
- There is no owner "claim": nobody gets rights over an entity by being its maker. An owner who
  thinks a signal is wrong sends a correction like anyone else.

**Gaps.**

- *Remaining:* a source binding (`alias` type `source`) attributes every item of that Sources source
  to one entity. A wrong binding by an editor misattributes all of them at once. It is audited
  (`alias.added`) and undone by removing the alias and re-attributing; the control is editor
  judgement, which this service cannot replace.
- *Remaining:* splitting one entity into two new ones (as opposed to undoing a merge) is not built,
  so an editor who created a single entity for two products must fix attribution item by item.

## 2. Sources: registration, provenance, licensed text, takedowns, SSRF

**Threats.** Feed invented signals; strip provenance so a number cannot be traced; republish review
text Reviews has no licence for; keep a taken-down review visible; make the server fetch an
attacker-chosen URL (SSRF).

**Controls.**

- Reviews registers no sources. OpenVibe.Sources decides what is fetched and under which terms;
  Reviews records the source notes it is given (`service.js:753`). Signals are created only from
  items Sources returned: by the pull (`server/reviews/sync.js`), by a queued fetch after an event,
  or by `POST /signals/import`, which needs an editor or a granted service (`server/http/api.js:131`).
- An item without `retrieved_at` and `content_hash` cannot become a signal (`service.js:771-779`).
  A signal's values and provenance are immutable and it is never deleted (triggers `db.js:161-166`);
  there is at most one active signal per item (`db.js:158`).
- Review text is never stored: `keptFields` keeps numbers, flags and identifiers
  (`server/reviews/extract.js:56`), strings at most 200 characters (`extract.js:45`), and a title only
  for product pages (`extract.js:71-72`) (`signals.test.js`).
- A removal at the source withdraws the signal, records a new aggregate revision and flags the
  summaries that cite it (`service.js:731-746`); `GET /api/v1/items/:id` answers 410
  (`api.js:115`, `takedown.test.js`); a removed item is never revived by a later pull
  (`service.js:817`).
- No SSRF surface: Reviews fetches only configured base URLs — Sources with item ids and source keys
  checked against fixed patterns and URL-encoded (`server/integrations/platform.js:20-21`, `:72-95`),
  Community (`platform.js:110-123`), the Network (sign-in, keys) and Events (SDK outbox). No URL a
  person or a source supplies is ever fetched: a correction's evidence URL is only parsed and
  scheme-checked (`service.js:1551`), and source URLs are only rendered (`server/render/views.js:31`).
  The test harness throws on any unexpected outbound request (`test/helpers.js:156-161`).

**Gaps.**

- *Fixed in this pass:* a rating below the source's stated worst, or below zero when no worst is
  stated, became a signal and could drag the aggregate below 0 %. It is now recorded without a
  signal and with the reason (`extract.js:79-84`).
- *Remaining:* legal erasure of summary text. Deleting an entity (`service.js:1134-1140`) makes its
  pages 410 and its Search document a tombstone, but summary revisions are kept.
  openvibe-publishing's `revisions.purgeEntity` exists for this; exposing it needs a decision on who
  may purge and what record stays, so it is not wired up.
- *Remaining:* Reviews trusts the licence and terms notes Sources sends. Verifying a source's terms is
  a person's job in Sources (no review source is enabled yet).

## 3. AI summaries

**Threats.** Prompt injection through source content steering OpenVibe.AI's draft; a draft that
invents a rating or claims unsupported by the data; AI text published as if a person wrote it; AI
drafts leaking to readers or Search before review.

**Controls.**

- Reviews runs no model. The only AI path is `POST …/summary/proposals` (`reviews.summary.propose`),
  accepted only from a service principal (`service.js:1413`) that names its workflow and run
  (`service.js:1416`). What a model can read through the API is numbers, product titles and source
  names, never review text (section 2), which keeps the injection surface small.
- A summary has no field that can carry a rating (`RATING_KEY_RE`, `service.js:46`, checked in
  `checkSummaryInput`, `service.js:314`), and AI text that states one is refused (`RATING_TEXT_RE`,
  `service.js:50-53`, applied at `:327`). Ratings come only from signals.
- Every point cites signals, and every cited signal must be active and belong to the entity
  (`service.js:334-337`); overview, point count and point length are capped (`service.js:34-36`).
- An AI draft is published only after a person approves it (`service.js:1467`); until then it is
  not on the page, not in the history readers see (`publicRevision`, `service.js:455-460`), not in
  feeds and not in Search (`summaries.test.js`). The page labels AI authorship from the revision's
  authorship record; a person's correction of AI text is labelled AI-assisted (hybrid), never
  "written by a person" (`service.js:386-392`).
- A pending revision prepared after a source change also needs an editor's approval
  (`service.js:1468`); a point without a live citation cannot be published (`service.js:1470`).

**Gaps.**

- *Fixed in this pass:* AI text could state a rating in words ("four and a half stars", "nine out of
  ten", "five-star"); `RATING_TEXT_RE` now covers spelled-out numbers (`service.js:47-53`).
- *Remaining:* citations are checked for existence, not meaning. A draft can cite a real signal for a
  claim it does not support. The editor who approves the draft is the control; the approval is
  recorded and shown.
- *Remaining:* the rating-text check is a heuristic (other languages, "4½", unusual phrasings get
  through). Same control: human review before publication.
- *Remaining:* no per-principal quota on proposals; a misbehaving AI principal can fill the editor
  desk with drafts. It is a first-party principal holding a granted capability, and the grant can be
  withdrawn in the Network.

## 4. Corrections

**Threats.** Flood the editors' queue; learn who reported what; use a correction to slip text onto
the page; an editor quietly rewriting a published summary; a correction that leaves no public trace.

**Controls.**

- Only a signed-in person sends a correction (`service.js:1544`); the text is 10–4000 characters
  (`service.js:1547-1548`); the evidence URL must be http(s) (`service.js:1551`). Per-address limits:
  20 an hour on the API and the form (`server/app.js:102`, `:113`), plus nginx's write zone
  (`deploy/nginx/openvibe.reviews.conf:16-18`).
- A request's text is never published; what readers see is at most a count of open requests.
- Only an editor who is a person resolves a request (`service.js:1583`). A correction of a published
  summary is a new immutable revision carrying the public correction note, its author and time,
  approved by that editor and published at once (`correctSummary`, `service.js:407-434`); accepting
  a request about an entity with a published summary requires that note (`service.js:375-380`), and a
  service doing it on an editor's behalf also needs `reviews.summary.publish` (`api.js:156-163`).
  Rejecting creates nothing.
- The entity page shows the corrected text, a "Corrected" notice and the summary's revision history
  with each correction note, without JavaScript (`views.js:137-148`); earlier revisions stay readable.
  An editor cannot rewrite a revision in place: revisions are immutable in the database
  (openvibe-publishing revision triggers).
- Readers never see the request's text, its sender, the editors' note or the request id: correction
  audit rows lose their target and detail in the public history (`service.js:959-965`, `:1047`)
  (`corrections.test.js` scans every public surface for them).

**Gaps.**

- *Fixed in this pass:* the limit was per address only, so one person with several addresses (or a
  service acting for them) could send without bound, and the same request could be sent again and
  again. Now an identical open request from the same person is 409 `correction.duplicate` and one
  person sends at most 20 a day (429 `correction.rate_limited`) (`service.js:40`, `:1559-1560`).
- *Fixed in this pass:* `target_id` was stored capped at 100 characters but written to the audit log
  uncapped (up to the 256 KB body limit); the audit row now holds the capped value.
- *Fixed in this pass (`91e613d`):* accepting a correction created no revision and no public history.
- *Remaining:* there is no dispute concept. A reader cannot contest a rejection or an editor's
  correction except by sending another correction or discussing it on Community. Designing one
  (who adjudicates editors?) is an editorial-policy decision.
- *Remaining:* open requests never expire and the desk shows the oldest 200.

## 5. Brigading and aggregate manipulation

**Threats.** Sockpuppets or bots flood ratings; a coordinated campaign (review bombing) at a source
moves the aggregate; one inflated count dominates; brigades in the discussion.

**Controls.**

- Reviews has no on-site ratings or votes. The only inputs to an aggregate are signals from Sources
  items (section 2), so accounts created here cannot move a number.
- The aggregate is a published, deterministic method whose inputs, exclusions and computation are on
  the page (`server/reviews/aggregate.js`). A source's own tally replaces its individual
  recommendations so they are not counted twice (`aggregate.js:73-74`); ratings without a scale or a
  count are left out with the reason shown (`aggregate.js:59-60`).
- Editors can exclude a source or a single signal, only with a reason readers see
  (`service.js:1359`, applied at `aggregate.js:57-58`), and the source-stated reviewer facts (bought
  on Steam, received for free, playtime) are shown next to each signal.
- Community holds the discussion: Reviews posts a comment only for a signed-in person
  (`platform.js:116`), at most 5000 characters (`platform.js:122`), rate-limited per address
  on `POST /e/*` (`app.js:112`); comments are escaped when shown (`views.js:206`) and never feed an
  aggregate.
- Rate limits: nginx zones for the API, sign-in and every POST
  (`openvibe.reviews.conf:14-18`); Express limiters (`app.js:72`, `:101`, `:102`, `:112`, `:113`) keyed
  by the client address nginx sets from `$remote_addr` (`config.js:27`, commit `0923bf3`).

**Gaps.**

- *Fixed in this pass:* out-of-scale ratings (section 2).
- *Remaining:* no anomaly detection. A review-bombing wave at a source is reflected as the source
  states it, and one source's stated count weights the mean (`aggregate.js:95-102`). The method is
  shown and editors can exclude with a public reason; automatic detection would be a judgement the
  service does not make without a person.
- *Remaining:* moderation of brigaded discussion (hiding, locking) is Community's; Reviews only
  shows what Community serves.
- *Remaining:* `GET` pages are not rate-limited by the app or nginx (search does bounded `LIKE`
  queries, `service.js` `search`); Cloudflare in front is the control.

## 6. Rendering and XSS

**Controls.**

- Every value in a page goes through openvibe-publishing's `html``…``, which escapes unless a
  fragment is marked raw (`views.js:3-4`). Links from data are rendered only for http(s)
  (`safeUrl`, `views.js:31`).
- Summary overviews are Markdown rendered by `ssr.renderMarkdown` (`views.js:165`, `:268`): raw HTML
  is escaped, links are limited to http(s), mailto and relative URLs and carry
  `rel="nofollow ugc noopener"` (openvibe-publishing `lib/ssr.js:58`, `:243`).
- JSON-LD escapes `<` (openvibe-shared `seo.js:35`), and so does the navbar configuration in the
  page (`server/render/layout.js:92`).
- `Content-Security-Policy` with `object-src 'none'`, `base-uri 'self'`, `form-action`, and
  `frame-ancestors 'self'` (`app.js:54-66`); `nosniff` (`app.js:52`); nginx adds `X-Frame-Options`
  and HSTS.

**Gaps.**

- *Fixed in this pass:* the reader-sent evidence link on the editor desk now has
  `rel="nofollow ugc noopener noreferrer"` and says it was not checked (`views.js:303`).
- *Remaining:* the CSP allows inline scripts (`app.js:56`) for the one inline bootstrap of the shared
  Network navbar. A nonce would remove it, but the Network's navbar and theme scripts must be checked
  in a browser first; nothing here renders unescaped user input into a script.
- *Remaining:* `ov_token` is readable by JavaScript (`server/auth/session.js:71`) because the shared
  navbar reads it, so an XSS would expose a token valid for up to 24 hours. The refresh token is
  httpOnly and scoped to `/auth` (`session.js:72`).

## 7. Permissions: roles, delegation, service tokens

**Controls.**

- Actors are resolved once per request from a Bearer token or the cookie, never from a body or a
  query (`server/auth/viewer.js`). A bad Bearer user token is 401, not anonymous (`viewer.js:103`);
  pages ignore service tokens (`viewer.js:100`).
- Editors are Network staff (`admin`, `global_mod`) and the `usr_` subjects in `REVIEWS_EDITORS`
  (`server/reviews/access.js:25-30`). Editorial decisions need an editor who is a person, never a
  service on its own or the AI (`service.js:167-171`).
- Service tokens must be for audience `openvibe.reviews` (`viewer.js:47`) and hold the one
  capability the route names (`server/http/common.js:28-36`, `server/auth/capabilities.js`); the CI
  contracts check fails on an unregistered capability. A first-party `svc:` principal may name the
  person it acts for in `X-OV-Subject`; an `app:`/`mod:` token acts only for its `on_behalf_of`
  person (403 `subject.not_delegated`) and sandbox tokens are refused (`viewer.js:53-66`,
  `delegation.test.js`).

**Gaps.**

- *Fixed in this pass:* a summary revision's `author` showed readers the editor's `usr_` id through
  the entity JSON, the API and the history, while the editorial log and merges showed "an editor". It
  is now "an editor" for readers everywhere (`service.js:939`).
- *Fixed in this pass:* the summary form's "Revision note" is public (the history lists it); the form
  now says so.
- *Remaining:* Network staff are editors automatically (`access.js:29`), and `REVIEWS_EDITORS` is an
  environment list, so adding or removing an editor is a restart with no audit row. A roles table
  with an audit trail is the fix; it belongs with the launch, when editors are named.
- *Remaining:* a first-party service can act for any editor it names. That is the network's trust
  model for `svc:` principals (they hold client secrets issued by the Network).

## 8. CSRF

**Controls.** The session cookie is `SameSite=Lax` (`session.js:71`). Page form posts are checked
(`server/http/pages.js:91-95`); the OAuth `state` and the FedCM nonce are compared in constant time
(`session.js:134`, `:57-65`); `next` redirects stay on this site or the Network (`session.js:26`).

**Gaps.**

- *Fixed in this pass:* the page check let `Origin: null` through whatever the browser said, so a
  post from a sandboxed frame or a `data:` URL was judged same-site; and the API, which also accepts
  the `ov_token` cookie, had no check at all (an empty-body `POST …/summary/unpublish` or
  `…/summary/publish` needed no JSON). One check now refuses a write when `Sec-Fetch-Site` is anything
  but `same-origin`/`none` or the `Origin` is another site's (`common.js:44-49`); pages apply it to
  every POST, the API to every write carried by the cookie (`api.js:52-59`, 403
  `request.cross_site`). Bearer tokens are unaffected.
- *Remaining:* a browser that sends neither `Origin` nor `Sec-Fetch-Site` is judged by `SameSite=Lax`
  alone. Every current browser sends at least one of them on a form post.

## 9. Webhooks (OpenVibe.Events → `POST /internal/events`)

**Controls.** Refused without a configured secret (`server/http/consumer.js:45`). Only signature v2
is accepted: an HMAC over `"<t>.<raw body>"` whose timestamp is within ±300 s
(`consumer.js:49`; openvibe-sdk `src/events.js:42`, `:103`); several secrets can be configured for
rotation. A replay inside the window carries the same `event_id` and is absorbed by the inbox, which
claims `(consumer, event_id)` in the same transaction as the change (`consumer.js:30`). Only events
from `sources` are applied (`consumer.js:31`); created/updated events only queue a fetch from
Sources, so nothing in the payload becomes data (`consumer.js:35`). Bodies are at most 256 KB
(`consumer.js:43`). nginx answers 404 for `/internal/` publicly (`openvibe.reviews.conf:87`) and the
app listens on 127.0.0.1.

**Gaps.**

- *Remaining:* a `sources.item.removed` event is applied without asking Sources (`consumer.js:36`),
  and a removed item stays removed (`service.js:817`). Whoever holds the webhook secret can therefore
  withdraw signals for good. Takedowns must apply at once, and the secret lives only in the Events
  subscription and Reviews' environment; confirming removals against Sources on the next pull would
  close it.

## 10. Caching

**Controls.** Only an anonymous `200` of a public page is `public, max-age=60`; everything else is
`private, no-store`, with `Vary: Cookie, Authorization` (`pages.js:98-99`). The API is always
`private, no-store` (`common.js` `run`). An entity page showing Community comments is not cached
(`pages.js:183`). nginx caches nothing (`openvibe.reviews.conf:81`).

**Gaps.**

- *Fixed in this pass:* `/e/:slug.json` is public for anonymous callers and private for editors (who
  also see pending revisions) but sent no `Vary` (`pages.js:156`).
- *Remaining:* after a correction, an unpublish or a takedown, an anonymous copy can be served for up
  to 60 seconds (redirects: 60–300 s, `pages.js:124`, `:132`). There is no purge hook; the short
  lifetime is the control.

## 11. Search, sitemaps and feeds

**Controls.** The Search document is built only from the published summary revision and live
signals, and is a tombstone when the entity is deleted, merged or not listable (`service.js:503-528`,
`:517`). Unreviewed AI drafts, pending revisions and unpublished summaries never reach it
(`summaries.test.js`), and neither does anything from a correction request (`corrections.test.js`).
Sitemaps list indexable entities only (`machine.js:31`); feeds skip entries whose entity is not
listable (openvibe-publishing `lib/seo.js:323`); `robots.txt` disallows the editor, API, auth,
internal, search, edit and correction paths (`machine.js:26`); history and revision pages are
noindex.

**Gaps.**

- *Remaining (by design):* documents carry Sources item ids and the sources' canonical URLs as
  provenance, and `GET /api/v1/items/:id` shows any item Reviews has read, including ones editors
  ignored. Both hold only source-stated facts (no review text); provenance is the point of the
  product.

## Summary

| # | Gap | Status |
|---|---|---|
| 1 | Accepting a correction created no revision or public history | fixed (`91e613d`) |
| 2 | Page CSRF check accepted `Origin: null` regardless of `Sec-Fetch-Site`; cookie-authenticated API writes unchecked | fixed |
| 3 | Correction queue limited per address only; duplicates accepted | fixed |
| 4 | Correction `target_id` and editor notes written to the audit log uncapped | fixed |
| 5 | Editor `usr_` id shown to readers as a revision's author | fixed |
| 6 | `/e/:slug.json` without `Vary` | fixed |
| 7 | Ratings spelled out in words passed the AI rating check | fixed |
| 8 | Out-of-scale source ratings became signals | fixed |
| 9 | Reader-sent evidence link without `ugc`/`noreferrer` | fixed |
| 10 | Public revision note not labelled public | fixed |
| 11 | CSP allows inline scripts; `ov_token` readable by JavaScript | remaining (shared navbar) |
| 12 | Removal events trusted without confirming with Sources | remaining (takedown speed) |
| 13 | No dispute workflow; open requests never expire | remaining (editorial policy) |
| 14 | No anomaly detection; one source's count can dominate | remaining (method is shown; editors exclude) |
| 15 | Editors from an env list and Network staff, changes unaudited | remaining (roles table at launch) |
| 16 | No legal purge of summary revisions | remaining (needs a purge policy) |
| 17 | AI citations checked for existence, not meaning; rating-text check is heuristic | remaining (human review is the control) |
| 18 | No quota on AI proposals; GET pages not rate-limited | remaining (grant can be withdrawn; Cloudflare) |
| 19 | Up to 60 s of cached anonymous pages after a change | remaining (short lifetime) |

Outside this repository: a dedicated `reviews.summary.corrected` event would have to be registered
in OpenVibe.Contracts first; until then a correction is `reviews.summary.updated` with
`correction: { note, corrects }`.
