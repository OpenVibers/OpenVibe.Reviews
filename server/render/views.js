'use strict';
/**
 * Page bodies. Every interpolated value goes through openvibe-publishing/ssr's html`` (escaped
 * unless raw()). Forms are plain HTML posts; nothing here needs JavaScript.
 *
 * Numbers shown here come from review_signals (with their provenance), from the aggregate computed over them, or from
 * reviews OpenVibe members wrote here (1 to 5 stars, always labelled as theirs and never mixed into the sources'
 * aggregate). Source values are printed as the source stated them, without star glyphs.
 */
const ssr = require('openvibe-publishing/ssr');
const showcase = require('openvibe-shared/showcase');
// The short home (the owner's rule, 2026-10-30): pick blocks and folds.
const { pickBlock, foldBlock } = require('./short');

const { html, raw } = ssr;
const t = (v) => raw(ssr.timeTag(v));
const tl = (v) => raw(ssr.timeTag(v, { label: v ? new Date(v).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '' }));
const e = encodeURIComponent;
const n = (x) => (x == null ? '' : Number(x).toLocaleString('en-US'));

const KIND_LABEL = { product: 'Product', game: 'Game', software: 'Software', service: 'Service', place: 'Place', organization: 'Organization', media: 'Media', other: 'Other',
    employer: 'Employer', landlord: 'Landlord', restaurant: 'Restaurant', business: 'Local business', hosting: 'Hosting provider', app: 'App', vehicle: 'Vehicle',
    community: 'Community', platform: 'Platform' };
const KIND_PLURAL = { employer: 'Employers', landlord: 'Landlords', restaurant: 'Restaurants', business: 'Local businesses', hosting: 'Hosting providers', product: 'Products',
    app: 'Apps', software: 'Software', game: 'Games', vehicle: 'Vehicles', service: 'Services', organization: 'Organizations', place: 'Places', media: 'Media', other: 'Other',
    community: 'Communities', platform: 'Platforms' };
// How a member knew it, offered on the form (their choice, or none).
const RELATIONS = {
    employer: ['Current employee', 'Former employee', 'Interviewed there', 'Contractor'], landlord: ['Current tenant', 'Former tenant', 'Applied to rent'],
    restaurant: ['Ate there', 'Ordered takeout', 'Ordered delivery'], business: ['Customer', 'Former customer'], hosting: ['Customer', 'Former customer', 'Tried it'],
    product: ['Own it', 'Owned it', 'Tried it'], vehicle: ['Own one', 'Owned one', 'Test-drove it', 'Rented one'], app: ['Use it', 'Used it'], software: ['Use it', 'Used it'],
    game: ['Played it'], service: ['Customer', 'Former customer'], organization: ['Customer', 'Member', 'Former member'], place: ['Visited'],
    community: ['Member', 'Former member', 'Moderator'], platform: ['Use it', 'Used it', 'Create on it'],
};
const LOCAL = new Set(['restaurant', 'business', 'landlord', 'place']);
// Which sites /everywhere offers for a kind (server/reviews/everywhere.js).
const EW_KIND = { employer: 'employer', landlord: 'landlord', restaurant: 'business', business: 'business', place: 'business', hosting: 'hosting', product: 'product',
    vehicle: 'product', app: 'software', software: 'software', game: 'software', service: 'company', organization: 'company', media: 'product', other: 'company',
    community: 'company', platform: 'software' };
const everywhere = require('../reviews/everywhere');
const TYPE_LABEL = { recommendation: 'Recommendation', recommendation_tally: 'Recommendation count', rating: 'Rating', rating_aggregate: 'Aggregate rating' };
const REASON_LABEL = {
    scale_not_stated: 'the source did not state the rating scale',
    covered_by_source_tally: 'already counted in the same source\'s own tally',
    older_tally_same_source: 'a newer tally from the same source is used',
    source_excluded_by_editor: 'source excluded by an editor',
    signal_excluded_by_editor: 'excluded by an editor',
    no_count: 'the source stated no count',
};

function epath(entity) { return `/e/${e(entity.slug)}`; }
/** Only http(s) URLs become links; anything else is shown as nothing. */
function safeUrl(u) { try { const x = new URL(String(u || '')); return x.protocol === 'http:' || x.protocol === 'https:' ? x.toString() : null; } catch { return null; } }
function notice(kind, text) { return html`<p class="rv-notice rv-${kind}" role="status">${text}</p>`; }
function crumbs(items) { return raw(ssr.breadcrumbsHtml(items)); }

function signalValue(s) {
    switch (s.type) {
    case 'recommendation': return s.recommended ? 'Recommends' : 'Does not recommend';
    case 'recommendation_tally': return `${n(s.positive_count)} of ${n(s.total_count)} recommend`;
    case 'rating': return s.rating_best != null ? `${s.rating_value} / ${s.rating_best}` : `${s.rating_value} (scale not stated)`;
    case 'rating_aggregate': return `${s.rating_best != null ? `${s.rating_value} / ${s.rating_best}` : `${s.rating_value} (scale not stated)`} from ${n(s.rating_count)} ratings`;
    default: return '';
    }
}

function trustFacts(trust) {
    const bits = [];
    if (trust.steam_purchase === true) bits.push('bought on Steam');
    if (trust.steam_purchase === false) bits.push('not bought on Steam');
    if (trust.received_for_free === true) bits.push('received for free');
    if (trust.written_during_early_access === true) bits.push('written during early access');
    if (trust.verified_purchase === true) bits.push('verified purchase');
    if (trust.playtime_at_review_min != null) bits.push(`${n(Math.round(trust.playtime_at_review_min / 60))} h played at review`);
    if (trust.language) bits.push(`language: ${trust.language}`);
    return bits.join(' · ');
}

function errorBody({ status, title, message }) {
    return html`<section class="rv-error"><h1>${title}</h1><p>${message}</p><p class="rv-muted">HTTP ${String(status)}</p><p><a href="/">Back to OpenVibe.Reviews</a></p></section>`;
}

function signInPage({ next, message }) {
    return html`<section><h1>Sign in</h1><p>${message}</p><p><a class="rv-button" href="/auth/login?next=${e(next || '/')}">Sign in with OpenVibe</a></p></section>`;
}

function aggregateLine(agg) {
    if (!agg || !agg.result) return html`<span class="rv-muted">No aggregate: no qualifying signals</span>`;
    const c = agg.result.components;
    const parts = [];
    if (c.rating) parts.push(c.rating.on_scale ? `${c.rating.on_scale.value} / ${c.rating.on_scale.best} from ${n(c.rating.count)} ratings` : `${c.rating.percent}% from ${n(c.rating.count)} ratings`);
    if (c.recommendation) parts.push(`${c.recommendation.percent}% recommend (${n(c.recommendation.positive)} of ${n(c.recommendation.total)})`);
    return html`${parts.join(' · ')}`;
}

/** The front page opens with what OpenVibe.Reviews is for (openvibe-shared/showcase), then the entities. */
function reviewsHero(aside = null) {
    return showcase.hero({
        aside: aside ? { html: aside } : undefined,
        eyebrow: 'OpenVibe.Reviews',
        title: 'Employers, landlords, restaurants, hosts.', accent: 'Every review in one place.',
        lede: 'Read and write reviews of where you work, rent, eat and host, beside the scores other sites publish and every review site\'s own page for it. Every number says where it came from.',
        // Two, so they sit side by side on a phone; how it works is the steps below and /about.
        actions: [{ label: 'Write a review', href: '/review', primary: true }, { label: 'Search every review site', href: '/everywhere' }],
    });
}
function reviewsFeatures() {
    return showcase.features({
        title: 'What every page shows',
        items: [
            { icon: 'ov:search', title: 'Where each number came from', text: 'Every signal keeps its source, the item it came from, and when it was read.' },
            { icon: 'ov:check', title: 'An aggregate you can check', text: 'The inputs and the method are listed. An editor can leave a source out only with the reason shown.' },
            { icon: 'ov:history', title: 'Changes on the record', text: 'Replaced and withdrawn signals stay in the history, beside every revision of the aggregate.' },
            { icon: 'ov:docs', title: 'Summaries by people', text: 'Written or approved by an editor, citing the signals they rest on, and never carrying a rating.' },
            { icon: 'ov:shield', title: 'Corrections from readers', text: 'Anyone signed in with OpenVibe can send the editors a correction; an accepted one is published with its note.' },
            { icon: 'ov:feeds', title: 'Feeds and an API', text: 'New and changed scores arrive in Atom and JSON Feed, and the API serves the same data to OpenVibe apps.' },
        ],
    });
}

/**
 * One entity on the front page's board: its headline number (the recommendation share, else the rating on its scale,
 * else the rating share), a meter for it, and how many signals it rests on. No aggregate: the card says so.
 */
function boardCard(x) {
    const c = x.aggregate && x.aggregate.result ? x.aggregate.result.components : null;
    let big = null;
    let label = '';
    let share = null;
    let basis = '';
    if (c && c.recommendation) {
        big = `${c.recommendation.percent}%`; label = 'recommend'; share = c.recommendation.percent;
        basis = `${n(c.recommendation.positive)} of ${n(c.recommendation.total)} reviews`;
    } else if (c && c.rating && c.rating.on_scale) {
        big = `${c.rating.on_scale.value}`; label = `out of ${c.rating.on_scale.best}`; share = (100 * c.rating.on_scale.value) / c.rating.on_scale.best;
        basis = `${n(c.rating.count)} ratings`;
    } else if (c && c.rating) {
        big = `${c.rating.percent}%`; label = 'rating'; share = c.rating.percent;
        basis = `${n(c.rating.count)} ratings`;
    }
    const pct = share == null ? 0 : Math.max(0, Math.min(100, Number(share)));
    return html`<li><a class="rv-card" href="${epath(x.entity)}"><span class="rv-card-head"><b>${x.entity.name}</b> <span class="rv-tag">${KIND_LABEL[x.entity.kind]}</span></span>${big ? html`<span class="rv-score"><span class="rv-big">${big}</span> <span class="rv-muted">${label}</span></span>
<span class="rv-meter" aria-hidden="true"><span style="width:${pct.toFixed(1)}%"></span></span><span class="rv-basis">${basis}${c && c.recommendation && c.rating ? html` · ${c.rating.on_scale ? `${c.rating.on_scale.value} / ${c.rating.on_scale.best}` : `${c.rating.percent}%`} from ${n(c.rating.count)} ratings` : ''}</span>`
        : html`<span class="rv-basis">No score yet: no source has said enough.</span>`}</a></li>`;
}

/** Every other review site's own page for an entity (the /everywhere links for its kind, and its place). */
function elsewhereLinks(entity) {
    return everywhere.linksFor(entity.name, { kind: EW_KIND[entity.kind] || 'company', near: LOCAL.has(entity.kind) ? entity.description || '' : '' });
}

function stars(n) {
    const v = Math.max(0, Math.min(5, Math.round(Number(n) || 0)));
    return html`<span class="rv-stars" role="img" aria-label="${v} out of 5 stars">${'★'.repeat(v)}<span class="rv-stars-off">${'★'.repeat(5 - v)}</span></span>`;
}
function paragraphs(text) {
    return String(text || '').split(/\n{2,}/).map((para) => html`<p>${raw(para.split('\n').map((line) => ssr.escapeHtml(line)).join('<br>'))}</p>`);
}

function memberReviewItem(r, { entity, editor }) {
    return html`<li><article class="rv-mr" id="${r.id}"><header>${stars(r.rating)} <b>${r.title}</b></header>
<p class="rv-muted">${r.author_name}${r.relation ? html` · ${r.relation}` : ''} · ${t(r.created_at)}${r.edited ? ' (edited)' : ''}</p>
<div class="rv-mr-body">${paragraphs(r.body)}</div>
${r.mine ? html`<form method="post" action="${epath(entity)}/reviews/${r.id}/remove" class="rv-inline"><button type="submit" class="rv-link-button">Delete my review</button></form>`
        : editor ? html`<form method="post" action="${epath(entity)}/reviews/${r.id}/remove" class="rv-inline"><input type="text" name="reason" placeholder="Reason (kept in the log)" aria-label="Reason for removing" maxlength="300"> <button type="submit" class="rv-link-button">Remove</button></form>` : ''}
</article></li>`;
}

/** The members' reviews of an entity: their numbers, the reviews, and the viewer's own form. */
function memberSection(members, { entity, actor, editor, error, values }) {
    const st = members.stats;
    const mine = members.mine;
    const v = values || (mine ? { rating: mine.rating, title: mine.title, body: mine.body, relation: mine.relation } : {});
    const rels = RELATIONS[entity.kind] || [];
    return html`<section id="member-reviews" aria-labelledby="mr-h"><h2 id="mr-h">Reviews from OpenVibe members${st.count ? ` (${st.count})` : ''}</h2>
${st.count ? html`<div class="rv-mr-summary"><p><span class="rv-big">${String(st.average)}</span> <span class="rv-muted">out of 5</span> ${stars(st.average)}<br><span class="rv-muted">from ${n(st.count)} review${st.count === 1 ? '' : 's'} written here by people with an OpenVibe account</span></p>
<ul class="rv-dist" aria-label="How many members gave each rating">${[5, 4, 3, 2, 1].map((k) => { const c = st.distribution[k - 1]; return html`<li><span>${String(k)}★</span><span class="rv-meter"><span style="width:${(st.count ? (100 * c) / st.count : 0).toFixed(1)}%"></span></span><span class="rv-muted">${n(c)}</span></li>`; })}</ul></div>
<ol class="rv-mr-list">${members.reviews.map((r) => memberReviewItem(r, { entity, editor }))}</ol>`
        : html`<p class="rv-muted">No one has reviewed ${entity.name} here yet.${actor && actor.subject ? ' Be the first.' : ''}</p>`}
<div id="write" class="rv-mr-write">${actor && actor.subject ? html`<h3>${mine ? 'Your review' : `Review ${entity.name}`}</h3>
${error ? notice('error', error) : ''}
<form method="post" action="${epath(entity)}/reviews" class="rv-form">
<fieldset class="rv-rate"><legend>Your rating</legend>${[1, 2, 3, 4, 5].map((k) => html`<label><input type="radio" name="rating" value="${String(k)}" required${String(v.rating) === String(k) ? raw(' checked') : ''}> ${String(k)} star${k === 1 ? '' : 's'}</label>`)}</fieldset>
${rels.length ? html`<label>How you know it <select name="relation"><option value="">Prefer not to say</option>${rels.map((x) => html`<option${v.relation === x ? raw(' selected') : ''}>${x}</option>`)}</select></label>` : ''}
<label>Title <input type="text" name="title" maxlength="120" required value="${v.title || ''}" placeholder="One line about it"></label>
<label>Your review <textarea name="body" rows="6" minlength="30" maxlength="5000" required placeholder="What was it like? What happened?">${v.body || ''}</textarea></label>
<p class="rv-muted">Posted under your OpenVibe name. Say what happened and what it was like; reviews that name private people, threaten anyone or are not about ${entity.name} are removed.</p>
<button type="submit">${mine ? 'Update your review' : 'Post review'}</button></form>`
        : html`<p><a class="rv-button" href="/auth/login?next=${encodeURIComponent(`${epath(entity)}#write`)}">Sign in to review ${entity.name}</a></p>`}</div>
</section>`;
}

function elsewhereSection(links, entity, { seen = {}, actor = null, editor = false } = {}) {
    if (!links.length && !Object.keys(seen).length) return '';
    const known = new Set(links.map((l) => l.id));
    const extra = Object.values(seen).filter((r) => !known.has(r.site)).map((r) => ({ id: r.site, name: r.name, url: r.page_url, best: '' }));
    const anySeen = Object.keys(seen).length > 0;
    return html`<section id="elsewhere" aria-labelledby="ew-h"><h2 id="ew-h">${entity.name} on other review sites</h2>
<p class="rv-muted">Each opens that site's own page for it, in a new tab.${anySeen ? ' A rating beside a site is what its page showed when an OpenVibe member looked; it is theirs, not ours, and it is never mixed into the numbers above.' : ''}</p>
<ul class="rv-elsewhere">${[...links, ...extra].map((l) => { const r = seen[l.id]; return html`<li><a href="${r ? r.page_url : l.url}" target="_blank" rel="nofollow noopener noreferrer">${l.name}</a> ${r ? seenLine(r, { entity, actor, editor }) : html`<span class="rv-muted">${l.best}</span>`}</li>`; })}</ul>
<p class="rv-muted">Saw its rating on Glassdoor, Indeed, Yelp, the BBB, Trustpilot, Google Maps or Tripadvisor? <a href="/save?entity=${entity.slug}">Add what that page shows</a>${actor && actor.subject ? '' : ' (with an OpenVibe account)'}, or let the <a href="https://openvibe.coupons/companion">OpenVibe Companion</a> read it for you.</p></section>`;
}

/** One site's rating as a member saw it, with when, how many members saw it, and a way to take it down. */
function seenLine(r, { entity, actor, editor }) {
    const mine = actor && actor.subject && r.seen_by === actor.subject;
    return html`<span class="rv-seen"><b>${String(r.value)}</b> <span class="rv-muted">out of ${String(r.best)}${r.count != null ? ` from ${n(r.count)} rating${r.count === 1 ? '' : 's'}` : ''} · seen ${t(r.seen_at)}${r.members > 1 ? ` (${r.members} members)` : ''}</span>${mine || editor ? html` <form method="post" action="/save/${r.id}/remove" class="rv-inline"><input type="hidden" name="entity" value="${entity.slug}">${mine ? '' : html`<input type="text" name="reason" placeholder="Reason (kept in the log)" aria-label="Reason for removing" maxlength="300"> `}<button type="submit" class="rv-link-button">${mine ? 'Remove mine' : 'Remove'}</button></form>` : ''}</span>`;
}

/** /save: a member checks the rating another site's page shows (filled in by the Companion, or typed) and saves it. */
function savePage({ values = {}, entity = null, sites, kinds, local, actor, error = null }) {
    const v = values;
    const site = sites[v.site] ? v.site : '';
    return html`${crumbs([{ name: 'Reviews', url: '/' }, { name: 'Add a rating from another site' }])}
<article class="rv-article"><h1>Add a rating from another site</h1>
<p>Glassdoor, Indeed, Yelp, the BBB, Trustpilot, Google Maps and Tripadvisor each show a rating. Bring what one of their pages shows, and it appears beside that site on the page here, with the date and a link back. Check the numbers against the page first.</p>
${error ? notice('error', error) : ''}
${actor && actor.subject ? html`<form method="post" action="/save" class="rv-form">
${entity ? html`<input type="hidden" name="entity" value="${entity.slug}"><p>For <a href="${epath(entity)}"><b>${entity.name}</b></a>${entity.description && LOCAL.has(entity.kind) ? html` <span class="rv-muted">${entity.description}</span>` : ''}</p>`
        : html`<label>What is it? <select name="kind">${kinds.map((x) => html`<option value="${x}"${x === (v.kind || (site ? sites[site].kind : 'business')) ? raw(' selected') : ''}>${KIND_LABEL[x]}</option>`)}</select></label>
<label>Its name <input type="text" name="name" maxlength="200" required value="${v.name || ''}"></label>
<label>Where it is <input type="text" name="place" maxlength="120" value="${v.place || ''}" placeholder="City, and state or country"> <span class="rv-muted">Needed for ${local.map((x) => KIND_PLURAL[x].toLowerCase()).join(', ')}.</span></label>`}
<label>The page <input type="url" name="url" maxlength="1000" required value="${v.url || ''}" placeholder="https://www.glassdoor.com/Reviews/…"> <span class="rv-muted">Its address on ${Object.values(sites).map((x) => x.name).join(', ')}.</span></label>
<div class="rv-row"><label>Rating <input type="text" inputmode="decimal" name="value" required value="${v.value || ''}" size="5" placeholder="3.9"></label>
<label>Out of <input type="text" inputmode="decimal" name="best" required value="${v.best || '5'}" size="4"></label>
<label>From how many ratings <input type="text" inputmode="numeric" name="count" value="${v.count || ''}" size="9" placeholder="1,234"></label></div>
<input type="hidden" name="via" value="${v.via === 'companion' ? 'companion' : 'form'}">
<button type="submit">Save</button></form>
<p class="rv-muted">Saved under your OpenVibe account; a later look of yours replaces it. Reviews never reads those sites itself.</p>`
        : html`<p><a class="rv-button" href="/auth/login?next=${encodeURIComponent(v.next || '/save')}">Sign in with OpenVibe to add it</a></p>`}
</article>`;
}

const GRADE_TEXT = { A: 'Grade A', B: 'Grade B', C: 'Grade C', N: 'Not yet graded', Z: 'Grade pending', P: 'Grade pending (reopening)' };

/** What public bodies published about it: the CFPB's complaint count, NYC HPD's open violations, NYC Health's inspections. Records, not reviews. */
function recordsSection(rec, entity) {
    if (!rec.complaints && !rec.housing && !rec.inspections.length) return '';
    const h = rec.housing;
    const r = rec.restaurant;
    return html`<section id="records" aria-labelledby="rec-h"><h2 id="rec-h">Official records</h2>
${rec.complaints ? html`<div class="rv-record"><p><span class="rv-big">${n(rec.complaints.count)}</span> complaint${rec.complaints.count === 1 ? '' : 's'} about ${rec.complaints.company} in the Consumer Financial Protection Bureau's complaint database, from every year since 2011 (counted ${t(rec.complaints.as_of)}). <a href="${rec.complaints.url}" target="_blank" rel="noopener">Read them on consumerfinance.gov</a></p>
<p class="rv-muted">These are complaints consumers sent about financial products, not findings: the CFPB does not verify them, and a company with more customers gets more.</p></div>` : ''}
${h ? html`<div class="rv-record"><p><span class="rv-big">${n(h.open)}</span> open housing-code violation${h.open === 1 ? '' : 's'} at ${h.address || entity.name}, ${h.boro ? String(h.boro).toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : 'New York'}${h.zip ? ` ${h.zip}` : ''}, in the NYC Department of Housing Preservation and Development's records (counted ${t(h.as_of)}${h.last ? html`; latest inspection ${t(h.last)}` : ''}).</p>
<ul class="rv-classes"><li><b>${n(h.c)}</b> class C: immediately hazardous</li><li><b>${n(h.b)}</b> class B: hazardous</li><li><b>${n(h.a)}</b> class A: non-hazardous</li></ul>
<p><a href="${h.url}" target="_blank" rel="noopener">The building on HPD Online</a></p>
<p class="rv-muted">Open means HPD has not recorded the violation as corrected. Some stay open after a repair until the owner certifies it, so the count can run ahead of the building's condition today.</p></div>` : ''}
${rec.inspections.length ? html`<div class="rv-record"><p>NYC Health inspections${r && r.address ? html` of ${entity.name} at ${r.address}, ${r.boro || 'New York'}${r.zipcode ? ` ${r.zipcode}` : ''}` : ''}${r && r.cuisine ? html` (${r.cuisine})` : ''}, newest first.</p>
<ol class="rv-inspections">${rec.inspections.map((d) => html`<li><p><b>${d.date ? t(d.date) : 'Date not stated'}</b>${d.grade ? html` · <span class="rv-grade rv-grade-${String(d.grade).toLowerCase()}">${GRADE_TEXT[d.grade] || `Grade ${d.grade}`}</span>` : ''}${d.score != null && !Number.isNaN(d.score) ? html` · score ${String(d.score)}` : ''}${d.type ? html` <span class="rv-muted">· ${d.type}</span>` : ''}</p>
${d.violations.length ? html`<ul class="rv-violations">${d.violations.map((v) => html`<li>${v.critical ? html`<span class="rv-tag rv-critical">Critical</span> ` : ''}${v.text || v.code}</li>`)}</ul>` : html`<p class="rv-muted">${d.action || 'No violations were recorded.'}</p>`}</li>`)}</ol>
<p class="rv-muted">From NYC Health's inspection results on NYC Open Data, as the inspector recorded them. A lower score is better (0 to 13 earns an A), and a letter grade is given only at some inspections. <a href="https://a816-health.nyc.gov/ABCEatsRestaurants/" target="_blank" rel="noopener">NYC Health's restaurant search</a></p></div>` : ''}
</section>`;
}

/** /review: name what to review; found, or added by the member. */
function reviewStartPage({ values = {}, kinds, local, actor, error = null }) {
    const k = values.kind || 'employer';
    return html`${crumbs([{ name: 'Reviews', url: '/' }, { name: 'Write a review' }])}
<article class="rv-article"><h1>Write a review</h1>
<p>Employers, landlords, restaurants, hosting providers, products, apps: name it, and if it is already here you go straight to its page; if not, you add it.</p>
${error ? notice('error', error) : ''}
${actor && actor.subject ? html`<form method="post" action="/review" class="rv-form">
<label>What is it? <select name="kind">${kinds.map((x) => html`<option value="${x}"${x === k ? raw(' selected') : ''}>${KIND_LABEL[x]}</option>`)}</select></label>
<label>Its name <input type="text" name="name" maxlength="200" required value="${values.name || ''}" placeholder="e.g. Acme Corp, Joe's Pizza, Hetzner"></label>
<label>Where it is <input type="text" name="place" maxlength="120" value="${values.place || ''}" placeholder="City, and state or country"> <span class="rv-muted">Needed for ${local.map((x) => KIND_PLURAL[x].toLowerCase()).join(', ')}.</span></label>
<label>Its website (optional) <input type="text" name="url" maxlength="300" value="${values.url || ''}" placeholder="example.com"> <span class="rv-muted">So the same one is found again.</span></label>
<button type="submit">Continue</button></form>`
        : html`<p><a class="rv-button" href="/auth/login?next=%2Freview">Sign in with OpenVibe to write a review</a></p><p class="rv-muted">Reading needs no account.</p>`}
<p class="rv-muted">Looking for what other sites say? <a href="/everywhere">Search every review site</a>.</p></article>`;
}

/** A list entry's official record, in a few words: its CFPB complaints, its open HPD class C violations, or its latest NYC inspection. */
function recordLine(x) {
    if (x.complaints != null) return html`<span class="rv-muted"> · ${n(x.complaints)} CFPB complaint${x.complaints === 1 ? '' : 's'}</span>`;
    if (x.hazardous != null) return html`<span class="rv-muted"> · ${n(x.hazardous)} open hazardous HPD violation${Number(x.hazardous) === 1 ? '' : 's'}</span>`;
    if (x.inspected_on) return html`<span class="rv-muted"> · inspected ${t(x.inspected_on)}${x.grade ? html`, ${GRADE_TEXT[x.grade] || `grade ${x.grade}`}` : ''}</span>`;
    return '';
}

/** /k/:kind — everything of one kind, the most reviewed by members first, then by their official records. */
function kindPage({ kind, page, total, entities }) {
    const pages = Math.max(1, Math.ceil(total / 60));
    return html`${crumbs([{ name: 'Reviews', url: '/' }, { name: KIND_PLURAL[kind] }])}
<article class="rv-article"><h1>${KIND_PLURAL[kind]}</h1>
<p><a class="rv-button" href="/review?kind=${kind}">Review ${LOCAL.has(kind) ? 'one near you' : `a${/^[aeiou]/i.test(KIND_LABEL[kind]) ? 'n' : ''} ${KIND_LABEL[kind].toLowerCase()}`}</a></p>
${entities.length ? html`<ul class="rv-kind-list">${entities.map((x) => html`<li><a href="${epath(x)}"><b>${x.name}</b></a>${x.description && LOCAL.has(x.kind) ? html` <span class="rv-muted">${x.description}</span>` : ''}
<br>${x.member_count ? html`${stars(x.member_avg)} <span class="rv-muted">${String(x.member_avg)} from ${n(x.member_count)} review${x.member_count === 1 ? '' : 's'}</span>` : html`<span class="rv-muted">No member reviews yet</span>`}${recordLine(x)}</li>`)}</ul>`
        : html`<p class="rv-muted">None yet. The first review adds one.</p>`}
${pages > 1 ? html`<nav class="rv-pager" aria-label="Pages">${page > 1 ? html`<a href="/k/${kind}?page=${String(page - 1)}">Newer</a> ` : ''}Page ${String(page)} of ${String(pages)}${page < pages ? html` <a href="/k/${kind}?page=${String(page + 1)}">More</a>` : ''}</nav>` : ''}
</article>`;
}

// The questions the front page answers, shown on it and given to search engines as FAQPage (only what is shown).
const HOME_FAQ = [
    { q: 'Where do the scores come from?', a: 'From named sources that OpenVibe.Sources reads within their terms, such as Steam\'s review counts. Each signal keeps its source, the item and when it was read, and the aggregate lists its inputs and method. With no qualifying signal there is no score at all.' },
    { q: 'What are the official records?', a: 'What public bodies published: NYC Health restaurant inspections, NYC HPD open housing violations and the complaints consumers sent the CFPB. They sit in their own section of a page and never feed a score.' },
    { q: 'Can I write a review?', a: 'Yes. Sign in with your OpenVibe account, name the employer, landlord, restaurant or anything else, and write. Members\' reviews are labelled as theirs and kept apart from the sources\' numbers.' },
    { q: 'Do you copy reviews from Glassdoor, Yelp or Google?', a: 'No. Every page links each review site\'s own page for it, and a member can save the rating a site shows (with the date and a link). The words stay with the people who wrote them.' },
    { q: 'What if a page is wrong?', a: 'Anyone signed in can send the editors a correction from the page. An accepted correction is published with a note, and every earlier version stays in the page\'s history.' },
];
const BORO = (s) => String(s || '').toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

function homeStats(stats, sites) {
    const tiles = [
        ['Pages', stats.pages],
        stats.records ? ['Official records', stats.records] : null,
        stats.signals ? ['Ratings from sources', stats.signals] : null,
        ['Review sites one search opens', sites],
        stats.memberReviews ? ['Members\' reviews', stats.memberReviews] : null,
        stats.seen ? ['Ratings saved from other sites', stats.seen] : null,
    ].filter(Boolean);
    return String(html`<div class="rv-h-panel"><h2 class="rv-h-panel-h">On OpenVibe.Reviews</h2><dl class="rv-h-stats">${tiles.map(([k, v]) => html`<div><dt>${k}</dt><dd>${n(v)}</dd></div>`)}</dl></div>`);
}

function home({ entities, total, editor, recent = [], kinds = {}, stats = null, sites = 0, inspections = [], hazardous = [], complaints = [] }) {
    const browse = ['employer', 'landlord', 'restaurant', 'hosting', 'business', 'organization', 'product', 'app', 'game', 'vehicle', 'community', 'platform'];
    // The short home (the owner's rule, 2026-10-30): the three public-record lists are one pick block, a row of chips
    // picks one of them, and the questions are a fold.
    const records = [
        inspections.length ? { id: 'rv-insp', label: 'Inspections', html: html`<section class="sc-sec" aria-labelledby="rv-insp-h"><h2 id="rv-insp-h">Latest restaurant inspections</h2>
<p class="sc-lede">New York City restaurants by their newest NYC Health inspection, as the inspector recorded it. A letter grade is given only at some inspections.</p>
<ul class="rv-h-list">${inspections.map((x) => html`<li><a href="/e/${e(x.slug)}"><b>${x.name}</b><span class="rv-muted">${[x.cuisine, BORO(x.boro)].filter(Boolean).join(' · ')}</span>
<span>Inspected ${t(x.occurred_on)}: ${n(x.violations)} violation${x.violations === 1 ? '' : 's'}${x.critical ? html`, <b class="rv-h-crit">${n(x.critical)} critical</b>` : ''}</span>${x.grade ? html`<span class="rv-muted">Latest grade on record: ${GRADE_TEXT[x.grade] || `Grade ${x.grade}`}</span>` : ''}</a></li>`)}</ul>
<p><a href="/k/restaurant">Every restaurant (${n(kinds.restaurant || 0)})</a></p></section>` } : null,
        hazardous.length ? { id: 'rv-hpd', label: 'Hazardous buildings', html: html`<section class="sc-sec" aria-labelledby="rv-hpd-h"><h2 id="rv-hpd-h">Buildings with the most hazardous open violations</h2>
<p class="sc-lede">Buildings by their open class C (immediately hazardous) violations in NYC HPD's records. Open means HPD has not recorded a violation as corrected, so the count can run ahead of a building's condition today.</p>
<ol class="rv-h-rank">${hazardous.map((x) => html`<li><a href="/e/${e(x.slug)}"><b>${x.name}</b><span class="rv-muted">${BORO(x.boro)}</span><span>${n(x.c)} class C · ${n(x.open)} open in all</span></a></li>`)}</ol>
<p><a href="/k/landlord">Every building (${n(kinds.landlord || 0)})</a></p></section>` } : null,
        complaints.length ? { id: 'rv-cfpb', label: 'CFPB complaints', html: html`<section class="sc-sec" aria-labelledby="rv-cfpb-h"><h2 id="rv-cfpb-h">Companies with the most CFPB complaints</h2>
<p class="sc-lede">Complaints consumers sent the Consumer Financial Protection Bureau about financial products. They are not findings: the CFPB does not verify them, and a company with more customers gets more.</p>
<ol class="rv-h-rank">${complaints.map((x) => html`<li><a href="/e/${e(x.slug)}"><b>${x.name}</b><span>${n(x.complaints)} complaints</span></a></li>`)}</ol>
<p><a href="/k/organization">Every company (${n(kinds.organization || 0)})</a></p></section>` } : null,
    ].filter(Boolean);
    return html`${raw(reviewsHero(stats ? homeStats(stats, sites) : null))}
<section class="sc-sec" aria-labelledby="rv-kinds-h"><h2 id="rv-kinds-h">Browse and review</h2>
<ul class="rv-kinds">${browse.map((k) => html`<li><a href="/k/${k}"><b>${KIND_PLURAL[k]}</b><span class="rv-muted">${kinds[k] ? `${n(kinds[k])} here` : 'Be the first'}</span></a></li>`)}</ul>
<p><a class="rv-button" href="/review">Write a review</a> <a href="/everywhere">Search every review site</a></p></section>
${recent.length ? html`<section class="sc-sec" aria-labelledby="rv-recent-h"><h2 id="rv-recent-h">Latest reviews from members</h2>
<ul class="rv-recent">${recent.map((r) => html`<li><a href="/e/${r.entity.slug}#${r.id}"><span class="rv-card-head"><b>${r.entity.name}</b> <span class="rv-tag">${KIND_LABEL[r.entity.kind]}</span></span>${stars(r.rating)} <b>${r.title}</b><br><span class="rv-muted">${r.body.length > 160 ? `${r.body.slice(0, 157)}…` : r.body}</span></a></li>`)}</ul></section>` : ''}
<section id="entities" class="sc-sec" aria-labelledby="rv-board-h"><h2 id="rv-board-h">Scores from sources</h2>
${entities.length ? html`<p class="sc-lede">Each score comes from named sources. Open one to see every signal behind it, when it was read, and how the number was worked out.</p><ul class="rv-board">${entities.map(boardCard)}</ul>`
        : html`<p class="rv-muted">Nothing yet. Entities appear here once a source has stated something about them (or an editor has published a summary).</p>`}
<p class="rv-muted">${n(total)} pages in all. <a href="/feed.atom">Atom</a> · <a href="/feed.json">JSON Feed</a>${editor ? html` · <a href="/editor">Editor desk</a>` : ''}</p></section>
${raw(pickBlock({ key: 'records', label: 'Public records', head: 'Public records', panes: records }))}
<details class="rv-h-fold"><summary>How it works<span>what every page shows, and where the numbers come from</span></summary>${raw(reviewsFeatures())}${raw(showcase.steps({
        title: 'How it works',
        items: [
            { title: 'Sources are read within their terms', text: 'OpenVibe.Sources collects public ratings and official records, each with its source, item and the time it was read.' },
            { title: 'Every number shows its inputs', text: 'A score is worked out from the signals by a published method, and the page lists them all. No signals, no score.', href: '/about' },
            { title: 'Members add their own reviews', text: 'Signed-in members write reviews and save the ratings other sites show, kept apart from the sources\' numbers.', href: '/review' },
            { title: 'Every review site is one click away', text: 'Each page links the review sites that cover its kind (Google, Yelp, Glassdoor, the BBB, Trustpilot, Reddit and more), searched for that name.', href: '/everywhere' },
        ],
    }))}</details>
${raw(foldBlock({ id: 'faq', head: '<h2 id="rv-faq-h">Questions</h2>', html: html`<section class="sc-sec rv-h-faq" aria-labelledby="rv-faq-h"><h2 id="rv-faq-h-in">Questions</h2>${HOME_FAQ.map((f) => html`<details><summary>${f.q}</summary><p>${f.a}</p></details>`)}</section>` }))}`;
}

/** The front page's structured data: the site and its search, the scored pages as an ItemList, the questions shown. */
function homeJsonLd({ base, entities }) {
    const out = [{ '@context': 'https://schema.org', '@type': 'WebSite', name: 'OpenVibe.Reviews', url: `${base}/`,
        potentialAction: { '@type': 'SearchAction', target: { '@type': 'EntryPoint', urlTemplate: `${base}/search?q={search_term_string}` }, 'query-input': 'required name=search_term_string' } }];
    if (entities.length) out.push({ '@context': 'https://schema.org', '@type': 'ItemList', name: 'Scores from sources on OpenVibe.Reviews', numberOfItems: entities.length, itemListElement: entities.map((x, i) => ({ '@type': 'ListItem', position: i + 1, name: x.entity.name, url: `${base}${epath(x.entity)}` })) });
    out.push({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: HOME_FAQ.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) });
    return out;
}

/** /everywhere: one name opens every review site's own search for it (server/reviews/everywhere.js). */
function everywherePage({ q, kind, near, links, KINDS, KIND_TEXT }) {
    const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
    const tab = (k) => `/everywhere?${new URLSearchParams({ q, kind: k, ...(near ? { near } : {}) })}`;
    return html`<section><h1>${q ? html`“${q}” on every review site` : 'Every review site, one search'}</h1>
<p class="rv-lede">Type a name once and every review site searches it for you, each in a new tab: Google, Yelp, Glassdoor, the BBB, Trustpilot, Reddit and the rest, next to the ratings OpenVibe.Reviews gathers from named sources.</p>
<form class="rv-ew-form" method="get" action="/everywhere" role="search">
<div class="rv-ew-row"><label for="ew-q">Name</label><input id="ew-q" name="q" type="search" required maxlength="120" placeholder="A business, an employer, a landlord, a product" value="${q}"></div>
<div class="rv-ew-row"><label for="ew-kind">It is</label><select id="ew-kind" name="kind">${KINDS.map((k) => html`<option value="${k}"${k === kind ? raw(' selected') : ''}>${KIND_TEXT[k]}</option>`)}</select></div>
<div class="rv-ew-row"><label for="ew-near">Near (for a local business or landlord)</label><input id="ew-near" name="near" type="text" maxlength="80" placeholder="City and state" value="${near}"></div>
<p><button type="submit">Search every site</button></p></form>
${q ? html`<nav class="rv-ew-kinds" aria-label="What it is">${KINDS.map((k) => (k === kind ? html`<span class="rv-ew-kind on" aria-current="page">${KIND_TEXT[k]}</span>` : html`<a class="rv-ew-kind" href="${tab(k)}">${KIND_TEXT[k]}</a>`))}</nav>
<ul class="rv-ew-sites">${links.map((l) => html`<li class="rv-ew-site"><a class="rv-ew-open" href="${l.url}" target="_blank" rel="noopener nofollow"><span class="rv-ew-name">${l.name}</span><span class="rv-ew-host">${host(l.url)} ↗</span></a><p class="rv-ew-best">${l.best}</p></li>`)}</ul>
<p class="rv-muted">Read more than one: each site has its own audience and its own rules about who may review.</p>` : ''}
</section>`;
}

function aboutPage() {
    return html`<section><h1>How OpenVibe.Reviews works</h1>
<h2 id="signals">Signals</h2>
<p>A signal is one observation a source made about one thing: a Steam reviewer recommending a game, a shop page stating "4.2 out of 5 from 1,234 ratings". Signals come only from items that <a href="https://github.com/OpenVibers/OpenVibe.Sources">OpenVibe.Sources</a> retrieved, and each keeps its source, the item and its revision, when it was retrieved, when the source published it, and the licence note the source was ingested under. Reviews keeps the numbers, never the review text: the words belong to the people who wrote them.</p>
<p>When a source updates an item the old signal is marked replaced and a new one takes its place; when a source removes an item its signal is withdrawn. Both stay visible in the entity's history.</p>
<h2 id="method">The aggregate (method reviews-aggregate@1)</h2>
<ul>
<li><strong>Recommendation share</strong>: positives ÷ total over individual recommendations (1 of 1 or 0 of 1) and sources' own recommendation counts. When a source states its own count, its individual recommendations are not counted a second time.</li>
<li><strong>Rating</strong>: the count-weighted mean of value ÷ best over single ratings (count 1) and aggregate ratings (count = the number of ratings the source states), shown as a percentage, and on the source's scale when every input shares one. A rating whose source did not state the scale is left out, and the page says so.</li>
<li>Editors can exclude a source or a single signal, always with a reason shown on the page.</li>
<li>With no qualifying signal there is no aggregate. Not zero, not a placeholder: none.</li>
</ul>
<p>Each change to the inputs produces a new aggregate revision; the entity history lists them all.</p>
<h2 id="summaries">Summaries</h2>
<p>A summary is text written by an editor (or drafted by OpenVibe.AI and approved by an editor) whose pros and cons each cite the signals they rest on. A summary never carries a rating. If a cited signal is withdrawn or replaced, the summary is flagged on the page and a revised version waits for an editor.</p>
<h2 id="entities">Entities, merges and splits</h2>
<p>Items are matched to entities by deterministic rules: a source bound to one entity, the item's URL, a GTIN, SKU or MPN. A name alone is never enough: an editor confirms it. A merge never rewrites anything, so a split restores the earlier attribution exactly; both are recorded with who, when and why.</p>
<h2 id="corrections">Corrections and discussion</h2>
<p>Anyone signed in can send a correction to the editors from an entity page. What you send, and who you are, stays with the editors. When an editor corrects a published summary, the correction is a new revision published with a note saying what was corrected; the earlier revisions stay readable in the summary's revision history. Discussion lives on <a href="https://openvibe.community">OpenVibe.Community</a> and is shown here, never copied.</p>
</section>`;
}

function searchPage({ query, results }) {
    return html`<section><h1>Search</h1>
<form action="/search" method="get" class="rv-form"><label>Name <input type="search" name="q" value="${query}"></label><button type="submit">Search</button></form>
${query ? (results.length ? html`<ul>${results.map((x) => html`<li><a href="${epath(x)}">${x.name}</a> <span class="rv-tag">${KIND_LABEL[x.kind]}</span></li>`)}</ul>` : html`<p class="rv-muted">No entity matches.</p>`) : ''}</section>`;
}

function aggregateSection(p) {
    const head = html`<h2 id="aggregate">Aggregate</h2>`;
    if (!p.aggregate) {
        return html`<section class="rv-aggregate">${head}<p><strong>No aggregate.</strong> No source has stated a qualifying signal for this entity${p.aggregate_revision ? ' any more (the last aggregate revision recorded that nothing was left)' : ' yet'}. There is no rating here because there is no data behind one.</p></section>`;
    }
    const r = p.aggregate.result;
    const c = r.components;
    const byId = new Map([...p.signals, ...p.inactive_signals].map((s) => [s.signal_id, s]));
    return html`<section class="rv-aggregate">${head}
<div class="rv-agg-box">
${c.rating ? html`<p class="rv-agg"><strong>${c.rating.on_scale ? `${c.rating.on_scale.value} / ${c.rating.on_scale.best}` : `${c.rating.percent}%`}</strong> from ${n(c.rating.count)} rating${c.rating.count === 1 ? '' : 's'}${c.rating.on_scale ? html` <span class="rv-muted">(${c.rating.percent}% of the best possible rating)</span>` : ''}</p>` : ''}
${c.recommendation ? html`<p class="rv-agg"><strong>${c.recommendation.percent}%</strong> recommend: ${n(c.recommendation.positive)} of ${n(c.recommendation.total)}</p>` : ''}
<p class="rv-muted">Aggregate revision ${String(p.aggregate.revision)}, computed ${tl(p.aggregate.computed_at)} from ${String(r.inputs.length)} signal${r.inputs.length === 1 ? '' : 's'} of ${String(r.sources.length)} source${r.sources.length === 1 ? '' : 's'}, observed ${t(r.observed.earliest)} to ${t(r.observed.latest)}. <a href="/about#method">Method ${r.method}</a>.</p>
</div>
<details><summary>Computation</summary><ul>${r.computation.map((line) => html`<li><code>${line}</code></li>`)}</ul>
<p>Inputs: ${r.inputs.map((i, k) => html`${k ? ', ' : ''}<a href="#${i.signal_id}">${i.signal_id}</a>`)}</p>
${r.excluded.length ? html`<p>Left out:</p><ul>${r.excluded.map((x) => html`<li><a href="#${x.signal_id}">${x.signal_id}</a>${byId.get(x.signal_id) ? html` (${byId.get(x.signal_id).source_key})` : ''}: ${REASON_LABEL[x.reason] || x.reason}${x.note ? html` — ${x.note}` : ''}</li>`)}</ul>` : html`<p class="rv-muted">Nothing was left out.</p>`}
</details></section>`;
}

function citeLinks(cites) {
    return html`${cites.map((c, i) => html`${i ? ' ' : ''}<a href="#${c.signal_id}" class="${c.ok ? 'rv-cite' : 'rv-cite rv-cite-gone'}" title="${c.ok ? 'cited signal' : `cited signal is ${c.status}`}">[${c.signal_id.slice(-6)}${c.ok ? '' : ` ${c.status}`}]</a>`)}`;
}

/** The summary's public revision history: every revision readers may see, with each correction note. */
function summaryHistory(en, s) {
    const list = s.history || [];
    if (!list.length) return '';
    const corrections = list.filter((r) => r.correction).length;
    return html`<h3 id="summary-history">Revision history</h3>
<p class="rv-muted">${corrections ? `${corrections} correction${corrections === 1 ? '' : 's'}. ` : ''}Earlier revisions stay readable; a correction is a new revision, never an edit of an old one.</p>
<ul class="rv-revisions">${list.map((r) => html`<li><a href="${epath(en)}/summary/${String(r.number)}">Revision ${String(r.number)}</a> <span class="rv-tag">${r.status}</span> ${tl(r.created_at)}${r.disclosure ? html` · ${r.disclosure}` : ''}${r.correction ? html`<br><strong>Correction:</strong> ${r.correction.note}` : ''}</li>`)}</ul>`;
}

function correctionNotice(r, at) {
    return html`<p class="rv-notice rv-correction" role="status"><strong>Corrected</strong> ${t(at)}${r.correction.corrects ? ` (revision ${r.correction.corrects} corrected by revision ${r.number})` : ''}: ${r.correction.note}</p>`;
}

function summarySection(p) {
    const s = p.summary;
    const head = html`<h2 id="summary">Summary</h2>`;
    if (!s || !s.published) {
        const pending = s ? (Array.isArray(s.pending) ? s.pending.length : s.pending) : 0;
        return html`<section class="rv-summary">${head}<p class="rv-muted">No published summary.${pending ? ` ${pending} revision(s) wait for an editor.` : ''}</p></section>`;
    }
    const r = s.published;
    const pros = r.points.filter((x) => x.kind === 'pro');
    const cons = r.points.filter((x) => x.kind === 'con');
    const ov = r.points.find((x) => x.kind === 'overview');
    return html`<section class="rv-summary">${head}
${r.disclosure ? notice('ai', r.disclosure.long) : html`<p class="rv-muted">Written by OpenVibe.Reviews editors. Revision ${String(r.number)}, published ${t(s.revision_published_at)}.</p>`}
${r.correction ? correctionNotice(r, s.revision_published_at) : ''}
${s.flagged ? notice('warn', `Under review: ${s.flag_reason || 'a cited signal changed'} (${s.flagged_at ? s.flagged_at.slice(0, 10) : ''}). Points whose citations are marked below may no longer be supported.`) : ''}
${r.overview ? html`<div class="rv-content">${raw(ssr.renderMarkdown(r.overview, { headingShift: 2 }))}${ov ? html`<p class="rv-muted">Cites ${citeLinks(ov.citations)}</p>` : ''}</div>` : ''}
<div class="rv-proscons">
<div><h3>Pros</h3>${pros.length ? html`<ul>${pros.map((x) => html`<li${x.supported ? '' : raw(' class="rv-unsupported"')}>${x.text} ${citeLinks(x.citations)}</li>`)}</ul>` : html`<p class="rv-muted">None listed.</p>`}</div>
<div><h3>Cons</h3>${cons.length ? html`<ul>${cons.map((x) => html`<li${x.supported ? '' : raw(' class="rv-unsupported"')}>${x.text} ${citeLinks(x.citations)}</li>`)}</ul>` : html`<p class="rv-muted">None listed.</p>`}</div>
</div>
<p class="rv-muted">A summary never carries a rating: the only numbers are the signals above and the aggregate computed from them.</p>
${summaryHistory(p.entity, s)}</section>`;
}

function signalRow(s) {
    const pv = s.provenance;
    const link = safeUrl(s.canonical_url) || safeUrl(pv.source_homepage);
    const trust = trustFacts(s.trust);
    const ex = s.editor_trust && s.editor_trust.aggregate;
    return html`<tr id="${s.signal_id}" class="rv-signal rv-${s.status}">
<td>${TYPE_LABEL[s.type]}<br><strong>${signalValue(s)}</strong>${s.status !== 'active' ? html`<br><span class="rv-tag">${s.status}</span> <span class="rv-muted">${s.status_reason || ''}</span>` : ''}${ex ? html`<br><span class="rv-tag">excluded</span> <span class="rv-muted">${ex.note || ''}</span>` : ''}</td>
<td>${pv.source_name || s.source_key}${pv.source_name ? html`<br><span class="rv-muted">${s.source_key}</span>` : ''}</td>
<td>${link ? html`<a href="${link}" rel="nofollow noopener">${s.canonical_url ? 'item' : 'source'}</a> ` : ''}<span class="rv-muted">${s.source_item_id} r${String(s.item_revision)}</span>${trust ? html`<br><span class="rv-muted">${trust}</span>` : ''}</td>
<td>Retrieved ${tl(pv.retrieved_at)}${pv.last_seen_at && pv.last_seen_at !== pv.retrieved_at ? html`<br><span class="rv-muted">last seen ${tl(pv.last_seen_at)}</span>` : ''}${s.source_published_at ? html`<br><span class="rv-muted">source dated ${t(s.source_published_at)}</span>` : ''}</td>
<td class="rv-muted">${pv.license_note || 'No licence note recorded'}</td>
</tr>`;
}

function signalTable(signals, { caption }) {
    return html`<div class="rv-scroll"><table class="rv-signals"><caption class="rv-sr">${caption}</caption>
<thead><tr><th scope="col">Signal</th><th scope="col">Source</th><th scope="col">Item</th><th scope="col">When</th><th scope="col">Licence</th></tr></thead>
<tbody>${signals.map(signalRow)}</tbody></table></div>`;
}

function discussionHtml(d, { entity, actor }) {
    const head = html`<h2 id="discussion">Discussion</h2>`;
    if (!d || d.state === 'unavailable') return html`<section class="rv-discussion">${head}<p class="rv-notice rv-warn">The discussion (held by OpenVibe.Community) could not be loaded right now${d && d.reason ? html`: ${d.reason}` : ''}.</p></section>`;
    if (d.state === 'none') {
        return html`<section class="rv-discussion">${head}<p class="rv-muted">No discussion has been started for this entity.</p>
${actor && actor.subject ? html`<form method="post" action="${epath(entity)}/discuss" class="rv-form"><label for="rv-comment">Start it (posted to OpenVibe.Community as you)</label><textarea id="rv-comment" name="message" rows="3" maxlength="5000" required></textarea><button type="submit">Comment</button></form>` : html`<p><a href="/auth/login?next=${e(epath(entity))}">Sign in</a> to start the discussion.</p>`}</section>`;
    }
    const comments = (d.comments || []).filter((c) => !c.deleted);
    const form = actor && actor.subject
        ? html`<form method="post" action="${epath(entity)}/discuss" class="rv-form"><label for="rv-comment">Add a comment (posted to OpenVibe.Community as you)</label><textarea id="rv-comment" name="message" rows="3" maxlength="5000" required></textarea><button type="submit">Comment</button></form>`
        : html`<p><a href="/auth/login?next=${e(epath(entity))}">Sign in</a> to comment.</p>`;
    return html`<section class="rv-discussion">${head}<p class="rv-muted">Comments are held by OpenVibe.Community and shown here as they are there.</p>
${comments.length ? html`<ul class="rv-comments">${comments.map((c) => html`<li><strong>${c.display_name || 'Someone'}</strong> <span class="rv-muted">${t(c.created_at)}${c.origin === 'ai' ? ' · AI' : ''}</span><p>${c.message}</p></li>`)}</ul>` : html`<p class="rv-muted">No comments yet.</p>`}
${form}</section>`;
}

function entityPage(p, { discussion, actor, flash, members = null, elsewhere = [], seen = {}, records = null, reviewError = null, reviewValues = null }) {
    const en = p.entity;
    // Something of its own to show (members' reviews or official records): the empty source sections stay out.
    const own = (members && members.stats.count) || (records && (records.complaints || records.housing || records.inspections.length));
    const limits = [];
    for (const s of p.sources) {
        if (s.stale) limits.push(html`${s.name || s.key}: the source was stale when last checked${s.last_success_at ? html` (last successful fetch ${t(s.last_success_at)})` : ''}.`);
        if (s.trust.limitation) limits.push(html`${s.name || s.key}: ${s.trust.limitation.value}`);
        if (s.trust.verification) limits.push(html`${s.name || s.key} verification: ${s.trust.verification.value}`);
    }
    if (p.entity_trust.limitation) limits.push(html`${p.entity_trust.limitation.value}`);
    const otherNames = p.aliases.filter((a) => a.type === 'name' && a.value !== en.name);
    return html`${crumbs([{ name: 'Reviews', url: '/' }, { name: en.name }])}
<article class="rv-entity">
<header><h1>${en.name}</h1><p class="rv-muted"><span class="rv-tag">${KIND_LABEL[en.kind]}</span>${LOCAL.has(en.kind) && en.description ? html` · ${en.description}` : ''} · <a href="${epath(en)}/history">History</a> · <a href="${epath(en)}.json">JSON</a> · <a href="${epath(en)}/correct">Suggest a correction</a>${p.editor ? html` · <a href="${epath(en)}/edit">Edit</a>` : ''}</p></header>
${flash ? notice('ok', flash) : ''}
${en.description && !LOCAL.has(en.kind) ? html`<p>${en.description}</p>` : ''}
${records ? recordsSection(records, en) : ''}
${members ? memberSection(members, { entity: en, actor, editor: p.editor, error: reviewError, values: reviewValues }) : ''}
${p.merged_from.length ? html`<p class="rv-muted">Includes the signals of ${p.merged_from.map((m, i) => html`${i ? ', ' : ''}${m.name}`)} (merged here; see <a href="${epath(en)}/history#merges">history</a>).</p>` : ''}
${p.aggregate || p.signals.length || p.sources.length || !own ? aggregateSection(p) : ''}
${p.summary || p.editor || !own ? summarySection(p) : ''}
${p.signals.length || p.sources.length || p.inactive_signals.length ? html`<section><h2 id="signals">Signals from sources (${String(p.signals.length)})</h2>
${p.signals.length ? signalTable(p.signals, { caption: 'Signals from sources, with provenance' }) : html`<p class="rv-muted">No source has stated anything about this entity yet.</p>`}
${p.inactive_signals.length ? html`<p class="rv-muted">${String(p.inactive_signals.length)} earlier signal(s) were replaced or withdrawn by their sources: <a href="${epath(en)}/history#signals">history</a>.</p>` : ''}
</section>
<section><h2 id="limits">Sources and limitations</h2>
${p.sources.length ? html`<ul>${p.sources.map((s) => html`<li><strong>${s.name || s.key}</strong>${safeUrl(s.homepage_url) ? html` (<a href="${safeUrl(s.homepage_url)}" rel="nofollow noopener">site</a>)` : ''}${s.terms_note ? html`<br><span class="rv-muted">Terms: ${s.terms_note}</span>` : ''}${s.trust.aggregate ? html`<br><span class="rv-tag">excluded from the aggregate</span> ${s.trust.aggregate.note || ''}` : ''}</li>`)}</ul>` : html`<p class="rv-muted">No sources yet.</p>`}
${limits.length ? html`<ul class="rv-limits">${limits.map((l) => html`<li>${l}</li>`)}</ul>` : ''}
<p class="rv-muted">Coverage is what the sources above returned, nothing more: a source that samples recent reviews, one language or one shop describes that sample, not everyone's opinion.${p.open_corrections ? ` ${p.open_corrections} correction(s) are waiting for an editor.` : ''}</p>
</section>` : ''}
${elsewhereSection(elsewhere, en, { seen, actor, editor: p.editor })}
${otherNames.length || p.links.length ? html`<section><h2>Also known as and related</h2>
${otherNames.length ? html`<p>Also known as ${otherNames.map((a, i) => html`${i ? ', ' : ''}${a.value}`)}</p>` : ''}
${p.links.length ? html`<ul>${p.links.map((l) => html`<li>${l.type.replace(/_/g, ' ')}${l.direction === 'in' ? ' (from)' : ''}: ${l.other ? html`<a href="${epath(l.other)}">${l.other.name}</a>` : html`${l.ref ? `${l.ref.service} ${l.ref.type} ${l.ref.label || l.ref.id}` : ''}`}</li>`)}</ul>` : ''}</section>` : ''}
${raw(discussionHtml(discussion, { entity: en, actor }))}
<p class="rv-meta">Indexing: ${p.decision.indexable ? 'indexable' : `not indexed (${p.decision.codes.join(', ')})`}.</p>
</article>`;
}

function historyPage(h) {
    const en = h.entity;
    return html`${crumbs([{ name: 'Reviews', url: '/' }, { name: en.name, url: epath(en) }, { name: 'History' }])}
<section><h1>History of ${en.name}</h1>
<h2 id="aggregates">Aggregate revisions</h2>
${h.aggregates.length ? html`<div class="rv-scroll"><table class="rv-history"><thead><tr><th>Revision</th><th>Computed</th><th>Why</th><th>Result</th></tr></thead><tbody>${h.aggregates.map((a) => html`<tr><td>${String(a.revision)}</td><td>${tl(a.computed_at)}</td><td>${a.trigger.replace(/_/g, ' ')}</td><td>${aggregateLine(a)}${a.result ? html` <span class="rv-muted">(${String(a.result.inputs.length)} inputs)</span>` : ''}</td></tr>`)}</tbody></table></div>` : html`<p class="rv-muted">No aggregate has ever been computed: no qualifying signal yet.</p>`}
<h2 id="summary">Summary revisions</h2>
${h.summary_revisions.length ? html`<ul>${h.summary_revisions.map((r) => html`<li><a href="${epath(en)}/summary/${String(r.number)}">Revision ${String(r.number)}</a> <span class="rv-tag">${r.status}</span> ${t(r.created_at)}${r.disclosure ? html` · ${r.disclosure.short}` : ''}${r.system ? html` · prepared after: ${r.system.reason}` : ''}${r.correction ? html`<br><strong>Correction:</strong> ${r.correction.note}` : (r.message ? html` <span class="rv-muted">${r.message}</span>` : '')}</li>`)}</ul>` : html`<p class="rv-muted">No summary revisions.</p>`}
<h2 id="merges">Merges and splits</h2>
${h.merges.length ? html`<ul>${h.merges.map((m) => html`<li><a href="${epath(m.from)}">${m.from.name}</a> merged into <a href="${epath(m.to)}">${m.to.name}</a> ${tl(m.merged_at)}${m.note ? html` — ${m.note}` : ''}${m.split_at ? html`; split again ${tl(m.split_at)}${m.split_note ? html` — ${m.split_note}` : ''}` : html` <span class="rv-tag">active</span>`}</li>`)}</ul>` : html`<p class="rv-muted">None.</p>`}
<h2 id="signals">Every signal, including replaced and withdrawn ones</h2>
${h.signals.length ? signalTable(h.signals, { caption: 'All signals' }) : html`<p class="rv-muted">None.</p>`}
<h2 id="audit">Editorial log</h2>
${h.audit.length ? html`<ul class="rv-audit">${h.audit.map((a) => html`<li>${tl(a.at)} · ${a.action} · <span class="rv-muted">${a.actor}</span></li>`)}</ul>` : html`<p class="rv-muted">Nothing recorded.</p>`}
</section>`;
}

function summaryRevisionPage(en, r, { editor }) {
    return html`${crumbs([{ name: 'Reviews', url: '/' }, { name: en.name, url: epath(en) }, { name: 'History', url: `${epath(en)}/history` }, { name: `Summary revision ${r.number}` }])}
<section><h1>Summary revision ${String(r.number)} <span class="rv-tag">${r.status}</span></h1>
${r.disclosure ? notice('ai', r.disclosure.long) : html`<p class="rv-muted">Written by an editor ${t(r.created_at)}.</p>`}
${r.correction ? correctionNotice(r, r.created_at) : ''}
${r.system ? notice('warn', `Prepared automatically after: ${r.system.reason}. ${r.system.dropped_points && r.system.dropped_points.length ? `${r.system.dropped_points.length} point(s) were dropped because every signal they cited is gone.` : ''}`) : ''}
${r.overview ? html`<div class="rv-content">${raw(ssr.renderMarkdown(r.overview, { headingShift: 1 }))}</div>` : ''}
<ul>${r.points.filter((p) => p.kind !== 'overview').map((p) => html`<li><strong>${p.kind === 'pro' ? 'Pro' : 'Con'}:</strong> ${p.text} ${citeLinks(p.citations)}</li>`)}</ul>
${editor && (r.status === 'pending_ai' || r.status === 'pending_system' || r.status === 'draft') ? html`<form method="post" action="${epath(en)}/summary/${String(r.number)}/review" class="rv-form"><fieldset><legend>Editor review</legend>
<label>Note <input type="text" name="note" maxlength="500"></label>
<button type="submit" name="decision" value="approved">Approve and publish</button> <button type="submit" name="decision" value="rejected">Reject</button></fieldset></form>` : ''}
</section>`;
}

function correctionPage(en, { values = {}, error = null, done = false } = {}) {
    return html`${crumbs([{ name: 'Reviews', url: '/' }, { name: en.name, url: epath(en) }, { name: 'Suggest a correction' }])}
<section><h1>Suggest a correction for ${en.name}</h1>
${done ? notice('ok', 'Thank you. Your correction is in the editors\' queue.') : ''}
${error ? notice('error', error) : ''}
<p>Tell the editors what is wrong: a signal attributed to the wrong thing, a source that should not count, a summary point the cited signals do not support. What you write, and who you are, stays with the editors. If they correct the summary, they publish a correction note saying what changed, next to the earlier revision.</p>
<form method="post" action="${epath(en)}/correct" class="rv-form">
<label>About <select name="target_type">${['entity', 'signal', 'summary', 'aggregate', 'alias'].map((x) => html`<option value="${x}"${values.target_type === x ? raw(' selected') : ''}>${x}</option>`)}</select></label>
<label>Which one (optional: a signal id such as sig_…) <input type="text" name="target_id" maxlength="100" value="${values.target_id || ''}"></label>
<label>What is wrong <textarea name="body" rows="6" minlength="10" maxlength="4000" required>${values.body || ''}</textarea></label>
<label>Evidence URL (optional) <input type="url" name="evidence_url" value="${values.evidence_url || ''}"></label>
<button type="submit">Send to the editors</button></form></section>`;
}

// ── Editor surfaces ──────────────────────────────────────────
function editorHome({ queue, pending, flagged, corrections, stats, itemView }) {
    return html`<section><h1>Editor desk</h1>
<p class="rv-muted">${n(stats.entities)} entities · ${n(stats.signals)} live signals · ${n(stats.items_unresolved)} items to resolve · ${n(stats.corrections_open)} open corrections · ${n(stats.summaries_flagged)} flagged summaries</p>
<p><a class="rv-button" href="/editor/entities/new">New entity</a></p>
<form method="post" action="/editor/sync" class="rv-inline"><button type="submit">Pull review items from OpenVibe.Sources now</button></form>
<h2 id="items">Items waiting for resolution</h2>
${queue.length ? html`<ul>${queue.map((row) => { const it = itemView(row); return html`<li><a href="/editor/items/${e(it.id)}">${it.title || it.identity}</a> <span class="rv-tag">${it.resolution}</span> <span class="rv-muted">${it.source_key} · ${it.kind}${it.candidates.length ? ` · ${it.candidates.length} candidate(s)` : ''}</span></li>`; })}</ul>` : html`<p class="rv-muted">Nothing waits.</p>`}
<h2 id="summaries">Summary revisions waiting for review</h2>
${pending.length ? html`<ul>${pending.map((x) => html`<li><a href="${epath(x.entity)}">${x.entity.name}</a>: ${x.pending.map((r, i) => html`${i ? ', ' : ''}<a href="${epath(x.entity)}/summary/${String(r.number)}">revision ${String(r.number)}</a> <span class="rv-tag">${r.status}</span>`)}</li>`)}</ul>` : html`<p class="rv-muted">Nothing waits.</p>`}
<h2 id="flagged">Flagged summaries</h2>
${flagged.length ? html`<ul>${flagged.map((s) => html`<li><a href="${epath(s.entity)}">${s.entity.name}</a>: ${s.flag_reason}</li>`)}</ul>` : html`<p class="rv-muted">None.</p>`}
<h2 id="corrections">Open corrections</h2>
${corrections.length ? html`<ul>${corrections.map((c) => html`<li><a href="${epath(c.entity)}">${c.entity.name}</a> · ${c.target_type}${c.target_id ? ` ${c.target_id}` : ''} · ${t(c.created_at)}<blockquote>${c.body}</blockquote>${safeUrl(c.evidence_url) ? html`<a href="${safeUrl(c.evidence_url)}" rel="nofollow ugc noopener noreferrer">evidence</a> <span class="rv-muted">(sent by the reader; not checked)</span>` : ''}
<form method="post" action="/editor/corrections/${e(c.id)}" class="rv-form">
${c.summary_published ? html`<label>Correction note, published with a new summary revision (required to accept) <input type="text" name="correction_note" maxlength="2000"></label>
<p class="rv-muted">Accepting publishes the current summary text again as a correction revision with this note. To change the text as well, <a href="${epath(c.entity)}/edit?correction=${e(c.id)}#summary-form">correct the summary</a>.</p>` : ''}
<label>Note for editors (not published) <input type="text" name="note" maxlength="500"></label>
<button type="submit" name="status" value="accepted">Accepted</button> <button type="submit" name="status" value="rejected">Rejected</button></form></li>`)}</ul>` : html`<p class="rv-muted">None.</p>`}
</section>`;
}

function kindOptions(selected) {
    return html`${Object.keys(KIND_LABEL).map((k) => html`<option value="${k}"${selected === k ? raw(' selected') : ''}>${KIND_LABEL[k]}</option>`)}`;
}

function newEntityPage({ values = {}, error = null } = {}) {
    return html`<section><h1>New entity</h1>${error ? notice('error', error) : ''}
<form method="post" action="/editor/entities/new" class="rv-form">
<label>Name <input type="text" name="name" required maxlength="200" value="${values.name || ''}"></label>
<label>Kind <select name="kind">${kindOptions(values.kind || 'other')}</select></label>
<label>Description (optional) <input type="text" name="description" maxlength="2000" value="${values.description || ''}"></label>
<fieldset><legend>Identifiers (optional, used to resolve source items)</legend>
<label>Source binding: every item of this OpenVibe.Sources source is about this entity <input type="text" name="alias_source" value="${values.alias_source || ''}" placeholder="steam-reviews-portal-2"></label>
<label>URL <input type="url" name="alias_url" value="${values.alias_url || ''}"></label>
<label>GTIN <input type="text" name="alias_gtin" value="${values.alias_gtin || ''}"></label>
<label>SKU <input type="text" name="alias_sku" value="${values.alias_sku || ''}"></label>
<label>External id (namespace:id) <input type="text" name="alias_external" value="${values.alias_external || ''}" placeholder="steam_app:620"></label>
</fieldset>
<button type="submit">Create</button></form></section>`;
}

function editEntityPage({ page: p, error = null, flash = null, correcting = null, entities = [] }) {
    const en = p.entity;
    const allSignals = p.signals;
    const sel = (name, chosen = []) => html`<select name="${name}" multiple size="4">${allSignals.map((s) => html`<option value="${s.signal_id}"${chosen.includes(s.signal_id) ? raw(' selected') : ''}>${s.signal_id.slice(-8)} · ${s.source_key} · ${signalValue(s)}</option>`)}</select>`;
    const cur = p.summary && p.summary.published;
    const pros = cur ? cur.points.filter((x) => x.kind === 'pro') : [];
    const cons = cur ? cur.points.filter((x) => x.kind === 'con') : [];
    const ov = cur ? cur.points.find((x) => x.kind === 'overview') : null;
    const rows = (kind, list) => html`${[0, 1, 2, 3, 4, 5].map((i) => html`<div class="rv-point"><label>${kind === 'pro' ? 'Pro' : 'Con'} ${String(i + 1)} <input type="text" name="${kind}_text_${String(i)}" maxlength="600" value="${list[i] ? list[i].text : ''}"></label><label>cites ${sel(`${kind}_signals_${String(i)}`, list[i] ? list[i].citations.filter((c) => c.ok).map((c) => c.signal_id) : [])}</label></div>`)}`;
    return html`${crumbs([{ name: 'Reviews', url: '/' }, { name: en.name, url: epath(en) }, { name: 'Edit' }])}
<section><h1>Edit ${en.name}</h1>${error ? notice('error', error) : ''}${flash ? notice('ok', flash) : ''}
<h2>Details</h2>
<form method="post" action="${epath(en)}/edit" class="rv-form"><input type="hidden" name="action" value="details">
<label>Name <input type="text" name="name" maxlength="200" value="${en.name}"></label>
<label>Slug <input type="text" name="slug" maxlength="90" value="${en.slug}"></label>
<label>Kind <select name="kind">${kindOptions(en.kind)}</select></label>
<label>Description <input type="text" name="description" maxlength="2000" value="${en.description || ''}"></label>
<label class="rv-check"><input type="checkbox" name="noindex" value="1"${en.noindex ? raw(' checked') : ''}> Ask search engines not to index this page</label>
<button type="submit">Save</button></form>

<h2>Identifiers</h2>
<ul>${p.aliases.map((a) => html`<li>${a.type}: ${a.value} <form method="post" action="${epath(en)}/edit" class="rv-inline"><input type="hidden" name="action" value="remove_alias"><input type="hidden" name="alias_id" value="${a.id}"><button type="submit">Remove</button></form></li>`)}</ul>
<form method="post" action="${epath(en)}/edit" class="rv-form"><input type="hidden" name="action" value="add_alias">
<label>Type <select name="type">${['name', 'url', 'gtin', 'sku', 'mpn', 'source', 'external'].map((x) => html`<option value="${x}">${x}</option>`)}</select></label>
<label>Value <input type="text" name="value" required maxlength="1000"></label><button type="submit">Add identifier</button></form>

<h2>Summary</h2>
<p class="rv-muted">Every pro and con cites the signals it rests on. A summary carries no rating. Saving creates a new revision; "Save and publish" publishes it.</p>
<form method="post" action="${epath(en)}/summary" class="rv-form" id="summary-form">
${correcting ? html`<div class="rv-notice rv-correction"><p>Correcting the summary in answer to a reader's correction request (${correcting.target_type}${correcting.target_id ? ` ${correcting.target_id}` : ''}):</p><blockquote>${correcting.body}</blockquote><p class="rv-muted">Publishing accepts the request. The request stays with the editors; the correction note below is what readers see.</p></div><input type="hidden" name="correction_id" value="${correcting.id}">` : ''}
<label>Overview (Markdown) <textarea name="overview" rows="6" maxlength="6000">${cur ? cur.overview : ''}</textarea></label>
<label>The overview cites ${sel('overview_signals', ov ? ov.citations.filter((c) => c.ok).map((c) => c.signal_id) : [])}</label>
<fieldset><legend>Pros</legend>${rows('pro', pros)}</fieldset>
<fieldset><legend>Cons</legend>${rows('con', cons)}</fieldset>
<label>Revision note (public: shown in the summary's history) <input type="text" name="message" maxlength="500"></label>
${cur ? html`<label>Correction note (public; fill it in only to correct the published summary: the revision is published at once and the note stays in its history) <input type="text" name="correction_note" maxlength="2000"${correcting ? raw(' required minlength="10"') : ''}></label>` : ''}
<input type="hidden" name="expected_revision" value="${String(p.summary ? p.summary.head_revision : 0)}">
<button type="submit" name="publish" value="0">Save</button> <button type="submit" name="publish" value="1">Save and publish</button></form>
${p.summary && p.summary.pending && p.summary.pending.length ? html`<p>Waiting for review: ${p.summary.pending.map((r, i) => html`${i ? ', ' : ''}<a href="${epath(en)}/summary/${String(r.number)}">revision ${String(r.number)}</a> <span class="rv-tag">${r.status}</span>`)}</p>` : ''}
${p.summary && p.summary.state === 'published' ? html`<form method="post" action="${epath(en)}/edit" class="rv-inline"><input type="hidden" name="action" value="unpublish_summary"><button type="submit">Unpublish the summary</button></form>` : ''}

<h2>Trust</h2>
<p class="rv-muted">Exclude a source or a signal from the aggregate (the reason is shown on the page), or record a limitation readers should know.</p>
<form method="post" action="${epath(en)}/edit" class="rv-form"><input type="hidden" name="action" value="trust">
<label>Applies to <select name="scope_ref">${p.sources.map((s) => html`<option value="source:${s.key}">source ${s.name || s.key}</option>`)}${allSignals.map((s) => html`<option value="signal:${s.signal_id}">signal ${s.signal_id.slice(-8)} (${s.source_key})</option>`)}<option value="entity:${en.id}">this entity</option></select></label>
<label>What <select name="key"><option value="aggregate">aggregate: include / exclude</option><option value="limitation">limitation note</option><option value="verification">verification note</option></select></label>
<label>Value (include / exclude, or the note) <input type="text" name="value" maxlength="1000"></label>
<label>Reason (required to exclude) <input type="text" name="note" maxlength="1000"></label>
<button type="submit">Record</button></form>

<h2>Links</h2>
<form method="post" action="${epath(en)}/edit" class="rv-form"><input type="hidden" name="action" value="add_link">
<label>Type <select name="type">${['related', 'edition_of', 'successor_of', 'part_of'].map((x) => html`<option value="${x}">${x.replace(/_/g, ' ')}</option>`)}</select></label>
<label>Other entity (slug) <input type="text" name="to" required></label><button type="submit">Link</button></form>

<h2>Merge</h2>
<p class="rv-muted">Merging keeps everything as it is (aliases, signal attribution) and shows this entity's signals under the target. It can be split again at any time, exactly.</p>
<form method="post" action="${epath(en)}/merge" class="rv-form">
<label>Merge ${en.name} into (slug) <input type="text" name="into" required list="rv-entities"></label>
<datalist id="rv-entities">${entities.filter((x) => x.id !== en.id).map((x) => html`<option value="${x.slug}">${x.name}</option>`)}</datalist>
<label>Why <input type="text" name="note" maxlength="500" required></label>
<button type="submit">Merge</button></form>
${p.merged_from.length ? html`<h3>Split</h3><ul>${p.merged_from.filter((m) => m.merged_into === en.id).map((m) => html`<li>${m.name} <form method="post" action="${epath(m)}/split" class="rv-inline"><input type="text" name="note" placeholder="Why" maxlength="500" required> <button type="submit">Split</button></form></li>`)}</ul>` : ''}
</section>`;
}

function itemPage({ item, candidates, error = null }) {
    return html`${crumbs([{ name: 'Editor desk', url: '/editor' }, { name: `Item ${item.id}` }])}
<section><h1>Source item ${item.id}</h1>${error ? notice('error', error) : ''}
<table class="rv-fields"><tbody>
<tr><th>Source</th><td>${item.source_key}</td></tr>
<tr><th>Kind</th><td>${item.kind}</td></tr>
<tr><th>Title</th><td>${item.title || ''}</td></tr>
<tr><th>URL</th><td>${safeUrl(item.canonical_url) ? html`<a href="${safeUrl(item.canonical_url)}" rel="nofollow noopener">${item.canonical_url}</a>` : html`${item.canonical_url || ''}`}</td></tr>
<tr><th>Identity</th><td>${item.identity}</td></tr>
<tr><th>Retrieved</th><td>${tl(item.retrieved_at)} (revision ${String(item.item_revision)})</td></tr>
<tr><th>Fields kept</th><td><code>${JSON.stringify(item.fields)}</code></td></tr>
<tr><th>Signal</th><td>${item.signal_note || (item.signal ? signalValue(item.signal) : '')}</td></tr>
<tr><th>Resolution</th><td>${item.resolution}${item.resolution_rule ? ` (${item.resolution_rule})` : ''}</td></tr>
</tbody></table>
<h2>Resolve</h2>
<form method="post" action="/editor/items/${e(item.id)}" class="rv-form"><input type="hidden" name="action" value="resolve">
<label>Entity <select name="entity">${candidates.map((c) => html`<option value="${c.slug}">${c.name} (${c.slug})</option>`)}</select></label>
<label>Or another entity (slug) <input type="text" name="entity_other"></label>
<label>Remember an identifier of this item for next time <select name="add_alias"><option value="">no</option><option value="source">its source (every item of ${item.source_key} is this entity)</option>${item.canonical_url ? html`<option value="url">its URL</option>` : ''}${item.fields.gtin ? html`<option value="gtin">its GTIN</option>` : ''}${item.fields.sku ? html`<option value="sku">its SKU</option>` : ''}${item.title ? html`<option value="name">its name</option>` : ''}</select></label>
<button type="submit">Attribute to this entity</button></form>
<form method="post" action="/editor/items/${e(item.id)}" class="rv-form"><input type="hidden" name="action" value="ignore"><label>Not about anything Reviews covers: <input type="text" name="note" placeholder="Note"></label><button type="submit">Ignore</button></form>
</section>`;
}

module.exports = {
    everywherePage,
    home, homeJsonLd, aboutPage, searchPage, entityPage, historyPage, summaryRevisionPage, correctionPage,
    editorHome, newEntityPage, editEntityPage, itemPage, signInPage, errorBody, epath, signalValue, KIND_LABEL,
    reviewStartPage, kindPage, elsewhereLinks, savePage, KIND_PLURAL,
};
