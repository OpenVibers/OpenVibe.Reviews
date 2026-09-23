'use strict';
/**
 * Test helpers: a Reviews instance on a temp database and a random port, a generated Network RSA
 * key, signed user JWTs and service tokens, and stub upstreams — an in-memory OpenVibe.Sources
 * speaking sources.item@1 and a Community stub. Nothing here needs the network.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { serviceAuth, ids } = require('openvibe-contracts');
const { signDelivery } = require('openvibe-sdk/events');
const { load } = require('../server/config');
const { start } = require('../server/index');

const ISSUER = 'https://network.test';
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });

const ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function subject(prefix = 'usr') { let s = ''; for (let i = 0; i < 26; i++) s += ALPHA[crypto.randomInt(32)]; return `${prefix}_${s}`; }

const EDITOR = subject();
const READER = subject();
const WEBHOOK_SECRET = 'test-webhook-secret-not-a-real-one';

function userToken({ subject: sub = READER, username = 'someone', role = 'user', aud = ['openvibe.network'], exp = 3600 } = {}) {
    const now = Math.floor(Date.now() / 1000);
    return serviceAuth.signServiceToken({ iss: ISSUER, aud, sub: 42, id: 42, subject_id: sub, username, display_name: username, role, iat: now, exp: now + exp }, privateKey);
}
const editorToken = () => userToken({ subject: EDITOR, username: 'editor' });
const readerToken = () => userToken({ subject: READER, username: 'reader' });

function serviceToken({ client = 'ai', cap = [], aud = 'openvibe.reviews', exp = 300 } = {}) {
    const now = Math.floor(Date.now() / 1000);
    return serviceAuth.signServiceToken({ iss: ISSUER, sub: `svc:${client}`, actor_type: 'service', aud: [aud], cap, ns: [], iat: now, exp: now + exp, jti: `tok_${crypto.randomBytes(8).toString('hex')}` }, privateKey);
}

const quiet = { log() {}, warn() {}, error() {} };

/** In-memory OpenVibe.Sources: items in change order, sources, removal. */
function fakeSources() {
    const items = new Map();
    const sources = new Map();
    let seq = 0;
    let down = false;
    const api = {
        items, sources,
        setDown(v) { down = v; },
        addSource(s) { sources.set(s.key, { status: 'healthy', stale: false, last_success_at: '2026-09-20T10:00:00.000Z', ...s }); },
        put(item) { item.change_seq = ++seq; items.set(item.id, item); return item; },
        /** A new revision of an item (content changed at the source). */
        revise(id, fields, retrievedAt) {
            const cur = items.get(id);
            const next = { ...cur, fields: { ...cur.fields, ...fields }, revision: cur.revision + 1 };
            next.provenance = { ...cur.provenance, retrieved_at: retrievedAt || new Date(Date.parse(cur.provenance.retrieved_at) + 3600000).toISOString() };
            next.provenance.content_hash = crypto.createHash('sha256').update(JSON.stringify(next.fields)).digest('hex');
            return api.put(next);
        },
        remove(id, reason = 'takedown') {
            const cur = items.get(id);
            return api.put({ ...cur, revision: cur.revision + 1, removed: { at: '2026-09-21T09:00:00.000Z', reason } });
        },
        async fetch(url) {
            const u = new URL(url);
            if (down) throw new Error('connect ECONNREFUSED');
            const json = (status, body) => ({ status, ok: status < 400, json: async () => body, text: async () => JSON.stringify(body) });
            let m = u.pathname.match(/^\/api\/v1\/items\/(itm_[0-9A-Z]+)$/);
            if (m) {
                const it = items.get(m[1]);
                if (!it) return json(404, { code: 'sources.not_found' });
                const s = sources.get(it.source_key);
                return json(200, { item: it, source: s ? { key: s.key, status: s.status, stale: s.stale, last_success_at: s.last_success_at } : null });
            }
            if (u.pathname === '/api/v1/items') {
                const after = Number(u.searchParams.get('after') || 0);
                const limit = Number(u.searchParams.get('limit') || 100);
                const all = [...items.values()].filter((i) => i.change_seq > after && (!u.searchParams.get('category') || i.category === u.searchParams.get('category'))).sort((a, b) => a.change_seq - b.change_seq);
                const page = all.slice(0, limit);
                const srcs = {};
                for (const i of page) { const s = sources.get(i.source_key); if (s) srcs[s.key] = { status: s.status, stale: s.stale, last_success_at: s.last_success_at }; }
                return json(200, { items: page, next_after: page.length ? page[page.length - 1].change_seq : after, more: all.length > limit, sources: srcs });
            }
            m = u.pathname.match(/^\/api\/v1\/sources\/([a-z0-9-]+)$/);
            if (m) { const s = sources.get(m[1]); return s ? json(200, { source: s }) : json(404, { code: 'sources.not_found' }); }
            return json(404, { code: 'not_found' });
        },
    };
    return api;
}

const hash = (x) => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
let clockMs = Date.parse('2026-09-20T12:00:00.000Z');

function baseItem({ source = 'steam-reviews-portal-2', kind, identity, fields, canonicalUrl = null, title = null, retrievedAt, publishedAt = '2026-09-01T00:00:00.000Z', license = null }) {
    clockMs += 1000;
    return {
        id: `itm_${ids.ulid(clockMs)}`, source_key: source, category: 'reviews', kind, identity, canonical_url: canonicalUrl, title, summary: null, authors: [],
        published_at: publishedAt, source_updated_at: null, fields, revision: 1,
        provenance: {
            retrieved_at: retrievedAt || new Date(clockMs).toISOString(), first_seen_at: new Date(clockMs).toISOString(), content_hash: hash(fields),
            raw_body_hash: hash(identity), parser_version: kind === 'review_signal' ? 'api@1' : 'jsonld@1', fetch_run_id: `frn_${ids.ulid(clockMs)}`,
            license_note: license, terms_note: 'Terms recorded by a person in OpenVibe.Sources (test).', entered_by: null,
        },
        removed: null,
    };
}

function steamItem({ votedUp = true, source = 'steam-reviews-portal-2', ...rest } = {}) {
    return baseItem({ source, kind: 'review_signal', identity: String(crypto.randomInt(1e9)), fields: { voted_up: votedUp, votes_up: 2, steam_purchase: true, received_for_free: false, playtime_at_review_min: 600, language: 'english' }, ...rest });
}

function productItem({ value = 4.2, best = 5, count = 120, url = 'https://shop.example/p/widget', gtin = null, title = 'Widget 3000', source = 'shop-example', ...rest } = {}) {
    return baseItem({ source, kind: 'product', identity: url, canonicalUrl: url, title, fields: { schema_type: 'Product', gtin, sku: null, aggregate_rating: { value, best, worst: null, count, review_count: null } }, ...rest });
}

function fakeCommunity() {
    const threads = new Map();
    return {
        threads,
        async fetch(url, opts = {}) {
            const u = new URL(url);
            const json = (status, body) => ({ status, ok: status < 400, json: async () => body, text: async () => JSON.stringify(body) });
            if (u.pathname === '/api/v1/comments/threads/resolve') {
                const ref = JSON.parse(opts.body).ref;
                const key = `${ref.service}:${ref.type}:${ref.id}`;
                if (!threads.has(key)) threads.set(key, { id: `thr_${threads.size + 1}`, comments: [] });
                return json(201, { thread: { id: threads.get(key).id, visibility: 'public' }, created: true });
            }
            const m = u.pathname.match(/^\/api\/v1\/comments\/threads\/([^/]+)(\/comments)?$/);
            if (m) {
                const t = [...threads.values()].find((x) => x.id === m[1]);
                if (!t) return json(404, { code: 'thread.not_found' });
                if (m[2]) { t.comments.push({ id: t.comments.length + 1, message: JSON.parse(opts.body).message, display_name: 'reader', created_at: '2026-09-21T10:00:00.000Z' }); return json(201, { comment: t.comments[t.comments.length - 1] }); }
                return json(200, { thread: { id: t.id }, comments: t.comments });
            }
            return json(404, {});
        },
    };
}

/**
 * A running Reviews. opts.env overrides env vars; sources/community are the stubs above.
 */
async function boot({ env = {}, sources = fakeSources(), community = null, dbPath, now, workers = false } = {}) {
    const dir = dbPath ? path.dirname(dbPath) : fs.mkdtempSync(path.join(os.tmpdir(), 'reviews-test-'));
    const config = load({
        NODE_ENV: 'test', PORT: '0', HOST: '127.0.0.1', BASE_URL: 'http://reviews.test',
        REVIEWS_DB_PATH: dbPath || path.join(dir, 'reviews.db'),
        OV_NETWORK_URL: ISSUER, OV_NETWORK_INTERNAL_URL: '', REVIEWS_GATE_MIN_WORDS: '20',
        OV_SOURCES_INTERNAL_URL: 'http://sources.test', OV_COMMUNITY_INTERNAL_URL: 'http://community.test',
        REVIEWS_EDITORS: EDITOR, REVIEWS_EVENTS_SECRET: WEBHOOK_SECRET,
        ...env,
    });
    const fetchImpl = async (url, opts) => {
        const host = new URL(url).host;
        if (host === 'sources.test') return sources.fetch(url, opts);
        if (host === 'community.test' && community) return community.fetch(url, opts);
        throw new Error(`unexpected outbound fetch ${url}`);
    };
    const h = await start({
        config, publicKey, log: quiet, listen: true, workers, rateLimits: false, now, fetchImpl,
        tokens: { getToken: async () => 'stub-token', authHeaders: async () => ({ Authorization: 'Bearer stub-token' }), invalidate() {} },
    });
    const base = `http://127.0.0.1:${h.server.address().port}`;
    return { ...h, base, dir, sources, community };
}

async function req(h, method, p, { token, body, form, headers = {}, cookie } = {}) {
    const hs = { ...headers };
    if (token) hs.Authorization = `Bearer ${token}`;
    if (cookie) hs.Cookie = cookie;
    let payload;
    if (body !== undefined) { hs['Content-Type'] = 'application/json'; payload = typeof body === 'string' ? body : JSON.stringify(body); }
    if (form !== undefined) {
        hs['Content-Type'] = 'application/x-www-form-urlencoded';
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(form)) for (const x of [].concat(v)) params.append(k, x == null ? '' : String(x));
        payload = params.toString();
    }
    const res = await fetch(h.base + p, { method, headers: hs, body: payload, redirect: 'manual' });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* html or text */ }
    return { status: res.status, headers: res.headers, text, json };
}

const cookieFor = (token) => `ov_token=${token}`;

/** Every envelope in the outbox, oldest first. */
function outbox(h) {
    return h.db.prepare('SELECT envelope FROM review_event_outbox ORDER BY id').all().map((r) => JSON.parse(r.envelope));
}

const IMPORT = () => serviceToken({ client: 'sources-sync', cap: ['reviews.signal.import'] });

/** Put an item in the fake Sources and import it through the API as a granted service. */
async function importItem(h, item) {
    h.sources.put(item);
    const r = await req(h, 'POST', '/api/v1/signals/import', { token: IMPORT(), body: { source_item_id: item.id } });
    assert.strictEqual(r.status, 200, r.text);
    return r.json;
}

async function createEntity(h, body) {
    const r = await req(h, 'POST', '/api/v1/entities', { token: editorToken(), body });
    assert.strictEqual(r.status, 201, r.text);
    return r.json.entity;
}

/** A signed delivery from OpenVibe.Events to POST /internal/events. */
async function deliver(h, envelope, { secret = WEBHOOK_SECRET } = {}) {
    const raw = JSON.stringify({ event: envelope, seq: 1 });
    return req(h, 'POST', '/internal/events', { body: raw, headers: { 'X-OpenVibe-Signature': signDelivery(raw, secret) } });
}

function sourcesEvent(type, item, extra = {}) {
    return {
        event_id: `evt_${ids.ulid(Date.now())}`, event_type: type, version: 1, source: 'sources', actor: { type: 'service', id: 'sources' },
        timestamp: new Date().toISOString(), visibility: 'internal', subject: { type: 'item', id: item.id, revision: item.revision },
        payload: { item_id: item.id, source_key: item.source_key, category: item.category, kind: item.kind, revision: item.revision, ...extra },
    };
}

/** Minimal suite runner: runs named async tests in order, exits non-zero on the first failure. */
function suite(name) {
    const tests = [];
    const t = (title, fn) => tests.push({ title, fn });
    setImmediate(async () => {
        for (const x of tests) {
            try { await x.fn(); console.log(`  ok  ${name}: ${x.title}`); } catch (err) { console.error(`  FAIL ${name}: ${x.title}\n${err && err.stack}`); process.exit(1); }
        }
        process.exit(0);
    });
    return t;
}

module.exports = {
    boot, req, userToken, editorToken, readerToken, serviceToken, subject, cookieFor, outbox, suite,
    fakeSources, fakeCommunity, steamItem, productItem, importItem, createEntity, deliver, sourcesEvent,
    IMPORT, EDITOR, READER, WEBHOOK_SECRET, ISSUER, publicKey, privateKey, quiet,
};
