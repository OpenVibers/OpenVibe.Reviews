'use strict';
/**
 * Per-actor rate limits on /api/v1 and on the forms (roadmap WS-R task 4; openvibe-sdk/limits).
 *
 * The per-address limits in app.js (every /api/ call, corrections, form posts, sign-in) stay. These
 * count requests by who makes them, once req.actor is resolved (auth/viewer.js):
 *
 *   a person                        user:usr_… (their own token or cookie, or named by a first-party
 *                                   service in X-OV-Subject, or an app's on_behalf_of)
 *   a service or app acting as      its principal (svc:ai, app:app_…): an AI workflow's summary
 *     itself                        proposals, an import service
 *   a signed-out caller             ip:<address> (writes only)
 *
 * Reads (GET/HEAD, and POST /resolve, which only looks up) take REVIEWS_LIMITS_MINUTE /
 * REVIEWS_LIMITS_HOUR, 120 and 3000, for a person or an app. Signed-out reads keep only the
 * per-address limit (many readers share a carrier or campus address), and a first-party service
 * reading for itself is not counted on reads (its pages speak for all its visitors; the per-address
 * /api/ limit bounds it). Every write has its own budget below, shared by the API route and the form
 * that do the same thing; a form counts only a signed-in person (a signed-out post gets the sign-in
 * page and does no work). Past a limit the route answers 429 problem+json `rate_limited` with
 * Retry-After before any work (for a form, before its body is read); the refusal is logged once and
 * counted in reviews_rate_limited_total{limit,window}. Counters live in this process: a restart
 * forgets them.
 *
 * Never limited: /api/health, /api/ready, /release.json, /metrics, sign-in, the pages people read,
 * and the signed Events deliveries at /internal/events.
 */
const { createActorLimiter, createValkeyLimitStore, defaultActor } = require('openvibe-sdk/limits');

const FIRST_PARTY = /^svc:/;

function actor(req) {
    const a = req.actor;
    if (!a || a.kind === 'anonymous') return defaultActor(req);
    if (a.subject) return `user:${a.subject}`;
    if (a.kind === 'service' && a.service) return a.service;
    return defaultActor(req);
}

/** Counted on reads: a signed-in person, or a service or app acting for a person or as a third party. */
function countedRead(req) {
    const a = req.actor;
    if (!a || a.kind === 'anonymous') return false;
    if (a.kind === 'service' && !a.subject && FIRST_PARTY.test(String(a.service))) return false;
    return true;
}

/**
 * The writes, each with its numbers per caller (a minute, an hour). A form and the API route that do
 * the same thing share one budget.
 */
const BUDGETS = {
    // Creating, editing and deleting an entity, its aliases, links and trust settings: an editor saves
    // a form every few seconds at most. Each change can move signals and emit an event.
    'reviews.entity.manage': { minute: 30, hour: 300 },
    // A merge or split moves every signal between two entities and recomputes both aggregates.
    'reviews.entity.merge': { minute: 10, hour: 100 },
    // An editor works through the resolution queue one item at a time: one a second at most.
    'reviews.item.resolve': { minute: 60, hour: 1200 },
    // Importing one item asks OpenVibe.Sources for it: a granted service or editor, one a second.
    'reviews.signal.import': { minute: 60, hour: 1200 },
    // A sync pulls the next pages of review items from Sources and drains the import queue: the
    // worker already does it on a schedule, so a person's button is a rare nudge.
    'reviews.sources.sync': { minute: 2, hour: 20 },
    // Writing, reviewing, publishing and unpublishing a summary changes what readers, feeds, sitemaps
    // and Search see, and emits an event each.
    'reviews.summary.publish': { minute: 30, hour: 300 },
    // An AI workflow proposes one summary per entity it worked on: one a second at most.
    'reviews.summary.propose': { minute: 60, hour: 1200 },
    // A correction goes to the editors' queue from a person: a few at a time (the per-address limit
    // allows 20 an hour).
    'reviews.correction.submit': { minute: 5, hour: 20 },
    // Answering corrections: an editor works through the queue.
    'reviews.correction.resolve': { minute: 30, hour: 300 },
    // A discussion comment goes to OpenVibe.Community in the person's name (Community allows 20 a minute).
    'reviews.discussion.comment': { minute: 20, hour: 300 },
};

/**
 * limits(name, own) middleware for one app, plus limits.reads(name) (the defaults on a counted
 * GET/HEAD), limits.lookup(name) (the defaults on a counted read of any method), limits.budget(name)
 * (one of BUDGETS) and limits.form(name) (a budget counted for a signed-in person).
 * enabled=false (createApp's rateLimits=false, tests only) counts nobody, as it turns off the
 * per-address limits.
 */
function createActorLimits({ config, now = () => Date.now(), registry = null, log = console, enabled = true, valkey = null }) {
    const refused = registry
        ? registry.counter({ name: 'reviews_rate_limited_total', help: 'Requests refused 429 by a per-actor limit, by limit name and window', labelNames: ['limit', 'window'] })
        : null;
    const limiter = createActorLimiter({
        limits: { minute: config.limits.minute, hour: config.limits.hour },
        actor: enabled ? actor : () => null,
        now,
        // Shared across processes on Valkey (ADR-035) when VALKEY_URL is set; in-process otherwise.
        ...(valkey ? { store: createValkeyLimitStore(valkey) } : {}),
        onLimited(e) {
            // The actor is a subject id, a principal or an address, never a token.
            log.warn(`[Limits] ${e.name}: ${e.actor} refused, over ${e.limit} per ${e.window}`);
            if (refused) refused.inc({ limit: e.name, window: e.window });
        },
    });
    limiter.reads = (name) => {
        const limit = limiter(name);
        return (req, res, next) => ((req.method === 'GET' || req.method === 'HEAD') && countedRead(req) ? limit(req, res, next) : next());
    };
    limiter.lookup = (name) => {
        const limit = limiter(name);
        return (req, res, next) => (countedRead(req) ? limit(req, res, next) : next());
    };
    const budgets = new Map(Object.entries(BUDGETS).map(([name, own]) => [name, limiter(name, own)]));
    limiter.budget = (name) => {
        const m = budgets.get(name);
        if (!m) throw new Error(`limits: no budget named ${name}`);
        return m;
    };
    limiter.form = (name) => {
        const m = limiter.budget(name);
        return (req, res, next) => (req.actor && req.actor.subject ? m(req, res, next) : next());
    };
    return limiter;
}

module.exports = { createActorLimits, actor, countedRead, BUDGETS };
