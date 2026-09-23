'use strict';
/**
 * Third-party principals: a developer app (app:…) or module (mod:…) token acts only for the person
 * in its on_behalf_of claim. X-OV-Subject naming anyone else (here: a Reviews editor) is refused
 * (403 subject.not_delegated), and so are sandbox tokens (401 token.sandbox_refused). First-party
 * services (svc:…) still name the person they act for.
 */
const assert = require('assert');
const { boot, req, suite, serviceToken, subject, EDITOR, READER } = require('./helpers');

const t = suite('delegation');
const APP = 'app:app_01J8ZQ4Y7N3M2K1H0G9F8E7D6C';
const MOD = 'mod:mod_01J8ZQ4Y7N3M2K1H0G9F8E7D6C';
const CAPS = ['reviews.entity.manage'];
const token = (sub, actorType, extra) => serviceToken({ sub, actorType, cap: CAPS, extra });
const entity = (name) => ({ name, kind: 'product' });
const count = (h, name) => h.db.prepare('SELECT COUNT(*) AS n FROM review_entities WHERE name = ?').get(name).n;

t('an app or module cannot act as an editor by naming them in X-OV-Subject', async () => {
    const h = await boot();
    try {
        for (const [sub, type] of [[APP, 'app'], [MOD, 'mod']]) {
            for (const extra of [{ on_behalf_of: READER }, {}]) {
                const r = await req(h, 'POST', '/api/v1/entities', { token: token(sub, type, extra), headers: { 'X-OV-Subject': EDITOR }, body: entity(`Planted by ${type}`) });
                assert.strictEqual(r.status, 403, `${type} ${JSON.stringify(extra)}: ${r.text}`);
                assert.strictEqual(r.json.code, 'subject.not_delegated');
                assert.strictEqual(count(h, `Planted by ${type}`), 0);
            }
        }
    } finally { await h.stop(); }
});

t('an app acts for its on_behalf_of person, with that person\'s rights', async () => {
    const h = await boot();
    try {
        let r = await req(h, 'POST', '/api/v1/entities', { token: token(APP, 'app', { on_behalf_of: READER }), body: entity('Reader attempt') });
        assert.strictEqual(r.status, 403, r.text);
        assert.strictEqual(r.json.code, 'reviews.editor_required', 'acts as the reader, who is no editor');
        r = await req(h, 'POST', '/api/v1/entities', { token: token(APP, 'app', { on_behalf_of: EDITOR }), headers: { 'X-OV-Subject': EDITOR }, body: entity('Editor via app') });
        assert.strictEqual(r.status, 201, r.text);
    } finally { await h.stop(); }
});

t('sandbox app tokens are refused; first-party services still name the person', async () => {
    const h = await boot();
    try {
        let r = await req(h, 'POST', '/api/v1/entities', { token: token(APP, 'app', { on_behalf_of: EDITOR, env: 'sandbox' }), body: entity('Sandbox') });
        assert.strictEqual(r.status, 401, r.text);
        assert.strictEqual(r.json.code, 'token.sandbox_refused');
        r = await req(h, 'POST', '/api/v1/entities', { token: serviceToken({ client: 'tools', cap: CAPS }), headers: { 'X-OV-Subject': EDITOR }, body: entity('Editor via svc') });
        assert.strictEqual(r.status, 201, r.text);
        r = await req(h, 'POST', '/api/v1/entities', { token: serviceToken({ client: 'tools', cap: CAPS }), headers: { 'X-OV-Subject': subject() }, body: entity('Stranger via svc') });
        assert.strictEqual(r.status, 403, 'a first-party service acting for a non-editor is no editor');
    } finally { await h.stop(); }
});
