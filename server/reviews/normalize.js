'use strict';
/**
 * Normalisation of the identifiers entities are resolved by. Pure functions: the same input always
 * gives the same key, so resolution is deterministic.
 */

class NormalizeError extends Error {
    constructor(message) { super(message); this.status = 422; this.code = 'alias.invalid'; }
}

function name(value) {
    const s = String(value == null ? '' : value).normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
    if (!s) throw new NormalizeError('A name needs at least one letter or digit');
    return s.slice(0, 200);
}

/** host (without www.) + path (+ query minus tracking parameters); http and https are the same thing. */
function url(value) {
    let u;
    try { u = new URL(String(value || '').trim()); } catch { throw new NormalizeError('A URL alias must be an absolute http(s) URL'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new NormalizeError('A URL alias must be http(s)');
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const keep = [...u.searchParams.entries()].filter(([k]) => !/^(utm_|fbclid$|gclid$|ref$|mc_)/i.test(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    let pathname = u.pathname.replace(/\/{2,}/g, '/');
    if (pathname.length > 1) pathname = pathname.replace(/\/+$/, '');
    const query = keep.length ? `?${new URLSearchParams(keep).toString()}` : '';
    return `${host}${pathname === '/' ? '' : pathname}${query}`.slice(0, 1000);
}

function code(value, what) {
    const s = String(value == null ? '' : value).trim().toUpperCase().replace(/\s+/g, '');
    if (!s || s.length > 100) throw new NormalizeError(`A ${what} is 1–100 characters`);
    return s;
}

/** GTIN-8/12/13/14 → 14 digits, so the same product under two lengths is one key. */
function gtin(value) {
    const d = String(value == null ? '' : value).replace(/[\s-]/g, '');
    if (!/^\d+$/.test(d) || ![8, 12, 13, 14].includes(d.length)) throw new NormalizeError('A GTIN has 8, 12, 13 or 14 digits');
    return d.padStart(14, '0');
}

function sourceKey(value) {
    const s = String(value == null ? '' : value).trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(s)) throw new NormalizeError('A source binding is an OpenVibe.Sources source key');
    return s;
}

/** namespace:id, e.g. steam_app:620 */
function external(value) {
    const m = String(value == null ? '' : value).trim().match(/^([A-Za-z][A-Za-z0-9_.-]{0,39}):(.{1,200})$/);
    if (!m) throw new NormalizeError('An external id is namespace:id (e.g. steam_app:620)');
    return `${m[1].toLowerCase()}:${m[2].trim()}`;
}

const BY_TYPE = { name, url, sku: (v) => code(v, 'SKU'), mpn: (v) => code(v, 'MPN'), gtin, source: sourceKey, external };

function alias(type, value) {
    const fn = BY_TYPE[type];
    if (!fn) throw new NormalizeError(`alias type must be one of ${Object.keys(BY_TYPE).join(', ')}`);
    return fn(value);
}

/** Try to normalise; null when the value is not a valid identifier of that type. */
function tryAlias(type, value) {
    if (value == null || value === '') return null;
    try { return alias(type, value); } catch { return null; }
}

function slug(value) {
    const s = String(value == null ? '' : value).normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/&/g, '-and-').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '');
    return s || null;
}

module.exports = { alias, tryAlias, slug, NormalizeError, TYPES: Object.keys(BY_TYPE) };
