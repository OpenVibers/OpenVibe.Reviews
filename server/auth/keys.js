'use strict';
/**
 * The Network's RS256 public key, used to verify user JWTs (SSO) and service tokens offline.
 * Pinned with OV_NETWORK_PUBLIC_KEY, or fetched from <network>/api/.well-known/jwks (internal URL
 * first) and retried at most every 30 s until it loads. Without it nobody can sign in or call the
 * API with a token; public pages keep working.
 */
function createKeyStore({ config, fetchImpl = globalThis.fetch, log = console, publicKey = null } = {}) {
    let key = publicKey || config.networkPublicKey || null;
    let lastFetch = 0;
    let inflight = null;

    async function fetchKey() {
        for (const base of [config.networkInternalUrl, config.networkUrl]) {
            if (!base) continue;
            try {
                const res = await fetchImpl(`${base}/api/.well-known/jwks`, { signal: AbortSignal.timeout(5000) });
                if (!res.ok) continue;
                const jwks = await res.json();
                if (jwks && typeof jwks.public_key === 'string' && jwks.public_key.includes('BEGIN')) {
                    key = jwks.public_key;
                    log.log(`[Reviews] Network public key loaded from ${base}`);
                    return key;
                }
            } catch (err) {
                log.warn(`[Reviews] JWKS fetch failed from ${base}: ${err.message}`);
            }
        }
        return null;
    }

    return {
        get() { return key; },
        loaded() { return !!key; },
        async ensure() {
            if (key) return key;
            if (inflight) return inflight;
            if (Date.now() - lastFetch < 30000) return null;
            lastFetch = Date.now();
            inflight = fetchKey().finally(() => { inflight = null; });
            return inflight;
        },
    };
}

module.exports = { createKeyStore };
