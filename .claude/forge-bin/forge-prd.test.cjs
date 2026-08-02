#!/usr/bin/env node
'use strict';
/** Offline, hermetic tests for forge-prd.cjs — writes ONLY to an os.mkdtemp temp dir via the
 *  FORGE_STORE_ROOT override (shared with forge-store.cjs); never touches the real project's .claude/.
 *  Exit 0 = all pass. */
const fs = require('fs');
const path = require('path');
const os = require('os');

// hermetic: point the shared store at a throwaway temp dir BEFORE requiring forge-prd.cjs (it requires
// forge-store.cjs internally, which resolves CLAUDE_DIR once at load time).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-prd-test-'));
process.env.FORGE_STORE_ROOT = TMP;
const { renderPrd, writePrd, criteriaToTickets } = require('./forge-prd.cjs');
const store = require('./forge-store.cjs');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

console.log('forge-prd offline tests (hermetic root=' + TMP + ')');

// 1) renderPrd includes all 13 section headings; a missing section renders "(not specified)"
const HEADINGS = ['Goal', 'Users', 'Problem', 'Solution', 'Modules', 'User Stories', 'MVP Scope', 'Non-Goals', 'Architecture', 'Risks', 'Acceptance Criteria', 'Test Plan', 'Roadmap'];
const bareMd = renderPrd({ prd_id: 'prd-bare', title: 'Bare PRD', sections: { goal: 'Ship the thing' } });
t('renderPrd includes all 13 section headings', HEADINGS.every((h) => bareMd.includes('## ' + h)));
t('renderPrd never crashes on a partial PRD', typeof bareMd === 'string' && bareMd.length > 0);
t('a missing section renders "(not specified)"', bareMd.includes('(not specified)'));
t('the one section that IS set does not render as not specified', /## Goal\s*\n+Ship the thing/.test(bareMd));
t('renderPrd never crashes on a null/undefined prd', typeof renderPrd(null) === 'string' && typeof renderPrd(undefined) === 'string');

// 2) writePrd creates <id>.md + <id>.meta.json + index.jsonl row
const prdFull = {
  prd_id: 'prd-full-001', title: 'Full PRD', project: 'demo-project',
  sections: {
    goal: 'Build WP3', users: ['end user', 'admin'], problem: 'No PRD generator exists',
    solution: 'Zero-dep PRD writer', modules: ['forge-prd.cjs', 'dashboard panel'],
    user_stories: ['As a Lead I want a PRD so that work is scoped'],
    mvp_scope: 'markdown + meta + tickets', non_goals: 'no external deps',
    architecture: 'flat-file store', risks: ['scope creep'],
    acceptance_criteria: [
      { id: 'ac-1', text: 'renderPrd produces all sections', owner: 'coder', required_tests: ['forge-prd.test.cjs'] },
      { text: 'writePrd creates md+meta+index row' },
    ],
    test_plan: 'hermetic FORGE_STORE_ROOT tests', roadmap: 'WP3 -> WP4',
  },
};
const written = writePrd(prdFull);
t('writePrd returns prd_id/mdPath/metaPath', written.prd_id === 'prd-full-001' && !!written.mdPath && !!written.metaPath);
t('writePrd creates the .md file', fs.existsSync(written.mdPath));
t('writePrd creates the .meta.json file', fs.existsSync(written.metaPath));
const idxPath = path.join(TMP, 'forge-prd', 'index.jsonl');
t('writePrd appends a row to forge-prd/index.jsonl', fs.existsSync(idxPath) && fs.readFileSync(idxPath, 'utf8').includes('prd-full-001'));
const metaJson = JSON.parse(fs.readFileSync(written.metaPath, 'utf8'));
t('meta.json carries a _generated ISO timestamp', typeof metaJson._generated === 'string' && !Number.isNaN(Date.parse(metaJson._generated)));
t('meta.json round-trips the title', metaJson.title === 'Full PRD');
t('written .md includes both acceptance criteria', fs.readFileSync(written.mdPath, 'utf8').includes('renderPrd produces all sections') && fs.readFileSync(written.mdPath, 'utf8').includes('writePrd creates md+meta+index row'));

// 3) secret redaction — fake secret ABSENT from BOTH the .md and the .meta.json
const FAKE_SECRET = 'nvapi-FAKEFAKEFAKEFAKE1234567890';
const prdSecret = {
  prd_id: 'prd-secret-001', title: 'Secret PRD',
  sections: { goal: 'leaked key: ' + FAKE_SECRET, acceptance_criteria: ['no secrets in output'] },
};
const writtenSecret = writePrd(prdSecret);
const mdText = fs.readFileSync(writtenSecret.mdPath, 'utf8');
const metaText = fs.readFileSync(writtenSecret.metaPath, 'utf8');
t('fake secret ABSENT from the written .md', !mdText.includes(FAKE_SECRET));
t('fake secret ABSENT from the written .meta.json', !metaText.includes(FAKE_SECRET));
t('redaction marker present in the .md', mdText.includes('***REDACTED***'));

// 4) criteriaToTickets — 2 criteria -> 2 tickets, status open, prd_id set
const ticketIds = criteriaToTickets(prdFull);
t('criteriaToTickets creates 2 tickets', ticketIds.length === 2);
for (const tid of ticketIds) {
  const ticket = store.getEntity('tickets', tid);
  t('ticket ' + tid + ' has status open', ticket.status === 'open');
  t('ticket ' + tid + ' carries prd_id', ticket.prd_id === 'prd-full-001');
}
t('criteriaToTickets on a PRD with no acceptance_criteria returns []', criteriaToTickets({ prd_id: 'prd-empty', sections: {} }).length === 0);

// 5) invalid prd_id ("../x") is rejected
let rejected = false;
try { writePrd({ prd_id: '../x', title: 'bad', sections: {} }); } catch (e) { rejected = /invalid prd_id/i.test(e.message); }
t('invalid prd_id "../x" is REJECTED', rejected === true);
t('bad-id write did not escape forge-prd/', !fs.existsSync(path.join(TMP, 'x.md')));

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
