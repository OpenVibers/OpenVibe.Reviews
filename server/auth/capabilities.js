'use strict';
/**
 * Capability checks for service tokens. The reviews.* ids this service introduces are defined by the
 * installed openvibe-contracts, so a grant is decided by the library's own matching rule (the exact
 * id, or a `prefix.*` grant covering it). CAPS keeps the ids in one place for the guards, the
 * proposal documents and the tests.
 */
const { capabilities } = require('openvibe-contracts');

const CAPS = Object.freeze({
    ENTITY_RESOLVE: 'reviews.entity.resolve',
    ENTITY_MANAGE: 'reviews.entity.manage',
    ENTITY_MERGE: 'reviews.entity.merge',
    ENTITY_SPLIT: 'reviews.entity.split',
    SIGNAL_IMPORT: 'reviews.signal.import',
    SUMMARY_PROPOSE: 'reviews.summary.propose',
    SUMMARY_PUBLISH: 'reviews.summary.publish',
    CORRECTION_SUBMIT: 'reviews.correction.submit',
});

/** → { allowed, code, reason } like capabilities.check(). */
function checkCapability(claims, capabilityId) {
    return capabilities.check(claims, capabilityId);
}

module.exports = { checkCapability, CAPS };
