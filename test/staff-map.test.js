'use strict';
// Staff powers come from the openvibe-contracts staff map (ADR-022): staff.editorial.manage makes a person an editor (REVIEWS_EDITORS names more).
// No server file compares a person's role by hand.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { staff } = require('openvibe-contracts');

const CAPS = ["staff.editorial.manage"];
for (const [claims, want] of [[{"role": "user"}, [false]], [{"role": "global_mod"}, [false]], [{"role": "admin"}, [true]], [{"role": "admin", "is_owner": true}, [true]]]) {
    CAPS.forEach((cap, i) => assert.strictEqual(staff.can(claims, cap), want[i], `${JSON.stringify(claims)} ${cap}`));
}

const offenders = [];
(function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(f); continue; }
        if (!/\.(js|ts)$/.test(e.name)) continue;
        fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
            if (/STAFF_ROLES|STAFF_SUBJECTS|claims\.role\s*[!=]==?|\.(has|includes)\(\s*(claims|u|user|p)\.role\b|\brole\s*[!=]==?\s*['"](admin|global_mod|moderator)['"]/.test(line)) offenders.push(`${path.relative(path.join(__dirname, '..'), f)}:${i + 1}`);
        });
    }
})(path.join(__dirname, '..', "server"));
assert.deepStrictEqual(offenders, [], 'raw role checks; ask staff.can(claims, \'staff.…\')');
console.log('staff map: all checks passed');
