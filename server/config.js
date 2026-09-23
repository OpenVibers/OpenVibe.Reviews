'use strict';
/**
 * OpenVibe.Reviews configuration. load(env) is pure so tests build their own config; the process
 * entry calls load() with process.env after dotenv.
 */

function list(value, fallback) {
    return String(value == null || value === '' ? fallback : value).split(',').map((s) => s.trim()).filter(Boolean);
}
const trim = (u) => String(u || '').replace(/\/+$/, '');
const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const bool = (v, d) => (v == null || v === '' ? d : v === 'true' || v === '1');

function load(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';
    const isProduction = nodeEnv === 'production';
    const port = int(env.PORT, 4830);
    const baseUrl = trim(env.BASE_URL || (isProduction ? 'https://openvibe.reviews' : `http://localhost:${port}`));
    const networkUrl = trim(env.OV_NETWORK_URL || 'https://openvibe.network');
    return {
        serviceId: 'reviews',
        nodeEnv,
        isProduction,
        port,
        host: env.HOST || '127.0.0.1',
        baseUrl,
        trustProxy: env.TRUST_PROXY != null && env.TRUST_PROXY !== '' ? Number(env.TRUST_PROXY) : 2,
        dbPath: env.REVIEWS_DB_PATH || './data/reviews.db',

        // Identity: OpenVibe.Network signs user JWTs (SSO) and service tokens (client credentials).
        networkUrl,
        networkInternalUrl: trim(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'),
        networkIssuer: trim(env.OV_NETWORK_ISSUER || networkUrl),
        networkPublicKey: env.OV_NETWORK_PUBLIC_KEY ? String(env.OV_NETWORK_PUBLIC_KEY).replace(/\\n/g, '\n') : null,
        userAudiences: list(env.REVIEWS_USER_AUDIENCES, 'openvibe.reviews,openvibe.network'),
        audience: 'openvibe.reviews',

        // Editors: Network staff (admin, global_mod) plus these usr_ subjects.
        editors: list(env.REVIEWS_EDITORS, ''),

        // OAuth client `reviews` (browser sign-in) and service principal `svc:reviews` (same credentials).
        oauth: {
            clientId: env.OV_OAUTH_CLIENT_ID || 'reviews',
            clientSecret: env.OV_OAUTH_CLIENT_SECRET || '',
            redirectUri: env.OV_OAUTH_REDIRECT_URI || `${baseUrl}/auth/callback`,
            scope: 'profile theme',
        },
        cookies: { secure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProduction },

        // Other services (all optional: each integration degrades to an explicit failure state).
        eventsUrl: trim(env.EVENTS_URL || ''),
        eventsRelayIntervalMs: int(env.EVENTS_RELAY_INTERVAL_MS, 2000),
        // HMAC secrets of Reviews' OpenVibe.Events subscription (sources.item.*); comma-separated for rotation.
        eventsWebhookSecrets: list(env.REVIEWS_EVENTS_SECRET, ''),
        communityUrl: trim(env.OV_COMMUNITY_URL || 'https://openvibe.community'),
        communityInternalUrl: trim(env.OV_COMMUNITY_INTERNAL_URL || ''),
        sourcesInternalUrl: trim(env.OV_SOURCES_INTERNAL_URL || ''),

        // Pulling review items from OpenVibe.Sources (sources.item.read) in change order.
        sync: {
            enabled: bool(env.REVIEWS_SOURCES_SYNC, true),
            intervalMs: int(env.REVIEWS_SOURCES_SYNC_INTERVAL_MS, 5 * 60 * 1000),
            pageSize: Math.min(500, Math.max(1, int(env.REVIEWS_SOURCES_PAGE_SIZE, 200))),
            queueIntervalMs: int(env.REVIEWS_IMPORT_QUEUE_INTERVAL_MS, 15000),
        },

        // The indexability gate policy for entity pages (openvibe-publishing/seo).
        gate: {
            minWords: int(env.REVIEWS_GATE_MIN_WORDS, 60),
            requireSources: true,
            minSources: Math.max(1, int(env.REVIEWS_GATE_MIN_SIGNALS, 1)),
        },
    };
}

module.exports = { load };
