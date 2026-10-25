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
    htmlRawKB: 36,   // 33.8 on 2026-10-22 (the front page's numbers, how it works, questions with their FAQPage JSON-LD, links); 28.7 (fresh database; 27.0 before 2026-10-17's three more kinds to browse, 23.7 before 2026-10-15's two more features with their ring icons, 17.8 before the showcase)
    htmlBrotliKB: 9,   // 8.0 (2026-10-22 the richer front page); 6.6 (5.9, 4.6 before the showcase)
    jsFiles: 5,   // 5 (theme-loader, web-runtime, navbar, footer, boost: openvibe-shared/shell adds web-runtime)
    jsRawKB: 268,   // 263.4 with shared 4.11.0's seasonal navbar; 239.1 (212.2 before openvibe-shared/shell's web-runtime.js)
    jsBrotliKB: 67,   // 65.3 Shared 4.12.0: the light/dark switch, the seasonal mark and the theme pairs; 61.7 with shared 4.11.0's seasonal navbar; 56.3 (49.9 before web-runtime.js)
    cssFiles: 2,   // 2 (reviews.css, openvibe-shared showcase.css)
    cssRawKB: 27,   // 25.4 on 2026-10-22 (the front page's numbers, inspections, ranked records, questions and links); 22.1 with members' reviews, kinds and other review sites (2026-10-17); 19.4 (18.2 before 2026-10-15's scoreboard, 6.7 before showcase.css)
    cssBrotliKB: 6.5,   // 5.6 (2026-10-22 the richer front page); 5.1 with members' reviews (2026-10-17); 4.6 (4.3, 1.7 before showcase.css)
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
