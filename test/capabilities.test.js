'use strict';
/**
 * The reviews.* capabilities are released by openvibe-contracts, so the service guards delegate to
 * the library's grant rule rather than deciding a proposed id locally (the fallback that existed
 * while the ids were only proposals). These pin that: every guarded id is defined by the installed
 * contracts and by the reviews service manifest, and checkCapability agrees with capabilities.check
 * for an exact grant, a prefix grant, no grant, and an id the contracts do not define.
 */
const assert = require('assert');
const { capabilities, services } = require('openvibe-contracts');
const { checkCapability, CAPS } = require('../server/auth/capabilities');
const { suite } = require('./helpers');

const t = suite('capabilities');
const GRANTED = { cap: ['reviews.signal.import'], sub: 'svc:sources' };

t('every guarded capability is defined by the installed contracts and the reviews manifest', () => {
    const manifest = services.get('reviews');
    assert.ok(manifest, 'openvibe-contracts defines the reviews service manifest');
    assert.deepStrictEqual([...manifest.capabilities].sort(), Object.values(CAPS).sort());
    for (const id of Object.values(CAPS)) {
        const cap = capabilities.get(id);
        assert.ok(cap, `${id} is defined by openvibe-contracts`);
        assert.strictEqual(cap.owner, 'reviews', `${id} is owned by reviews`);
    }
});

t('checkCapability follows the contracts grant rule (exact, prefix, denied, unknown)', () => {
    // An exact grant and a `prefix.*` grant the library's matching rule accepts.
    assert.deepStrictEqual(checkCapability(GRANTED, 'reviews.signal.import'), { allowed: true, code: null, reason: null });
    assert.deepStrictEqual(checkCapability({ cap: ['reviews.*'] }, 'reviews.signal.import'), { allowed: true, code: null, reason: null });
    // A grant of a sibling capability, or no cap at all, is denied with the library's code.
    assert.strictEqual(checkCapability({ cap: ['reviews.entity.resolve'] }, 'reviews.signal.import').code, 'capability.denied');
    assert.strictEqual(checkCapability(null, 'reviews.signal.import').code, 'capability.denied');
    // An id the contracts do not define still answers capability.unknown — the guard delegates,
    // it never decides an unknown id on its own.
    assert.strictEqual(checkCapability({ cap: ['reviews.*'] }, 'reviews.not.a.capability').code, 'capability.unknown');
});
