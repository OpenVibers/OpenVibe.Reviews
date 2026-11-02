'use strict';
/**
 * The home's figures are kept (server/reviews/home.js remember): within cacheMs the kept answer, past it the kept
 * answer at once while one refresh runs, and past an hour a fresh answer is waited for. Off (cacheMs 0) outside
 * production, so a test that writes and reads the home sees its own writes.
 *
 *   node test/home-cache.test.js
 */
const assert = require('assert');
const { remember } = require('../server/reviews/home');
const { load } = require('../server/config');

(async () => {
    let t = 0;
    let calls = 0;
    let release = null;
    const slow = async (n) => { calls += 1; if (release === 'hold') await new Promise((r) => { release = r; }); return { n, call: calls }; };
    const kept = remember(slow, { cacheMs: 300_000, now: () => t });

    assert.deepStrictEqual(await kept(8), { n: 8, call: 1 }, 'the first answer is waited for');
    t = 60_000;
    assert.deepStrictEqual(await kept(8), { n: 8, call: 1 }, 'within five minutes: kept');
    assert.deepStrictEqual(await kept(6), { n: 6, call: 2 }, 'another argument list is its own entry');

    t = 400_000;
    release = 'hold';
    const stale = await kept(8);
    assert.deepStrictEqual(stale, { n: 8, call: 1 }, 'past five minutes: the kept answer at once');
    await kept(8);
    assert.strictEqual(calls, 3, 'one refresh runs, not one per request');
    release();
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(await kept(8), { n: 8, call: 3 }, 'then the refreshed answer');

    t = 400_000 + 2 * 60 * 60 * 1000;
    release = null;
    assert.deepStrictEqual(await kept(8), { n: 8, call: 4 }, 'past an hour: a fresh answer is waited for');

    // A refresh that fails keeps the old answer, and the next request tries again.
    let fail = true;
    let tries = 0;
    const flaky = remember(async () => { tries += 1; if (fail && tries > 1) throw new Error('db away'); return tries; }, { cacheMs: 1000, now: () => t });
    t = 0;
    assert.strictEqual(await flaky(), 1);
    t = 5000;
    assert.strictEqual(await flaky(), 1, 'stale while the refresh fails');
    await new Promise((r) => setImmediate(r));
    fail = false;
    assert.strictEqual(await flaky(), 1, 'still the old answer, and a new refresh starts');
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(await flaky(), 3);

    // Off outside production unless set; five minutes in production.
    assert.strictEqual(remember(slow, { cacheMs: 0, now: () => t }), slow, 'cacheMs 0: the function itself');
    assert.strictEqual(load({ NODE_ENV: 'test' }).homeCacheMs, 0);
    assert.strictEqual(load({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x/y', OV_OAUTH_CLIENT_SECRET: 'x' }).homeCacheMs, 300_000);
    assert.strictEqual(load({ NODE_ENV: 'test', REVIEWS_HOME_CACHE_MS: '1000' }).homeCacheMs, 1000);
    console.log('home cache: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
