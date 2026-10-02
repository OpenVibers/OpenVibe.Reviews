'use strict';
/**
 * Shared HTTP helpers: the actor middleware, capability guards and error mapping.
 */
const contracts = require('openvibe-contracts');
const svc = require('openvibe-sdk/service');
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

/**
 * A write another site started (CSRF), judged from what the browser says: Sec-Fetch-Site other than
 * same-origin (or none: typed by the person), or an Origin other than ours. `Origin: null` alone is
 * not proof (privacy settings send it for same-origin posts); a browser that sends Sec-Fetch-Site
 * says what it really was.
 */
function crossSite(req, origin) {
    const site = req.get('sec-fetch-site');
    if (site && site !== 'same-origin' && site !== 'none') return true;
    const o = req.get('origin');
    return !!(o && o !== 'null' && o !== origin);
}

/**
 * Service errors → problem+json (openvibe-sdk/service, plan T1): the kit's defaults are this module's —
 * the error's status/code/detail, `extra` spread into the body, 'internal.error'/'Internal error' at 500,
 * 'request.invalid' otherwise, and only 5xx (apart from 503) logged, under `[Reviews]`. Kept as a named export
 * so no call site moves.
 */
function sendError(res, req, err, log = console) {
    return svc.sendError(res, req, err, log, { name: 'Reviews' });
}

/** A JSON handler: its return value is the body, answers `private, no-store`, errors through sendError. */
function run(fn, status = 200, log = console) {
    return svc.run(fn, status, { name: 'Reviews', log, noStore: true });
}

module.exports = { actorMiddleware, guard, sendError, run, crossSite };
