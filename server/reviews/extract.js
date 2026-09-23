'use strict';
/**
 * From one OpenVibe.Sources item (sources.item@1) to what Reviews keeps of it: the signal fields
 * (never review text — the text belongs to its author and Reviews does not republish it), the
 * identifiers used to resolve it to an entity, and at most one typed signal.
 *
 * Signals are observations exactly as the source stated them. Nothing is computed, defaulted or
 * guessed here: a rating without a stated scale is recorded with rating_best = null (and the
 * aggregate leaves it out, saying why); an aggregate rating without a count is not a signal.
 *
 *   review_signal (API adapter, e.g. Steam appreviews)  voted_up → recommendation
 *                                                       total_positive/total_reviews or
 *                                                       recommend_count/total_count → recommendation_tally
 *   product (JSON-LD)                                   aggregate_rating { value, best, worst, count|review_count } → rating_aggregate
 *   review (JSON-LD)                                    rating { value, best, worst } → rating (one rating)
 */

function num(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v.trim());
    return null;
}

function count(v) {
    const n = num(v);
    return n != null && Number.isInteger(n) && n >= 0 ? n : null;
}

function boolOf(v) {
    if (v === true || v === 1 || v === '1' || v === 'true') return true;
    if (v === false || v === 0 || v === '0' || v === 'false') return false;
    return null;
}

// Per-review facts a source states about the reviewer (kept as trust metadata of the signal).
const TRUST_FIELDS = ['steam_purchase', 'received_for_free', 'written_during_early_access', 'verified_purchase', 'playtime_at_review_min', 'votes_up', 'votes_funny', 'weighted_vote_score', 'language'];
// Identifiers used for resolution.
const ID_FIELDS = ['sku', 'gtin', 'mpn', 'brand', 'schema_type', 'item_reviewed', 'item_reviewed_type'];
const TALLY = [['total_positive', 'total_reviews'], ['recommend_count', 'total_count']];

function scalar(v) {
    if (v == null) return null;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string') return v.slice(0, 200);
    return null;
}

function ratingOf(r) {
    if (!r || typeof r !== 'object') return null;
    const out = { value: num(r.value), best: num(r.best), worst: num(r.worst), count: count(r.count), review_count: count(r.review_count) };
    return out.value == null && out.count == null && out.review_count == null ? null : out;
}

/** The fields Reviews stores for an item: signal values, reviewer facts, identifiers. No text. */
function keptFields(item) {
    const f = item && item.fields && typeof item.fields === 'object' ? item.fields : {};
    const out = {};
    if (f.voted_up !== undefined) out.voted_up = boolOf(f.voted_up);
    for (const [p, t] of TALLY) {
        if (f[p] !== undefined) out[p] = count(f[p]);
        if (f[t] !== undefined) out[t] = count(f[t]);
    }
    if (f.aggregate_rating !== undefined) out.aggregate_rating = ratingOf(f.aggregate_rating);
    if (f.rating !== undefined) out.rating = ratingOf(f.rating);
    for (const k of [...TRUST_FIELDS, ...ID_FIELDS]) if (f[k] !== undefined && scalar(f[k]) !== null) out[k] = scalar(f[k]);
    return out;
}

/** Titles are kept only where they name the thing (a product page), never a reviewer's headline. */
function keptTitle(item) {
    return item && item.kind === 'product' && item.title ? String(item.title).slice(0, 300) : null;
}

/**
 * Why a stated rating cannot be counted on its own scale, or null. Below the stated worst (or below
 * zero when no worst is stated) or above the best is not an opinion the aggregate can use.
 */
function outOfScale(r) {
    if (r.best != null && (r.best <= 0 || r.value > r.best)) return `rating ${r.value} is outside the stated scale (best ${r.best})`;
    if (r.worst != null && r.value < r.worst) return `rating ${r.value} is outside the stated scale (worst ${r.worst})`;
    if (r.worst == null && r.value < 0) return `rating ${r.value} is below zero and the source states no scale minimum`;
    return null;
}

function trustOf(fields) {
    const out = {};
    for (const k of TRUST_FIELDS) if (fields[k] !== undefined && fields[k] !== null) out[k] = fields[k];
    return out;
}

/**
 * → { signal: { type, recommended?, positive_count?, total_count?, rating_value?, rating_best?,
 *               rating_worst?, rating_count?, trust }, note: null }
 *   | { signal: null, note: 'why there is no signal' }
 */
function extractSignal(item) {
    const f = keptFields(item);
    const trust = trustOf(f);
    for (const [p, t] of TALLY) {
        if (f[p] != null && f[t] != null) {
            if (f[p] > f[t]) return { signal: null, note: `${p} (${f[p]}) exceeds ${t} (${f[t]})` };
            return { signal: { type: 'recommendation_tally', positive_count: f[p], total_count: f[t], trust }, note: null };
        }
    }
    if (item.kind === 'review_signal' || f.voted_up !== undefined) {
        if (f.voted_up === true || f.voted_up === false) return { signal: { type: 'recommendation', recommended: f.voted_up ? 1 : 0, trust }, note: null };
        return { signal: null, note: 'the item states no recommendation (voted_up)' };
    }
    if (item.kind === 'product') {
        const r = f.aggregate_rating;
        if (!r || r.value == null) return { signal: null, note: 'the product states no aggregate rating' };
        const n = r.count != null && r.count > 0 ? r.count : (r.review_count != null && r.review_count > 0 ? r.review_count : null);
        if (n == null) return { signal: null, note: 'the aggregate rating states no number of ratings' };
        if (outOfScale(r)) return { signal: null, note: outOfScale(r) };
        return { signal: { type: 'rating_aggregate', rating_value: r.value, rating_best: r.best, rating_worst: r.worst, rating_count: n, trust }, note: null };
    }
    if (item.kind === 'review') {
        const r = f.rating;
        if (!r || r.value == null) return { signal: null, note: 'the review states no rating' };
        if (outOfScale(r)) return { signal: null, note: outOfScale(r) };
        return { signal: { type: 'rating', rating_value: r.value, rating_best: r.best, rating_worst: r.worst, rating_count: 1, trust }, note: null };
    }
    return { signal: null, note: `items of kind "${item.kind}" carry no review signal` };
}

/** Identifiers of an item for resolution: [{ type, value }] strongest first, then name candidates. */
function identifiers(item) {
    const f = keptFields(item);
    const strong = [{ type: 'source', value: item.source_key }];
    if (item.canonical_url) strong.push({ type: 'url', value: item.canonical_url });
    if (f.gtin) strong.push({ type: 'gtin', value: f.gtin });
    if (f.sku) strong.push({ type: 'sku', value: f.sku });
    if (f.mpn) strong.push({ type: 'mpn', value: f.mpn });
    const names = [];
    if (item.kind === 'product' && item.title) names.push(item.title);
    if (f.item_reviewed) names.push(f.item_reviewed);
    return { strong, names };
}

module.exports = { extractSignal, keptFields, keptTitle, identifiers, TRUST_FIELDS };
