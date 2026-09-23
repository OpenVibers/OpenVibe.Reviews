'use strict';
/**
 * Shared HTTP helpers: the actor middleware, capability guards and error mapping.
 */
const contracts = require('openvibe-contracts');
const { checkCapability } = require('../auth/capabilities');
const { AuthError } = require('../auth/viewer');

const { http } = contracts;

/** Resolves req.actor. Pages pass { services: false }: pages are for browsers. */
function actorMiddleware(viewers, opts = {}) {
    return async (req, res, next) => {
        try {
            req.actor = await viewers.resolve(req, opts);
            next();
        } catch (err) {
            if (!(err instanceof AuthError)) return next(err);
            http.sendProblem(res, err.status, err.code, { detail: err.message, ctx: req.ov });
        }
    };
}

/**
 * One capability per route for service tokens. People (user JWTs) and anonymous callers pass here
 * and are judged by the editorial rules in the service.
 */
function guard(capabilityId) {
    return function reviewsCapabilityGuard(req, res, next) {
        const a = req.actor;
        if (!a || a.kind !== 'service') return next();
        const c = checkCapability(a.claims, capabilityId);
        if (c.allowed) return next();
        return http.sendProblem(res, 403, c.code, { detail: c.reason, ctx: req.ov });
    };
}

/** Service errors → problem+json. */
function sendError(res, req, err, log = console) {
    const status = err && Number.isInteger(err.status) ? err.status : 500;
    if (status >= 500 && status !== 503) log.error('[Reviews]', err && err.stack ? err.stack : err);
    const code = (err && err.code) || (status === 500 ? 'internal.error' : 'request.invalid');
    const detail = status === 500 ? 'Internal error' : (err && err.message) || undefined;
    return http.sendProblem(res, status, code, { detail, ctx: req.ov, extra: err && err.extra ? err.extra : undefined });
}

function run(fn, status = 200, log = console) {
    return async (req, res) => {
        try {
            const out = await fn(req, res);
            if (res.headersSent) return;
            res.status(typeof status === 'function' ? status(out) : status).set('Cache-Control', 'private, no-store').json(out);
        } catch (err) {
            sendError(res, req, err, log);
        }
    };
}

module.exports = { actorMiddleware, guard, sendError, run };
