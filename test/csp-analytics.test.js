'use strict';
// The page CSP lets Cloudflare Web Analytics run: the edge injects its beacon (static.cloudflareinsights.com) into every
// page and it reports to cloudflareinsights.com. Without them every visitor's console showed a CSP violation and no
// analytics came from this site (a signed-in browser pass of every site, 2026-10-15). Wiki and Live allow the same.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', 'server', 'app.js'), 'utf8');
const script = /(scriptSrc|'script-src'|"script-src)[^\n]*/.exec(app);
const connect = /(connectSrc|'connect-src'|"connect-src)[^\n]*/.exec(app);
assert.ok(script && script[0].includes('https://static.cloudflareinsights.com'), 'script-src allows the beacon');
assert.ok(connect && connect[0].includes('https://cloudflareinsights.com'), 'connect-src allows its reports');
console.log('csp: Cloudflare Web Analytics is allowed');
