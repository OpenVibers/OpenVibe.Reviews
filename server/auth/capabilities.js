'use strict';
/**
 * Capability checks for service tokens, including the reviews.* ids this service introduces before
 * the contracts library knows them (proposed in docs/capabilities-proposal/).
 *
 * openvibe-contracts' capabilities.check() answers capability.unknown for an id that is not in its
 * manifests yet. Until a release defines them, a grant of a proposed id is decided locally with the
 * library's own matching rule (the exact id, or a `prefix.*` grant covering it). An id the library
 * knows always goes through the library, so the day the release lands nothing changes here.
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
const PROPOSED = new Set(Object.values(CAPS));

/** → { allowed, code, reason } like capabilities.check(). */
function checkCapability(claims, capabilityId) {
    if (!capabilities.get(capabilityId) && PROPOSED.has(capabilityId)) {
        return capabilities.grants(claims && claims.cap, capabilityId)
            ? { allowed: true, code: null, reason: null }
            : { allowed: false, code: 'capability.denied', reason: `${capabilityId} not granted` };
    }
    return capabilities.check(claims, capabilityId);
}

module.exports = { checkCapability, CAPS, PROPOSED };
