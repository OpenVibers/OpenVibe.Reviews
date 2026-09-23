'use strict';
/**
 * Page bodies. Every interpolated value goes through openvibe-publishing/ssr's html`` (escaped
 * unless raw()). Forms are plain HTML posts; nothing here needs JavaScript.
 *
 * Numbers shown here come from review_signals (with their provenance) or from the aggregate
 * computed over them. There is no place in these templates that prints a rating from anywhere
 * else, and no star glyphs: values are printed as the source stated them.
 */
const ssr = require('openvibe-publishing/ssr');

const { html, raw } = ssr;
const t = (v) => raw(ssr.timeTag(v));
const tl = (v) => raw(ssr.timeTag(v, { label: v ? new Date(v).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '' }));
const e = encodeURIComponent;
const n = (x) => (x == null ? '' : Number(x).toLocaleString('en-US'));

const KIND_LABEL = { product: 'Product', game: 'Game', software: 'Software', service: 'Service', place: 'Place', organization: 'Organization', media: 'Media', other: 'Other' };
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

function home({ entities, total, editor }) {
    return html`<section class="rv-intro"><h1>OpenVibe.Reviews</h1>
<p>Review signals gathered from named sources. Every number on an entity page shows where it came from and when it was read, the aggregate lists its inputs and how it was computed, and there is no aggregate at all when no source has stated anything. Summaries are written or checked by a person; AI drafts are never published on their own and never produce a rating.</p>
<p><a href="/about">How it works</a>${editor ? html` · <a href="/editor">Editor desk</a>` : ''}</p></section>
<section><h2>Entities with source data</h2>
${entities.length ? html`<ul class="rv-entities">${entities.map((x) => html`<li><a href="${epath(x.entity)}"><strong>${x.entity.name}</strong></a> <span class="rv-tag">${KIND_LABEL[x.entity.kind]}</span><br><span class="rv-muted">${aggregateLine(x.aggregate)}</span></li>`)}</ul>`
        : html`<p class="rv-muted">Nothing yet. Entities appear here once a source has stated something about them (or an editor has published a summary).</p>`}
<p class="rv-muted">${n(total)} entit${total === 1 ? 'y' : 'ies'} in total. <a href="/feed.atom">Atom</a> · <a href="/feed.json">JSON Feed</a></p></section>`;
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

function entityPage(p, { discussion, actor, flash }) {
    const en = p.entity;
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
<header><h1>${en.name}</h1><p class="rv-muted"><span class="rv-tag">${KIND_LABEL[en.kind]}</span> · <a href="${epath(en)}/history">History</a> · <a href="${epath(en)}.json">JSON</a> · <a href="${epath(en)}/correct">Suggest a correction</a>${p.editor ? html` · <a href="${epath(en)}/edit">Edit</a>` : ''}</p></header>
${flash ? notice('ok', flash) : ''}
${en.description ? html`<p>${en.description}</p>` : ''}
${p.merged_from.length ? html`<p class="rv-muted">Includes the signals of ${p.merged_from.map((m, i) => html`${i ? ', ' : ''}${m.name}`)} (merged here; see <a href="${epath(en)}/history#merges">history</a>).</p>` : ''}
${aggregateSection(p)}
${summarySection(p)}
<section><h2 id="signals">Signals (${String(p.signals.length)})</h2>
${p.signals.length ? signalTable(p.signals, { caption: 'Signals from sources, with provenance' }) : html`<p class="rv-muted">No source has stated anything about this entity yet.</p>`}
${p.inactive_signals.length ? html`<p class="rv-muted">${String(p.inactive_signals.length)} earlier signal(s) were replaced or withdrawn by their sources: <a href="${epath(en)}/history#signals">history</a>.</p>` : ''}
</section>
<section><h2 id="limits">Sources and limitations</h2>
${p.sources.length ? html`<ul>${p.sources.map((s) => html`<li><strong>${s.name || s.key}</strong>${safeUrl(s.homepage_url) ? html` (<a href="${safeUrl(s.homepage_url)}" rel="nofollow noopener">site</a>)` : ''}${s.terms_note ? html`<br><span class="rv-muted">Terms: ${s.terms_note}</span>` : ''}${s.trust.aggregate ? html`<br><span class="rv-tag">excluded from the aggregate</span> ${s.trust.aggregate.note || ''}` : ''}</li>`)}</ul>` : html`<p class="rv-muted">No sources yet.</p>`}
${limits.length ? html`<ul class="rv-limits">${limits.map((l) => html`<li>${l}</li>`)}</ul>` : ''}
<p class="rv-muted">Coverage is what the sources above returned, nothing more: a source that samples recent reviews, one language or one shop describes that sample, not everyone's opinion.${p.open_corrections ? ` ${p.open_corrections} correction(s) are waiting for an editor.` : ''}</p>
</section>
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
    home, aboutPage, searchPage, entityPage, historyPage, summaryRevisionPage, correctionPage,
    editorHome, newEntityPage, editEntityPage, itemPage, signInPage, errorBody, epath, signalValue, KIND_LABEL,
};
