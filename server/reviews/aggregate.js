'use strict';
/**
 * The aggregate of an entity: a pure function of the signals present and the editors' trust
 * decisions. It exposes every input, every exclusion with its reason, and the computation.
 *
 * There is no default. With no qualifying signal the result is null — not zero, not "no rating
 * yet" dressed up as a number. Summaries, AI output and editors' text never enter here: the only
 * inputs are rows of review_signals, which come only from OpenVibe.Sources items.
 *
 * Method reviews-aggregate@1:
 *   recommendation   positives / total over `recommendation` (one reviewer, 1 of 1 or 0 of 1) and
 *                    `recommendation_tally` (a source's own counts) signals. A source that states a
 *                    tally has its individual recommendations left out (they are inside the tally);
 *                    of several tallies from one source only the most recently observed counts.
 *   rating           count-weighted mean of value / best over `rating` (count 1) and
 *                    `rating_aggregate` (count = the source's stated number of ratings) signals,
 *                    reported as a percentage; when every input shares one scale, also on that scale.
 *                    A rating whose source did not state the scale (bestRating) is left out.
 */
const crypto = require('crypto');

const METHOD = 'reviews-aggregate@1';

const round = (x, d) => { const f = 10 ** d; return Math.round(x * f) / f; };

function stable(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
}

function hashOf(result) {
    return crypto.createHash('sha256').update(stable(result)).digest('hex');
}

function inputView(s) {
    const v = { signal_id: s.id, type: s.type, source_key: s.source_key, source_item_id: s.source_item_id, entity_id: s.entity_id, observed_at: s.observed_at };
    if (s.type === 'recommendation') { v.recommended = s.recommended === 1; v.weight = 1; }
    if (s.type === 'recommendation_tally') { v.positive_count = s.positive_count; v.total_count = s.total_count; v.weight = s.total_count; }
    if (s.type === 'rating' || s.type === 'rating_aggregate') {
        v.rating_value = s.rating_value; v.rating_best = s.rating_best; v.rating_worst = s.rating_worst; v.rating_count = s.rating_count; v.weight = s.rating_count;
    }
    return v;
}

/**
 * signals: active review_signals rows of the entity (and of the entities merged into it).
 * exclusions: { sources: Map<key, note>, signals: Map<id, note> } from review_trust_metadata.
 * → null | { method, components: { recommendation?, rating? }, inputs, excluded, sources, observed, computation }
 */
function computeAggregate(signals, { exclusions = { sources: new Map(), signals: new Map() } } = {}) {
    const excluded = [];
    const candidates = [];
    const sorted = [...signals].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const s of sorted) {
        if (s.status !== 'active') continue;
        if (exclusions.sources.has(s.source_key)) { excluded.push({ signal_id: s.id, reason: 'source_excluded_by_editor', note: exclusions.sources.get(s.source_key) || null }); continue; }
        if (exclusions.signals.has(s.id)) { excluded.push({ signal_id: s.id, reason: 'signal_excluded_by_editor', note: exclusions.signals.get(s.id) || null }); continue; }
        if ((s.type === 'rating' || s.type === 'rating_aggregate') && !(s.rating_best > 0)) { excluded.push({ signal_id: s.id, reason: 'scale_not_stated', note: 'The source did not state the best possible rating, so the value cannot be read on a scale.' }); continue; }
        if ((s.type === 'rating_aggregate' || s.type === 'recommendation_tally') && !((s.rating_count || s.total_count) > 0)) { excluded.push({ signal_id: s.id, reason: 'no_count', note: null }); continue; }
        candidates.push(s);
    }

    // One tally per source (the latest observation); a source's single recommendations are inside its tally.
    const latestTally = new Map();
    for (const s of candidates) {
        if (s.type !== 'recommendation_tally') continue;
        const cur = latestTally.get(s.source_key);
        if (!cur || s.observed_at > cur.observed_at || (s.observed_at === cur.observed_at && s.id > cur.id)) latestTally.set(s.source_key, s);
    }
    const used = [];
    for (const s of candidates) {
        if (s.type === 'recommendation_tally' && latestTally.get(s.source_key) !== s) { excluded.push({ signal_id: s.id, reason: 'older_tally_same_source', note: null }); continue; }
        if (s.type === 'recommendation' && latestTally.has(s.source_key)) { excluded.push({ signal_id: s.id, reason: 'covered_by_source_tally', note: null }); continue; }
        used.push(s);
    }

    const recs = used.filter((s) => s.type === 'recommendation' || s.type === 'recommendation_tally');
    const rates = used.filter((s) => s.type === 'rating' || s.type === 'rating_aggregate');
    const components = {};
    const computation = [];

    if (recs.length) {
        let positive = 0;
        let total = 0;
        for (const s of recs) {
            if (s.type === 'recommendation') { positive += s.recommended === 1 ? 1 : 0; total += 1; } else { positive += s.positive_count; total += s.total_count; }
        }
        if (total > 0) {
            components.recommendation = { positive, total, percent: round((positive / total) * 100, 1), inputs: recs.map((s) => s.id) };
            computation.push(`recommendation: ${positive} of ${total} recommend (${components.recommendation.percent}%) = sum of positives / sum of totals over ${recs.length} signal${recs.length === 1 ? '' : 's'}`);
        }
    }
    if (rates.length) {
        let weight = 0;
        let normSum = 0;
        let valueSum = 0;
        const bests = new Set();
        const worsts = new Set();
        for (const s of rates) {
            const n = s.rating_count;
            weight += n;
            normSum += (s.rating_value / s.rating_best) * n;
            valueSum += s.rating_value * n;
            bests.add(s.rating_best);
            worsts.add(s.rating_worst == null ? 'unstated' : s.rating_worst);
        }
        if (weight > 0) {
            const r = { count: weight, percent: round((normSum / weight) * 100, 1), inputs: rates.map((s) => s.id) };
            if (bests.size === 1) {
                r.on_scale = { value: round(valueSum / weight, 2), best: [...bests][0] };
                if (worsts.size === 1 && !worsts.has('unstated')) r.on_scale.worst = [...worsts][0];
            }
            components.rating = r;
            computation.push(`rating: ${r.percent}% = Σ(value ÷ best × count) ÷ Σ count over ${rates.length} signal${rates.length === 1 ? '' : 's'} and ${weight} rating${weight === 1 ? '' : 's'}`
                + (r.on_scale ? `; on the shared ${r.on_scale.best}-point scale: ${r.on_scale.value} = Σ(value × count) ÷ Σ count` : ''));
        }
    }

    if (!components.recommendation && !components.rating) return null;
    const inputs = used.map(inputView);
    const observed = inputs.map((i) => i.observed_at).sort();
    return {
        method: METHOD,
        components,
        inputs,
        excluded,
        sources: [...new Set(inputs.map((i) => i.source_key))].sort(),
        observed: { earliest: observed[0], latest: observed[observed.length - 1] },
        computation,
    };
}

/**
 * schema.org AggregateRating fields for an aggregate, or null. The rating component wins; a
 * recommendation share is expressed as a 0–100 value with its real count.
 */
function ratingForStructuredData(result) {
    if (!result) return null;
    const r = result.components.rating;
    if (r && r.count > 0) {
        if (r.on_scale) return { value: r.on_scale.value, best: r.on_scale.best, worst: r.on_scale.worst, count: r.count };
        return { value: r.percent, best: 100, worst: 0, count: r.count };
    }
    const c = result.components.recommendation;
    if (c && c.total > 0) return { value: c.percent, best: 100, worst: 0, count: c.total };
    return null;
}

module.exports = { computeAggregate, ratingForStructuredData, hashOf, stable, METHOD };
