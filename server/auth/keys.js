'use strict';
// openvibe-sdk/site (0.174.0) is the one implementation every site shares (the consolidation of 2026-11-16).
// The Network's signing key; this file stays for one release so nothing that requires it changes.
// A hand merge: this site's store answered ensure() with the PEM and let a pinned key (OV_NETWORK_PUBLIC_KEY, or the
// publicKey option the tests use) win over the JWKS. Both stay; the JWKS itself is now the SDK's client (rotations,
// the last good keys through an outage, backoff), where this copy fetched one PEM and retried every 30 s.
const site = require('openvibe-sdk/site');

function createKeyStore({ config = {}, fetchImpl, log, publicKey = null } = {}) {
    const pinned = publicKey || (config && config.networkPublicKey) || null;
    if (pinned) return { get: () => pinned, loaded: () => true, ensure: async () => pinned, pemForToken: async () => pinned };
    const store = site.createKeyStore({ name: 'OpenVibe.Reviews', config, ...(fetchImpl ? { fetchImpl } : {}), ...(log ? { log } : {}) });
    return { ...store, async ensure() { await store.ensure(); return store.get(); } };
}

module.exports = { createKeyStore, jwksUrl: site.jwksUrl };
