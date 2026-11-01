'use strict';
// Buttons wear the theme's strong accent with its paired text colour. Dark text on the plain accent was 3.6:1 on
// Daylight's violet (axe, 2026-11-01).
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'reviews.css'), 'utf8');
assert.match(css, /\.rv-button, button \{[^}]*background: var\(--accent-strong, var\(--rv-accent\)\); color: var\(--on-accent-strong, #0a0f1c\);/);
console.log('button ink: all checks passed');
