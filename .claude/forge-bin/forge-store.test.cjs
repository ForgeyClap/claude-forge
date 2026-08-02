#!/usr/bin/env node
'use strict';
/** Offline, hermetic tests for forge-store.cjs — writes ONLY to an os.mkdtemp temp dir via the
 *  FORGE_STORE_ROOT override; never touches the real project's .claude/. Exit 0 = all pass. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

// hermetic: point the store at a throwaway temp dir BEFORE requiring the module (CLAUDE_DIR is
// resolved once at load time).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-store-test-'));
process.env.FORGE_STORE_ROOT = TMP;
const S = require('./forge-store.cjs');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

console.log('forge-store offline tests (hermetic root=' + TMP + ')');

// 1) put -> get -> list round-trip for a ticket
S.putEntity('tickets', 'tk-001', { title: 'first ticket', status: 'open' });
const gotTicket = S.getEntity('tickets', 'tk-001');
t('put/get ticket round-trips title', gotTicket.title === 'first ticket');
t('put/get ticket round-trips status', gotTicket.status === 'open');
t('put stamps _stored as a valid ISO timestamp', typeof gotTicket._stored === 'string' && !Number.isNaN(Date.parse(gotTicket._stored)));
t('list(tickets) contains tk-001', S.listStore('tickets').includes('tk-001'));

// 1b) put -> get -> list round-trip for an artifact (2nd store)
S.putEntity('artifacts', 'art-001', { kind: 'screenshot', path: 'x.png' });
const gotArtifact = S.getEntity('artifacts', 'art-001');
t('put/get artifact round-trips kind', gotArtifact.kind === 'screenshot');
t('list(artifacts) contains art-001', S.listStore('artifacts').includes('art-001'));

// 1c) prd + mindmaps stores (3rd/4th store) also work
S.putEntity('prd', 'prd-000', { doc: 'v0' });
t('prd store round-trips', S.getEntity('prd', 'prd-000').doc === 'v0');
S.putEntity('mindmaps', 'mm-001', { nodes: ['a', 'b'] });
t('mindmaps store round-trips', S.getEntity('mindmaps', 'mm-001').nodes.length === 2);

// 2) bad id is rejected (path traversal attempt)
let rejected = false;
try { S.putEntity('tickets', '../evil', { x: 1 }); } catch (e) { rejected = /invalid id/.test(e.message); }
t('bad id "../evil" is REJECTED', rejected === true);
t('bad id write did not escape the tickets store dir', !fs.existsSync(path.join(TMP, 'evil.json')));

// 2b) unknown store name is rejected
let badStore = false;
try { S.putEntity('nope-store', 'id1', { x: 1 }); } catch (e) { badStore = /unknown store/.test(e.message); }
t('unknown store name is REJECTED', badStore === true);

// 2c) get on a missing entity throws
let missingThrew = false;
try { S.getEntity('tickets', 'does-not-exist'); } catch (e) { missingThrew = /not found/.test(e.message); }
t('get on a missing entity throws "not found"', missingThrew === true);

// 3) secret redaction — raw secret never reaches disk
const secret = 'nvapi-SECRETSECRETSECRET1234567890';
S.putEntity('tickets', 'tk-secret', { note: 'key=' + secret });
const rawFile = fs.readFileSync(path.join(TMP, 'forge-tickets', 'tk-secret.json'), 'utf8');
t('raw secret absent from the written file', !rawFile.includes(secret));
t('redaction marker present in the written file', rawFile.includes('***REDACTED***'));
const gotSecret = S.getEntity('tickets', 'tk-secret');
t('getEntity never returns the raw secret either', !JSON.stringify(gotSecret).includes(secret));

// 4) index.jsonl grows by exactly one per put
const before = S.readIndex('prd').split('\n').filter(Boolean).length;
S.putEntity('prd', 'prd-001', { doc: 'v1' });
const after1 = S.readIndex('prd').split('\n').filter(Boolean).length;
S.putEntity('prd', 'prd-002', { doc: 'v2' });
const after2 = S.readIndex('prd').split('\n').filter(Boolean).length;
t('index.jsonl grows by exactly one per put', after1 === before + 1 && after2 === after1 + 1);
const idxRows = S.readIndex('prd').split('\n').filter(Boolean).map((l) => JSON.parse(l));
t('index rows carry {id, ts, store}', idxRows.every((r) => r.id && r.ts && r.store === 'prd'));

// 4b) HARDENED redaction (2026-07-10 security review): new patterns + key-name heuristic, no over-redaction
const R = '***REDACTED***';
const hasRaw = (o, s) => JSON.stringify(o).includes(s);
t('stripe sk_live_ redacted', !hasRaw(S.redactValue({ v: 'sk_live_ABCDEFGHIJ1234567890' }), 'sk_live_ABCDEFGHIJ'));
t('google AIza key redacted', !hasRaw(S.redactValue({ v: 'AIzaSyA1234567890123456789012345678901234' }), 'AIzaSyA12345'));
t('sendgrid SG. key redacted', !hasRaw(S.redactValue({ v: 'SG.ABCDEFGHIJKLMNOPQRSTUV.ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcdef' }), 'SG.ABCDEFGHIJKLMNOP'));
t('github gho_ token redacted', !hasRaw(S.redactValue({ v: 'gho_ABCDEFGHIJ1234567890ABCDEFGHIJ' }), 'gho_ABCDEFGHIJ'));
const pemBlk = '-----BEGIN RSA PRIVATE KEY-----\nMIIBODYSECRETLINE1\nMIIBODYSECRETLINE2\n-----END RSA PRIVATE KEY-----';
t('PEM private key BODY redacted (not just header)', !hasRaw(S.redactValue({ v: pemBlk }), 'MIIBODYSECRETLINE'));
t('scheme://user:pass@ password redacted', !hasRaw(S.redactValue({ v: 'postgres://admin:SuperSecret99@db.host/x' }), 'SuperSecret99'));
t('scheme://user preserved (only password masked)', hasRaw(S.redactValue({ v: 'postgres://admin:SuperSecret99@db.host/x' }), 'postgres://admin'));
t('keyless secret via key name: password -> redacted', S.redactValue({ password: 'hunter2plaintext' }).password === R);
t('keyless secret via key name: access_token -> redacted', S.redactValue({ access_token: 'plainABC123' }).access_token === R);
t('keyless secret via key name: apiKey (camel) -> redacted', S.redactValue({ apiKey: 'plainkeyvalue' }).apiKey === R);
t('nested db_password -> redacted', S.redactValue({ db: { db_password: 'pw' } }).db.db_password === R);
t('innocent key "author" NOT redacted', S.redactValue({ author: 'Jane Doe' }).author === 'Jane Doe');
t('innocent key "description" NOT redacted', S.redactValue({ description: 'a token of appreciation' }).description === 'a token of appreciation');

// 5) CLI smoke test (spawned child process, same hermetic FORGE_STORE_ROOT)
const cliEnv = { ...process.env, FORGE_STORE_ROOT: TMP };
const run = (...a) => spawnSync(process.execPath, [path.join(__dirname, 'forge-store.cjs'), ...a], { env: cliEnv, encoding: 'utf8' });
const cliPut = run('put', 'tickets', 'tk-cli', '{"a":1}');
t('CLI put exits 0', cliPut.status === 0);
const cliGet = run('get', 'tickets', 'tk-cli');
t('CLI get exits 0 and prints the stored value', cliGet.status === 0 && /"a": 1/.test(cliGet.stdout));
const cliMissing = run('get', 'tickets', 'does-not-exist-cli');
t('CLI get on a missing entity exits non-zero', cliMissing.status !== 0);
const cliBadId = run('put', 'tickets', '../evil-cli', '{"x":1}');
t('CLI put with a traversal id exits non-zero', cliBadId.status !== 0);
const cliList = run('list', 'tickets');
t('CLI list includes tk-cli', /tk-cli/.test(cliList.stdout));

// 6) WP-sizing lint (ADVISORY only, tickets store only) — module-level calls check the _sizing_warning
// stamp and exit behavior; the exact warning text is verified via the CLI subprocess below (6b), which
// is the only place stderr can be captured independently of this test runner's own console.error.
const bigTicket = S.putEntity('tickets', 'tk-big', { title: 'big change', related_files: ['a.js', 'b.js', 'c.js', 'd.js', 'e.js'] });
t('ticket with >3 related_files and no sizing_justification stamps _sizing_warning', bigTicket._sizing_warning === true);
t('oversized ticket write still succeeds on disk (advisory only, never blocks)', fs.existsSync(path.join(TMP, 'forge-tickets', 'tk-big.json')));

const justifiedTicket = S.putEntity('tickets', 'tk-justified', { title: 'big but justified', related_files: ['a.js', 'b.js', 'c.js', 'd.js'], sizing_justification: 'atomic rename across the module, cannot be split' });
t('ticket with sizing_justification set has no _sizing_warning stamp', justifiedTicket._sizing_warning === undefined);

const smallTicket = S.putEntity('tickets', 'tk-small', { title: 'small change', related_files: ['a.js', 'b.js'] });
t('ticket with <=3 related_files has no _sizing_warning stamp', smallTicket._sizing_warning === undefined);

const exactlyThreeTicket = S.putEntity('tickets', 'tk-three', { title: 'three files', related_files: ['a.js', 'b.js', 'c.js'] });
t('ticket with exactly 3 related_files (boundary) has no _sizing_warning stamp', exactlyThreeTicket._sizing_warning === undefined);

const nonTicketBig = S.putEntity('artifacts', 'art-big', { related_files: ['a.js', 'b.js', 'c.js', 'd.js', 'e.js'] });
t('non-tickets store is never sizing-linted even with many related_files', nonTicketBig._sizing_warning === undefined);

// 6b) CLI: advisory warning never changes the exit code, and the exact message lands on stderr
const cliBigTicket = run('put', 'tickets', 'tk-cli-big', JSON.stringify({ title: 'cli big', related_files: ['a.js', 'b.js', 'c.js', 'd.js'] }));
t('CLI put with oversized ticket still exits 0 (advisory only)', cliBigTicket.status === 0);
t('CLI put with oversized ticket warns on stderr', /consider splitting/.test(cliBigTicket.stderr));
const cliJustifiedTicket = run('put', 'tickets', 'tk-cli-justified', JSON.stringify({ title: 'cli justified', related_files: ['a.js', 'b.js', 'c.js', 'd.js'], sizing_justification: 'one atomic migration' }));
t('CLI put with sizing_justification exits 0 and warns nothing on stderr', cliJustifiedTicket.status === 0 && !/consider splitting/.test(cliJustifiedTicket.stderr));

// 7) MUTATION-TESTING SURVIVOR PINS (WP3 Spoor C, 2026-07-14) — forge-mutate.cjs found these exact
// boundary/guard weakenings surviving against the pre-existing suite. Each fixture below is chosen so
// the REAL (unmutated) module redacts it correctly, AND the specific mutation (verified by hand-applying
// it to a scratch copy and re-running this suite) causes a genuine leak/bypass. See build-boss's report
// for the exact red-then-restored proof per survivor.

// 7a) secret-pattern MINIMUM-LENGTH boundaries — a mutant that raises a `{N,}`/`{N}` quantifier by one,
// or narrows the digit range inside a pattern's character class, must not let an exact-boundary secret
// through unredacted. Every fixture below sits exactly at (or right at the start of) its pattern's
// stated minimum, so a +1 quantifier OR a narrowed character-class both fail to match it.
const noRaw = (v) => !JSON.stringify(S.redactValue({ v })).includes(v);
t('7a1: OpenAI-style sk- key at the exact 20-char minimum is redacted', noRaw('sk-' + '0'.repeat(20)));
t('7a1b: real sk- key mid-string (after a space) is still redacted (boundary keeps true positives)', noRaw('prefix sk-' + 'A'.repeat(20)));
const wordySlug = 'task-orchestrator-with-a-long-slug-1234567890';
t('7a1c: ordinary word containing "sk-" (task-…) is NOT redacted (boundary-anchor false-positive fix 2026-07-25)', JSON.stringify(S.redactValue({ v: wordySlug })).includes(wordySlug));
t('7a2: Stripe sk_live_ secret at the exact 10-char minimum (with 2-9 digits) is redacted', noRaw('sk_live_' + 'A1b2C3d4E5'));
t('7a3: Stripe rk_live_ restricted key at the exact 10-char minimum is redacted', noRaw('rk_live_' + 'A1b2C3d4E5'));
t('7a4: GitHub ghp_ token at the exact 20-char minimum is redacted', noRaw('ghp_' + 'A1b2C3d4E5F6g7H8i9J0'));
t('7a5: Slack xoxb- token whose first body char is a 2-9 digit is redacted (character-class not narrowed)', noRaw('xoxb-' + '2abc3def456ghij'));
t('7a6: AWS AKIA key at the exact 16-char fixed body length (containing 0 and 9) is redacted', noRaw('AKIA' + '0123456789ABCDEF'));
t('7a7: Google AIza key at the exact 35-char fixed body length starting with 0 is redacted', noRaw('AIza' + '0' + 'S'.repeat(34)));
t('7a8: SendGrid SG. key with BOTH 16-char segments at their exact minimum is redacted', noRaw('SG.' + 'A'.repeat(16) + '.' + 'B'.repeat(16)));
t('7a9: JWT header at the exact 10-char minimum is redacted', noRaw('eyJ' + '0123456789' + '.payloadpart.sigpart'));
t('7a10: db2:// connection-string password (digit-bearing scheme name) is redacted, scheme preserved', (() => {
  const r = S.redactValue({ v: 'db2://user:Secret1@host/db' });
  return !r.v.includes('Secret1') && r.v.includes('db2://user');
})());

// 7b) array-of-strings redaction bypass — if the Array.isArray(v) branch in redactValue() were ever
// disabled, an array whose elements are secrets would fall through to isPlainObject (false for an
// array) and return unchanged, leaking every element verbatim.
const secretInArray = 'sk-' + '1'.repeat(30);
const arrOut = S.redactValue({ items: ['plain-value', secretInArray] });
t('7b1: a secret INSIDE an array value is redacted (not just top-level string values)', !JSON.stringify(arrOut).includes(secretInArray));
t('7b2: a non-secret array element is left untouched', arrOut.items[0] === 'plain-value');

// 7c) belt-and-braces path-containment guard (resolveStoreDir) — the id-shape regex already blocks
// traversal through the normal put/get/list API (see test 2 above), so this guard is unreachable via
// that path by design; it exists as defense-in-depth against a corrupted/dynamically-built STORES map.
// Prove it actually fires by transiently corrupting the exported STORES object (test-only monkeypatch —
// forge-store.cjs itself is never touched), then immediately restoring it.
{
  const originalTicketsDir = S.STORES.tickets;
  S.STORES.tickets = '..' + path.sep + '..' + path.sep + 'escaped-outside';
  let threw = false, guardMsg = '';
  try { S.resolveStoreDir('tickets'); } catch (e) { threw = true; guardMsg = e.message; }
  S.STORES.tickets = originalTicketsDir; // restore immediately, before any other assertion runs
  t('7c1: resolveStoreDir refuses a STORES entry corrupted to escape CLAUDE_DIR (belt-and-braces guard)', threw === true && /escapes \.claude\//.test(guardMsg));
  t('7c2: STORES.tickets is restored to its original value after the probe', S.STORES.tickets === originalTicketsDir);
  t('7c3: the guard restoration did not leave a stray escaped directory on disk', !fs.existsSync(path.resolve(TMP, '..', 'escaped-outside')));
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
