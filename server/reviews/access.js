'use strict';
/**
 * Who may do what. One place, used by the pages, the API and the service.
 *
 * Actors (server/auth/viewer.js):
 *   { kind: 'anonymous' }                                     reads public pages
 *   { kind: 'user', subject: 'usr_…'|null, staff }             Network SSO (browser or Bearer)
 *   { kind: 'service', service: 'svc:x', claims, subject }     service token; acts for X-OV-Subject if given
 *   { kind: 'system', service: 'svc:reviews' }                 this service's own workers (Sources sync)
 *
 * Editors are Network staff (admin, global_mod) and the usr_ subjects listed in REVIEWS_EDITORS.
 * A service acting for a person gets that person's rights (and must hold the route's capability);
 * staff status travels only in a person's own token, so a service acting for staff is an editor
 * only when the subject is listed in REVIEWS_EDITORS. Editorial decisions (merge, split, confirm a
 * resolution, publish a summary, exclude a signal) are always taken by a person, never a service
 * on its own and never the AI.
 */
const PERSON_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

function createAccess(config) {
    const editors = new Set((config.editors || []).filter((s) => PERSON_RE.test(s)));

    const api = {
        isPerson(actor) { return !!(actor && actor.subject && PERSON_RE.test(actor.subject)); },
        isEditor(actor) {
            if (!actor) return false;
            if (actor.kind === 'system') return true;
            if (!api.isPerson(actor)) return false;
            if (actor.kind === 'user' && actor.staff) return true;
            return editors.has(actor.subject);
        },
        /** An editor who is a person (not the system): the one who answers for an editorial decision. */
        isEditorPerson(actor) { return api.isPerson(actor) && api.isEditor(actor); },
        editorCount() { return editors.size; },
    };
    return api;
}

module.exports = { createAccess, PERSON_RE };
