'use strict';
/**
 * The sign-in (openvibe-sdk/sso): the authorize URL carries PKCE S256, the flow cookies are the ones this site
 * has always used (ov_oauth_state, ov_oauth_next, ov_oauth_silent and the PKCE verifier in ov_oauth_verifier),
 * the state is compared with the flow cookie in constant time, next is sanitized at the login and at the
 * callback, and GET /auth/health is 503 only when the Network refuses this site's OAuth client.
 */
const assert = require('assert');
const crypto = require('crypto');
const { boot, req, suite } = require('./helpers');

const t = suite('auth');

const cookies = (res) => res.headers.getSetCookie().map((c) => c.split(';')[0]);
const cookieHeader = (res) => cookies(res).join('; ');
const flow = (res, name) => res.headers.getSetCookie().find((c) => c.startsWith(name + '=')) || '';

t('the sign-in starts at the Network with PKCE S256 and the flow cookies this site has always used', async () => {
    const h = await boot();
    try {
        const res = await req(h, 'GET', '/auth/login?next=%2Fupdates');
        assert.strictEqual(res.status, 302);
        const u = new URL(res.headers.get('location'));
        assert.deepStrictEqual([u.pathname, u.searchParams.get('client_id'), u.searchParams.get('redirect_uri'), u.searchParams.get('response_type')],
            ['/oauth/authorize', 'reviews', 'http://reviews.test/auth/callback', 'code']);
        assert.strictEqual(u.searchParams.get('code_challenge_method'), 'S256', 'PKCE S256 from openvibe-sdk/sso');
        const challenge = u.searchParams.get('code_challenge');
        assert.match(challenge, /^[A-Za-z0-9_-]{43}$/, 'the code challenge');
        const state = u.searchParams.get('state');
        assert.ok(state && state.length >= 16, 'the state');
        assert.match(flow(res, 'ov_oauth_state'), new RegExp('^ov_oauth_state=' + state));
        assert.match(flow(res, 'ov_oauth_verifier'), /Path=\/auth/i, 'the verifier stays in a flow cookie of its own');
        // express encodes the cookie's value: the path arrives percent-encoded.
        const nextCookie = flow(res, 'ov_oauth_next').split(';')[0].split('=')[1];
        assert.strictEqual(decodeURIComponent(nextCookie), '/updates');
        // The challenge is the SHA-256 of the verifier in the cookie: the Network checks exactly that.
        const verifier = flow(res, 'ov_oauth_verifier').split(';')[0].split('=')[1];
        assert.strictEqual(crypto.createHash('sha256').update(verifier).digest('base64url'), challenge);
    } finally { await h.stop(); }
});

t('a callback whose state does not match the flow cookie is refused, and no session is set', async () => {
    const h = await boot();
    try {
        const started = await req(h, 'GET', '/auth/login');
        const res = await req(h, 'GET', '/auth/callback?code=whatever&state=not-the-state', { cookie: cookieHeader(started) });
        assert.strictEqual(res.status, 400);
        assert.ok(!res.headers.getSetCookie().some((c) => c.startsWith('ov_token=')), 'no session');
    } finally { await h.stop(); }
});

t('a callback without the verifier cookie is refused too (the code could not be exchanged)', async () => {
    const h = await boot();
    try {
        const started = await req(h, 'GET', '/auth/login');
        const u = new URL(started.headers.get('location'));
        const without = cookies(started).filter((c) => !c.startsWith('ov_oauth_verifier=')).join('; ');
        const res = await req(h, 'GET', '/auth/callback?code=whatever&state=' + encodeURIComponent(u.searchParams.get('state')), { cookie: without });
        assert.strictEqual(res.status, 400);
        assert.ok(!res.headers.getSetCookie().some((c) => c.startsWith('ov_token=')), 'no session');
    } finally { await h.stop(); }
});

t('a sign-in with a code the Network issued sets the session and returns to next', async () => {
    const h = await boot();
    try {
        const started = await req(h, 'GET', '/auth/login?next=%2Fupdates');
        const u = new URL(started.headers.get('location'));
        const res = await req(h, 'GET', '/auth/callback?code=code_x&state=' + encodeURIComponent(u.searchParams.get('state')), { cookie: cookieHeader(started) });
        assert.strictEqual(res.status, 302);
        assert.strictEqual(res.headers.get('location'), '/updates');
        const set = res.headers.getSetCookie();
        assert.ok(set.some((c) => c.startsWith('ov_token=')), 'the session cookie, with the name this site has always used');
        assert.ok(set.some((c) => c.startsWith('ov_refresh=')), 'the refresh cookie');
    } finally { await h.stop(); }
});

t('next is sanitized: off-site never, neither at the login nor at the callback', async () => {
    const h = await boot();
    try {
        const started = await req(h, 'GET', '/auth/login?next=https%3A%2F%2Fevil.com%2Fx');
        const offSite = flow(started, 'ov_oauth_next').split(';')[0].split('=')[1];
        assert.ok(!offSite, 'an off-site next is not kept');
        const again = await req(h, 'GET', '/auth/login');
        const u = new URL(again.headers.get('location'));
        const res = await req(h, 'GET', '/auth/callback?code=code_x&state=' + encodeURIComponent(u.searchParams.get('state')),
            { cookie: cookieHeader(again) + '; ov_oauth_next=//evil.com/x' });
        assert.strictEqual(res.status, 302);
        assert.strictEqual(res.headers.get('location'), '/', 'a tampered next goes home');
    } finally { await h.stop(); }
});

t('GET /auth/health: 200 while the Network accepts this client, 503 when it refuses it', async () => {
    const h = await boot();
    try {
        const res = await req(h, 'GET', '/auth/health');
        assert.strictEqual(res.status, 200);
        const json = JSON.parse(res.text);
        assert.deepStrictEqual([json.ok, json.client], [true, 'ok']);
    } finally { await h.stop(); }
    const broken = await boot({ env: { OV_OAUTH_CLIENT_SECRET: 'not-the-secret' } });
    try {
        const res = await req(broken, 'GET', '/auth/health');
        assert.strictEqual(res.status, 503);
        const json = JSON.parse(res.text);
        assert.deepStrictEqual([json.ok, json.client], [false, 'invalid']);
    } finally { await broken.stop(); }
});
