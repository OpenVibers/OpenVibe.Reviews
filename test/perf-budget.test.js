'use strict';
// Size budgets for openvibe.reviews' home page (roadmap WS-T task 1, openvibe-shared/perf-budget): the
// server as it runs (a fresh database), measured without a browser. Budgets sit a little above today's
// measurement; raising one is a decision to state in the commit.
//   node test/perf-budget.test.js
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { measure, check, format } = require('openvibe-shared/perf-budget');

const BUDGETS = {
    htmlRawKB: 46, // 46: measured 45.6 with openvibe-shared 4.190.0 (2026-11-10: the site name's dropdown, the footer's online strip, the balances pill); 44.2: measured 42.2 with openvibe-shared 4.161.0, plus room for 4.162.0–4.163.0, 2026-11-09
    htmlBrotliKB: 10.5, // 10.5: measured 10.2 with openvibe-shared 4.190.0 (2026-11-10: the site name's dropdown, the footer's online strip, the balances pill); 9.2 with the short home (2026-10-30: the records' pick block and the fold's scripts); 8.0 (2026-10-22 the richer front page); 6.6 (5.9, 4.6 before the showcase)
    jsFiles: 5,   // 5 (theme-loader, web-runtime, navbar, footer, boost: openvibe-shared/shell adds web-runtime)
    jsRawKB: 393, // 393: measured 392.5 with openvibe-shared 4.190.0 (2026-11-10: the site name's dropdown, the footer's online strip, the balances pill); 376.4: measured 376.3 KB raw with openvibe-shared 4.186.0 (2026-11-10: the mark's Working and Thinking states, the Dock and the menu as one sheet, bare controls styled by the loader); 375.1: measured 367.1 with openvibe-shared 4.161.0, plus room for 4.162.0–4.163.0, 2026-11-09
    jsBrotliKB: 94, // 94: measured 93.7 KB brotli with openvibe-shared 4.190.0 (2026-11-10: the site name's dropdown, the footer's online strip, the balances pill); 89.8: measured 89.7 KB brotli with openvibe-shared 4.186.0 (2026-11-10: the mark's Working and Thinking states, the Dock and the menu as one sheet, bare controls styled by the loader); 89.5: measured 87.5 with openvibe-shared 4.163.0, plus room for 4.162.0–4.163.0, 2026-11-09
    cssFiles: 2,   // 2 (reviews.css, openvibe-shared showcase.css)
    cssRawKB: 54.6, // 54.6: measured 49.6 with openvibe-shared 4.161.0, plus room for 4.162.0–4.163.0, 2026-11-09
    cssBrotliKB: 11,   // 10.2 with the phone folds as card rows (2026-11-03); 9.9 with the short home (2026-10-30: the pick block's and the fold's own rules); 9.1 with openvibe-shared 4.48.0 (the site switcher on the mark, the menu's Start tab and quick tools; Kit's touch hit areas and the phone navbar fix, 4.44-4.47.3); 8.8 with 10 touch targets (2026-10-29: the site bar, the search, the questions and three lone links); 8.6 the home's fold and phone list rules (2026-10-29); 6.7 with Shared 4.13.0; raised from 8 for openvibe-shared v4.39.0 (+1.5 KB raw of kit/room/showcase CSS); measured 8.2
    externalFiles: 1,   // 0
};

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

(async () => {
    // A database of its own (not the shared dev PGlite in data/pglite, and not whatever the caller's
    // DATABASE_URL names), so the measurement is the server on a fresh database and the run leaves nothing.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-budget-'));
    const pgliteDir = path.join(dir, 'pglite');
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test',
            DATABASE_URL: '', DATABASE_DIRECT_URL: '', VALKEY_URL: '', REVIEWS_PGLITE_DIR: pgliteDir,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    const base = `http://127.0.0.1:${port}`;
    try {
        let up = false;
        for (let i = 0; i < 150 && !up; i++) {
            up = await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false);
            if (!up) await new Promise((r) => setTimeout(r, 100));
        }
        assert.ok(up, `the server did not start:\n${stderr}`);
        assert.ok(fs.existsSync(pgliteDir), 'the server did not use the isolated database (REVIEWS_PGLITE_DIR)');
        const m = await measure({ base });
        const over = check(m, BUDGETS);
        assert.deepStrictEqual(over, [], format(m, over));
        console.log(format(m));
        console.log('perf budget: all checks passed');
    } finally {
        child.kill();
        fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch((err) => { console.error(err); process.exitCode = 1; });
