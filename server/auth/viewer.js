'use strict';
/**
 * Who is calling — resolved once per request into `req.actor` (see server/reviews/access.js):
 *
 *   { kind: 'anonymous', subject: null }
 *   { kind: 'user', subject: 'usr_…'|null, staff, user }
 *       A browser or client with the Network user JWT (ov_token cookie or Bearer), verified offline
 *       (RS256, issuer, audience). staff = the contracts staff map's staff.editorial.manage (ADR-022).
 *   { kind: 'service', service: 'svc:x', claims, subject }
 *       A Network client-credentials token for audience openvibe.reviews. It names the person it acts
 *       for in X-OV-Subject (usr_…); every route checks one capability against the token.
 *       Developer-app (app:…) and module (mod:…) tokens act only for the person in their
 *       on_behalf_of claim: X-OV-Subject naming anyone else is 403, and sandbox tokens are 401.
 *
 * Identity never comes from a body or a query. A request that presents a service token is judged
 * on that token alone: a bad one is refused, never downgraded to anonymous.
 */
const contracts = require('openvibe-contracts');
const { verifyUserToken } = require('openvibe-sdk/auth');

const { ids, serviceAuth, staff: staffMap } = contracts;
const PRINCIPAL_SUB = /^(svc|app|mod):/;
const ACCESS_COOKIE = 'ov_token';

class AuthError extends Error {
    constructor(status, code, detail) { super(detail); this.status = status; this.code = code; }
}

const ANONYMOUS = Object.freeze({ kind: 'anonymous', subject: null, staff: false });

function decodePayload(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
}

function bearer(req) {
    const h = String(req.headers.authorization || '');
    return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

function createViewerResolver({ keys, config }) {
    async function fromServiceToken(req, token) {
        const publicKey = await keys.ensure();
        if (!publicKey) throw new AuthError(503, 'identity.unavailable', 'the Network signing key is not loaded yet');
        const r = serviceAuth.verifyServiceToken(token, { publicKey, issuer: config.networkIssuer, audience: config.audience });
        if (!r.ok) throw new AuthError(401, r.code, r.reason);
        // Developer apps (app:…) and modules (mod:…) are third parties: they act only for the person
        // who authorized them (on_behalf_of), never for whoever X-OV-Subject names. Only first-party
        // service principals (svc:…) are trusted to name the acting person.
        const claims = r.claims;
        const firstParty = claims.actor_type === 'service' && String(claims.sub).startsWith('svc:');
        if (!firstParty && claims.env !== undefined && claims.env !== 'production') {
            throw new AuthError(401, 'token.sandbox_refused', 'sandbox tokens are not accepted by openvibe.reviews');
        }
        const header = req.get('x-ov-subject');
        let subject = null;
        if (header) {
            if (!ids.isSubjectId('user', header)) throw new AuthError(400, 'subject.invalid', 'X-OV-Subject must be a usr_… subject id');
            if (!firstParty && header !== claims.on_behalf_of) {
                throw new AuthError(403, 'subject.not_delegated', 'an app acts only for the person who authorized it (on_behalf_of)');
            }
            subject = header;
        } else if (!firstParty && ids.isSubjectId('user', claims.on_behalf_of)) {
            subject = claims.on_behalf_of;
        }
        return { kind: 'service', service: claims.sub, claims, subject, staff: false };
    }

    async function fromUserToken(token, { strict }) {
        const publicKey = await keys.ensure();
        if (!publicKey) {
            if (strict) throw new AuthError(503, 'identity.unavailable', 'the Network signing key is not loaded yet');
            return null;
        }
        let claims;
        try {
            claims = await verifyUserToken(token, { publicKey, issuer: config.networkIssuer, audience: config.userAudiences });
        } catch (err) {
            if (strict) throw new AuthError(401, err.code || 'token.invalid', err.message);
            return null;
        }
        const subject = ids.isSubjectId('user', claims.subject_id) ? claims.subject_id : null;
        return {
            kind: 'user', subject, staff: staffMap.can(claims, 'staff.editorial.manage'),
            user: { username: claims.username || null, display_name: claims.display_name || claims.username || null, avatar_url: claims.avatar_url || null, role: claims.role || null, subject_id: subject },
        };
    }

    /**
     * opts.services=false (server-rendered pages): a service token is no identity at all.
     * A Bearer user token is strict (a bad one is 401); the cookie is lenient (expired = signed out).
     */
    async function resolve(req, opts = {}) {
        const token = bearer(req);
        if (token) {
            const payload = decodePayload(token);
            if (payload && typeof payload.sub === 'string' && PRINCIPAL_SUB.test(payload.sub)) {
                if (opts.services === false) return ANONYMOUS;
                return fromServiceToken(req, token);
            }
            return (await fromUserToken(token, { strict: true })) || ANONYMOUS;
        }
        const cookie = req.cookies && req.cookies[ACCESS_COOKIE];
        if (!cookie) return ANONYMOUS;
        return (await fromUserToken(cookie, { strict: false })) || ANONYMOUS;
    }

    return { resolve };
}

module.exports = { createViewerResolver, AuthError, ANONYMOUS, ACCESS_COOKIE };
