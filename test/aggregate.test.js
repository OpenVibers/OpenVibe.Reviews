'use strict';
/**
 * The aggregate as a pure function: absent (null) without qualifying signals, every input and
 * exclusion exposed, deterministic, and never a default.
 */
const assert = require('assert');
const { computeAggregate, ratingForStructuredData, hashOf } = require('../server/reviews/aggregate');
const { extractSignal } = require('../server/reviews/extract');
const { suite } = require('./helpers');

const t = suite('aggregate');
let n = 0;
const sig = (o) => ({ id: `sig_${String(++n).padStart(26, '0')}`, status: 'active', source_key: 'src-a', source_item_id: `itm_${n}`, entity_id: 'ent_1', observed_at: `2026-09-20T10:00:${String(n % 60).padStart(2, '0')}.000Z`, ...o });

t('no signals → null, not zero', () => {
    assert.strictEqual(computeAggregate([]), null);
    assert.strictEqual(ratingForStructuredData(null), null);
    assert.strictEqual(ratingForStructuredData(computeAggregate([])), null);
});

t('only inactive or excluded signals → null', () => {
    const a = sig({ type: 'recommendation', recommended: 1, status: 'withdrawn' });
    const b = sig({ type: 'recommendation', recommended: 1 });
    assert.strictEqual(computeAggregate([a]), null);
    assert.strictEqual(computeAggregate([b], { exclusions: { sources: new Map([['src-a', 'bought reviews']]), signals: new Map() } }), null);
});

t('a rating without a stated scale is left out with a reason; alone it yields no aggregate', () => {
    const r = sig({ type: 'rating_aggregate', rating_value: 4.2, rating_best: null, rating_count: 50 });
    assert.strictEqual(computeAggregate([r]), null);
    const ok = sig({ type: 'recommendation', recommended: 0 });
    const out = computeAggregate([r, ok]);
    assert.deepStrictEqual(out.excluded.map((x) => [x.signal_id, x.reason]), [[r.id, 'scale_not_stated']]);
    assert.ok(!out.components.rating);
});

t('recommendation share from single recommendations; inputs and computation exposed', () => {
    const list = [1, 1, 1, 0].map((v) => sig({ type: 'recommendation', recommended: v }));
    const out = computeAggregate(list);
    assert.deepStrictEqual({ positive: out.components.recommendation.positive, total: out.components.recommendation.total, percent: out.components.recommendation.percent }, { positive: 3, total: 4, percent: 75 });
    assert.strictEqual(out.inputs.length, 4);
    assert.ok(out.inputs.every((i) => i.signal_id && i.source_item_id && i.observed_at && i.source_key));
    assert.ok(out.computation[0].includes('3 of 4'));
    assert.deepStrictEqual(ratingForStructuredData(out), { value: 75, best: 100, worst: 0, count: 4 });
});

t('a source tally covers that source\'s single recommendations (no double counting)', () => {
    const singles = [1, 0].map((v) => sig({ type: 'recommendation', recommended: v, source_key: 'steam' }));
    const tally = sig({ type: 'recommendation_tally', positive_count: 900, total_count: 1000, source_key: 'steam' });
    const other = sig({ type: 'recommendation', recommended: 1, source_key: 'other' });
    const out = computeAggregate([...singles, tally, other]);
    assert.strictEqual(out.components.recommendation.positive, 901);
    assert.strictEqual(out.components.recommendation.total, 1001);
    assert.deepStrictEqual(out.excluded.map((x) => x.reason).sort(), ['covered_by_source_tally', 'covered_by_source_tally']);
});

t('ratings: count-weighted, on the shared scale when there is one, percentage otherwise', () => {
    const a = sig({ type: 'rating_aggregate', rating_value: 4, rating_best: 5, rating_count: 100 });
    const b = sig({ type: 'rating', rating_value: 5, rating_best: 5, rating_count: 1 });
    const out = computeAggregate([a, b]);
    assert.strictEqual(out.components.rating.count, 101);
    assert.strictEqual(out.components.rating.on_scale.best, 5);
    assert.strictEqual(out.components.rating.on_scale.value, Math.round(((4 * 100 + 5) / 101) * 100) / 100);
    assert.deepStrictEqual(ratingForStructuredData(out), { value: out.components.rating.on_scale.value, best: 5, worst: undefined, count: 101 });
    const c = sig({ type: 'rating_aggregate', rating_value: 8, rating_best: 10, rating_count: 99 });
    const mixed = computeAggregate([a, c]);
    assert.strictEqual(mixed.components.rating.on_scale, undefined);
    assert.strictEqual(mixed.components.rating.percent, 80);
    assert.deepStrictEqual(ratingForStructuredData(mixed), { value: 80, best: 100, worst: 0, count: 199 });
});

t('deterministic: same signals in any order → same result and hash', () => {
    const list = [sig({ type: 'recommendation', recommended: 1 }), sig({ type: 'rating', rating_value: 3, rating_best: 5, rating_count: 1 }), sig({ type: 'recommendation', recommended: 0 })];
    const a = computeAggregate(list);
    const b = computeAggregate([...list].reverse());
    assert.deepStrictEqual(a, b);
    assert.strictEqual(hashOf(a), hashOf(b));
    assert.notStrictEqual(hashOf(a), hashOf(null));
});

t('extraction states only what the source stated', () => {
    assert.deepStrictEqual(extractSignal({ kind: 'review_signal', fields: { voted_up: true, steam_purchase: true } }).signal, { type: 'recommendation', recommended: 1, trust: { steam_purchase: true } });
    assert.strictEqual(extractSignal({ kind: 'review_signal', fields: {} }).signal, null);
    assert.strictEqual(extractSignal({ kind: 'product', fields: { aggregate_rating: { value: 4.5, best: 5 } } }).signal, null, 'no count → no signal');
    assert.strictEqual(extractSignal({ kind: 'product', fields: { aggregate_rating: { value: 6, best: 5, count: 3 } } }).signal, null, 'outside the scale');
    assert.strictEqual(extractSignal({ kind: 'product', fields: { aggregate_rating: { value: 4.5, count: 3 } } }).signal.rating_best, null, 'unstated scale stays null');
    assert.strictEqual(extractSignal({ kind: 'article', fields: { rating: 5 } }).signal, null);
});
