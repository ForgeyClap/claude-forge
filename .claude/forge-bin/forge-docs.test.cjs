#!/usr/bin/env node
'use strict';
// forge-docs.test.cjs — real tests for the zero-dependency office-document generator (2026-07-19, H1).
// Every fixture writes into a fresh os.tmpdir() dir — this file never touches real project output.
// The OOXML formats are verified by UNZIPPING the produced bytes ourselves (zlib.inflateRawSync + a
// hand-parsed central directory, mirroring exactly what forge-docs.cjs::buildZip wrote) — never by trusting
// an external unzip tool.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const assert = require('assert');
const { spawnSync } = require('child_process');
const docs = require('./forge-docs.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

function freshDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }

// ---------------------------------------------------------------------------
// unzip() — an independent reader of the ZIP bytes buildZip() produced, walking the SAME structures
// (central directory -> local header -> compressed data) so a corrupted CRC/offset in the writer shows up
// as a real read-back failure here, not a tautology.
// ---------------------------------------------------------------------------
function unzip(buf) {
  assert.ok(buf.length >= 22, 'buffer too small to hold an EOCD record');
  // EOCD has no comment in anything buildZip() writes, so it is exactly the last 22 bytes.
  const eocd = buf.subarray(buf.length - 22);
  assert.strictEqual(eocd.readUInt32LE(0), 0x06054b50, 'EOCD signature must be present at buf.length-22');
  const totalEntries = eocd.readUInt16LE(10);
  const centralSize = eocd.readUInt32LE(12);
  const centralOffset = eocd.readUInt32LE(16);
  assert.strictEqual(centralOffset + centralSize + 22, buf.length, 'central directory + EOCD must exactly reach EOF');

  const entries = {};
  let p = centralOffset;
  for (let i = 0; i < totalEntries; i++) {
    assert.strictEqual(buf.readUInt32LE(p), 0x02014b50, 'central directory entry signature at ' + p);
    const method = buf.readUInt16LE(p + 10);
    const crcExpected = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    assert.strictEqual(buf.readUInt32LE(localOffset), 0x04034b50, 'local file header signature for ' + name);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const compData = buf.subarray(dataStart, dataStart + compSize);
    const data = method === 8 ? zlib.inflateRawSync(compData) : Buffer.from(compData);
    assert.strictEqual(data.length, uncompSize, 'decompressed size must match the stored uncompressed size for ' + name);
    const crcActual = crc32Of(data);
    assert.strictEqual(crcActual, crcExpected, 'CRC32 of decompressed data must match the stored CRC32 for ' + name);
    entries[name] = data;
  }
  return entries;
}
// independent CRC32 (re-derived here, not required from forge-docs.cjs) so unzip()'s own integrity check
// does not silently trust the module-under-test's crc32() implementation.
function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); table[n] = c >>> 0; }
  return table;
}
const CRC_TABLE = makeCrcTable();
function crc32Of(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

const CLI = path.join(__dirname, 'forge-docs.cjs');
// `env` is optional — omitted, spawnSync defaults to inheriting process.env (unchanged behavior for every
// call site below that doesn't pass one). Only the `--run` test passes an override (see GAP 2 fix below).
function runCLI(argv, env) { return spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8', env: env || process.env }); }

console.log('forge-docs tests (zero-dependency office-document generator)');

// ---------------------------------------------------------------------------
// 1) .docx
// ---------------------------------------------------------------------------
console.log('\n1) .docx');

t('docx() returns a Buffer starting with the ZIP magic PK\\x03\\x04', () => {
  const buf = docs.docx({ title: 'My Report', sections: [{ heading: 'Intro', paragraphs: ['Hello world.'] }] });
  assert.ok(Buffer.isBuffer(buf));
  assert.strictEqual(buf.subarray(0, 4).toString('latin1'), 'PK\x03\x04');
});

t('docx() ZIP contains [Content_Types].xml + word/document.xml, and the text survives (escaped) in the main part', () => {
  const buf = docs.docx({ title: 'Quarterly <Report> & "Summary"', sections: [{ heading: 'Risks', paragraphs: ["Owner's approval pending."] }] });
  const parts = unzip(buf);
  assert.ok(parts['[Content_Types].xml'], '[Content_Types].xml must be present');
  assert.ok(parts['_rels/.rels'], '_rels/.rels must be present');
  assert.ok(parts['word/document.xml'], 'word/document.xml (the main part) must be present');
  const ct = parts['[Content_Types].xml'].toString('utf8');
  assert.ok(ct.includes('/word/document.xml'), 'Content_Types must declare the main part');
  const doc = parts['word/document.xml'].toString('utf8');
  assert.ok(doc.includes('Quarterly &lt;Report&gt; &amp; &quot;Summary&quot;'), 'title must be present, XML-escaped');
  assert.ok(doc.includes('Risks'), 'heading text must be present');
  assert.ok(doc.includes('Owner&apos;s approval pending.'), 'paragraph text must be present, XML-escaped');
});

t('docx() writes to opts.out when given', () => {
  const dir = freshDir('forge-docs-docx-out');
  const outPath = path.join(dir, 'report.docx');
  const buf = docs.docx({ title: 'Out Test', sections: [] }, { out: outPath });
  assert.ok(fs.existsSync(outPath));
  const onDisk = fs.readFileSync(outPath);
  assert.deepStrictEqual(onDisk, buf, 'the written file must be byte-identical to the returned Buffer');
});

// ---------------------------------------------------------------------------
// 2) .xlsx
// ---------------------------------------------------------------------------
console.log('\n2) .xlsx');

t('xlsx() returns a Buffer starting with PK\\x03\\x04 and contains workbook + sheet parts', () => {
  const buf = docs.xlsx({ sheets: [{ name: 'Budget', rows: [['Item', 'Cost'], ['Widgets & Gadgets', 42]] }] });
  assert.strictEqual(buf.subarray(0, 4).toString('latin1'), 'PK\x03\x04');
  const parts = unzip(buf);
  assert.ok(parts['xl/workbook.xml'], 'xl/workbook.xml (the main part) must be present');
  assert.ok(parts['xl/worksheets/sheet1.xml'], 'xl/worksheets/sheet1.xml must be present');
  const wb = parts['xl/workbook.xml'].toString('utf8');
  assert.ok(wb.includes('Budget'), 'sheet name must appear in workbook.xml');
  const sheet = parts['xl/worksheets/sheet1.xml'].toString('utf8');
  assert.ok(sheet.includes('Widgets &amp; Gadgets'), 'text cell must be present, XML-escaped');
  assert.ok(sheet.includes('<v>42</v>'), 'numeric cell must be present as a bare numeric value');
});

t('xlsx() with multiple sheets writes sheet1.xml and sheet2.xml, each declared in Content_Types', () => {
  const buf = docs.xlsx({ sheets: [{ name: 'A', rows: [['x']] }, { name: 'B', rows: [['y']] }] });
  const parts = unzip(buf);
  assert.ok(parts['xl/worksheets/sheet1.xml']);
  assert.ok(parts['xl/worksheets/sheet2.xml']);
  const ct = parts['[Content_Types].xml'].toString('utf8');
  assert.ok(ct.includes('/xl/worksheets/sheet1.xml') && ct.includes('/xl/worksheets/sheet2.xml'));
  assert.ok(parts['xl/worksheets/sheet1.xml'].toString('utf8').includes('>x<'));
  assert.ok(parts['xl/worksheets/sheet2.xml'].toString('utf8').includes('>y<'));
});

t('xlsx() with no input defaults to one empty Sheet1 rather than throwing', () => {
  const buf = docs.xlsx({});
  const parts = unzip(buf);
  assert.ok(parts['xl/worksheets/sheet1.xml']);
});

// ---------------------------------------------------------------------------
// 3) .pptx
// ---------------------------------------------------------------------------
console.log('\n3) .pptx');

t('pptx() returns a Buffer starting with PK\\x03\\x04 and contains the full master/layout/slide/theme chain', () => {
  const buf = docs.pptx({ slides: [{ title: 'Welcome', bullets: ['Point one', 'Point <two> & more'] }] });
  assert.strictEqual(buf.subarray(0, 4).toString('latin1'), 'PK\x03\x04');
  const parts = unzip(buf);
  for (const name of [
    '[Content_Types].xml', '_rels/.rels', 'ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels',
    'ppt/slideMasters/slideMaster1.xml', 'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    'ppt/slideLayouts/slideLayout1.xml', 'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
    'ppt/theme/theme1.xml', 'ppt/slides/slide1.xml', 'ppt/slides/_rels/slide1.xml.rels',
  ]) assert.ok(parts[name], 'required part missing: ' + name);

  const slide = parts['ppt/slides/slide1.xml'].toString('utf8');
  assert.ok(slide.includes('Welcome'), 'slide title must be present');
  assert.ok(slide.includes('Point one'), 'first bullet must be present');
  assert.ok(slide.includes('Point &lt;two&gt; &amp; more'), 'second bullet must be present, XML-escaped');
});

t('pptx() with multiple slides writes slide1.xml and slide2.xml, both linked to slideLayout1', () => {
  const buf = docs.pptx({ slides: [{ title: 'One', bullets: [] }, { title: 'Two', bullets: [] }] });
  const parts = unzip(buf);
  assert.ok(parts['ppt/slides/slide1.xml'].toString('utf8').includes('One'));
  assert.ok(parts['ppt/slides/slide2.xml'].toString('utf8').includes('Two'));
  const rels1 = parts['ppt/slides/_rels/slide1.xml.rels'].toString('utf8');
  const rels2 = parts['ppt/slides/_rels/slide2.xml.rels'].toString('utf8');
  assert.ok(rels1.includes('slideLayout1.xml') && rels2.includes('slideLayout1.xml'));
  const pres = parts['ppt/presentation.xml'].toString('utf8');
  assert.ok((pres.match(/<p:sldId /g) || []).length === 2, 'presentation.xml must list both slides');
});

// ---------------------------------------------------------------------------
// 4) .pdf
// ---------------------------------------------------------------------------
console.log('\n4) .pdf');

t('pdf() returns a Buffer starting with %PDF-1.4 and containing a valid xref/trailer', () => {
  const buf = docs.pdf({ title: 'Findings', blocks: [{ type: 'h1', text: 'Summary' }, { type: 'p', text: 'Everything looks fine (mostly).' }] });
  assert.strictEqual(buf.subarray(0, 8).toString('latin1'), '%PDF-1.4');
  const text = buf.toString('latin1');
  assert.ok(/\nxref\n/.test(text), 'file must contain an xref table');
  assert.ok(/trailer\n<< \/Size \d+ \/Root 1 0 R >>/.test(text), 'file must contain a trailer with /Size and /Root');
  assert.ok(/startxref\n\d+\n%%EOF$/.test(text), 'file must end with startxref + %%EOF');
});

t('pdf() content stream literally contains the title and paragraph text', () => {
  const buf = docs.pdf({ title: 'Findings Report', blocks: [{ type: 'p', text: 'A specific unique sentence for this test.' }] });
  const text = buf.toString('latin1');
  assert.ok(text.includes('Findings Report'), 'title text must appear in the content stream');
  assert.ok(text.includes('A specific unique sentence for this test.'), 'paragraph text must appear in the content stream');
});

t('pdf() escapes parentheses and backslashes so the PDF string literal stays well-formed', () => {
  const buf = docs.pdf({ title: 'T', blocks: [{ type: 'p', text: 'A (parenthetical) and a \\backslash\\.' }] });
  const text = buf.toString('latin1');
  assert.ok(text.includes('A \\(parenthetical\\) and a \\\\backslash\\\\.'), 'parens/backslashes must be escaped per the PDF spec');
});

t('pdf() auto-paginates long content into more than one page', () => {
  const blocks = [];
  for (let i = 0; i < 120; i++) blocks.push({ type: 'p', text: 'Line number ' + i + ' of a deliberately long report body.' });
  const buf = docs.pdf({ title: 'Long Report', blocks });
  const text = buf.toString('latin1');
  const pageCount = (text.match(/\/Type \/Page(?!s)/g) || []).length;
  assert.ok(pageCount >= 2, 'a long document must auto-paginate to 2+ pages, got ' + pageCount);
  assert.ok(text.includes('Line number 0 '), 'first line must be present');
  assert.ok(text.includes('Line number 119 '), 'last line must be present');
});

t('pdf() writes to opts.out when given', () => {
  const dir = freshDir('forge-docs-pdf-out');
  const outPath = path.join(dir, 'report.pdf');
  const buf = docs.pdf({ title: 'Out Test', blocks: [{ type: 'p', text: 'x' }] }, { out: outPath });
  assert.ok(fs.existsSync(outPath));
  assert.deepStrictEqual(fs.readFileSync(outPath), buf);
});

// ---------------------------------------------------------------------------
// 5) internal helpers
// ---------------------------------------------------------------------------
console.log('\n5) internal helpers');

t('crc32() matches a known reference vector ("123456789" -> 0xCBF43926, the standard CRC-32/ISO-HDLC check value)', () => {
  assert.strictEqual(docs.crc32(Buffer.from('123456789', 'ascii')), 0xCBF43926);
});

t('colName() maps 0-based column indices to Excel letters, including the AA rollover', () => {
  assert.strictEqual(docs.colName(0), 'A');
  assert.strictEqual(docs.colName(25), 'Z');
  assert.strictEqual(docs.colName(26), 'AA');
  assert.strictEqual(docs.colName(27), 'AB');
});

t('escapeXml() escapes all five XML special characters', () => {
  assert.strictEqual(docs.escapeXml(`<a>&"'`), '&lt;a&gt;&amp;&quot;&apos;');
});

t('wrapText() never returns a line and always covers the input words in order', () => {
  const lines = docs.wrapText('the quick brown fox jumps over the lazy dog repeatedly and often', 12, 100);
  assert.ok(lines.length >= 1);
  assert.strictEqual(lines.join(' '), 'the quick brown fox jumps over the lazy dog repeatedly and often');
});

t('buildZip() round-trips a simple store-method entry byte-for-byte', () => {
  const buf = docs.buildZip([{ name: 'hello.txt', data: 'hello world', method: 'store' }]);
  const parts = unzip(buf);
  assert.strictEqual(parts['hello.txt'].toString('utf8'), 'hello world');
});

// ---------------------------------------------------------------------------
// 6) CLI
// ---------------------------------------------------------------------------
console.log('\n6) CLI');

t('CLI --help exits 0', () => {
  const r = runCLI(['--help']);
  assert.strictEqual(r.status, 0);
});

t('CLI with an unknown format command exits 2', () => {
  const r = runCLI(['docz', '--in', 'x.json', '--out', 'y.docz']);
  assert.strictEqual(r.status, 2);
});

t('CLI docx --in <file> --out <file> writes a real, unzippable .docx', () => {
  const dir = freshDir('forge-docs-cli-docx');
  const inPath = path.join(dir, 'in.json');
  const outPath = path.join(dir, 'out.docx');
  fs.writeFileSync(inPath, JSON.stringify({ title: 'CLI Doc', sections: [{ heading: 'H', paragraphs: ['p1'] }] }), 'utf8');
  const r = runCLI(['docx', '--in', inPath, '--out', outPath]);
  assert.strictEqual(r.status, 0, r.stderr);
  const onDisk = fs.readFileSync(outPath);
  assert.strictEqual(onDisk.subarray(0, 4).toString('latin1'), 'PK\x03\x04');
  const parts = unzip(onDisk);
  assert.ok(parts['word/document.xml'].toString('utf8').includes('CLI Doc'));
});

t('CLI xlsx --in <file> --out <file> writes a real, unzippable .xlsx', () => {
  const dir = freshDir('forge-docs-cli-xlsx');
  const inPath = path.join(dir, 'in.json');
  const outPath = path.join(dir, 'out.xlsx');
  fs.writeFileSync(inPath, JSON.stringify({ sheets: [{ name: 'S1', rows: [['a', 1]] }] }), 'utf8');
  const r = runCLI(['xlsx', '--in', inPath, '--out', outPath]);
  assert.strictEqual(r.status, 0, r.stderr);
  const parts = unzip(fs.readFileSync(outPath));
  assert.ok(parts['xl/worksheets/sheet1.xml']);
});

t('CLI pptx --in <file> --out <file> writes a real, unzippable .pptx', () => {
  const dir = freshDir('forge-docs-cli-pptx');
  const inPath = path.join(dir, 'in.json');
  const outPath = path.join(dir, 'out.pptx');
  fs.writeFileSync(inPath, JSON.stringify({ slides: [{ title: 'S', bullets: ['b1'] }] }), 'utf8');
  const r = runCLI(['pptx', '--in', inPath, '--out', outPath]);
  assert.strictEqual(r.status, 0, r.stderr);
  const parts = unzip(fs.readFileSync(outPath));
  assert.ok(parts['ppt/slides/slide1.xml'].toString('utf8').includes('b1'));
});

t('CLI pdf --in <file> --out <file> writes a real, valid .pdf', () => {
  const dir = freshDir('forge-docs-cli-pdf');
  const inPath = path.join(dir, 'in.json');
  const outPath = path.join(dir, 'out.pdf');
  fs.writeFileSync(inPath, JSON.stringify({ title: 'CLI PDF', blocks: [{ type: 'p', text: 'cli text' }] }), 'utf8');
  const r = runCLI(['pdf', '--in', inPath, '--out', outPath]);
  assert.strictEqual(r.status, 0, r.stderr);
  const onDisk = fs.readFileSync(outPath);
  assert.strictEqual(onDisk.subarray(0, 8).toString('latin1'), '%PDF-1.4');
  assert.ok(onDisk.toString('latin1').includes('cli text'));
});

t('CLI missing --in/--out exits 2 with a usage message', () => {
  const r = runCLI(['docx']);
  assert.strictEqual(r.status, 2);
  assert.ok(/--in and --out are both required/.test(r.stderr));
});

t('CLI --in pointing at a non-existent file exits 2', () => {
  const dir = freshDir('forge-docs-cli-missing');
  const r = runCLI(['docx', '--in', path.join(dir, 'nope.json'), '--out', path.join(dir, 'out.docx')]);
  assert.strictEqual(r.status, 2);
});

t('CLI --in pointing at invalid JSON exits 2 with a clear message', () => {
  const dir = freshDir('forge-docs-cli-badjson');
  const inPath = path.join(dir, 'bad.json');
  fs.writeFileSync(inPath, '{not valid json', 'utf8');
  const r = runCLI(['docx', '--in', inPath, '--out', path.join(dir, 'out.docx')]);
  assert.strictEqual(r.status, 2);
  assert.ok(/invalid JSON/.test(r.stderr));
});

t('CLI --run logs a real doc_generated event into a hermetic fixture project, never this repo\'s real forge-runs/ (GAP 2 fix, 2026-07-22 — this test used to spawn the CLI with no root override, which appended a real events.jsonl line into THIS repo\'s .claude/forge-runs/nonexistent-run-id/ on every test run; forge-docs.cjs\'s logDocEvent() resolves its log-event.cjs path via forge-store.cjs\'s CLAUDE_DIR, which honors FORGE_STORE_ROOT — same hermetic idiom as forge-echo.test.cjs\'s makeFixtureProject()/forge-promptcheck.test.cjs\'s case8)', () => {
  const dir = freshDir('forge-docs-cli-run');
  const inPath = path.join(dir, 'in.json');
  const outPath = path.join(dir, 'out.docx');
  fs.writeFileSync(inPath, JSON.stringify({ title: 'Run Test', sections: [] }), 'utf8');

  // hermetic fixture project: a throwaway .claude/forge-dashboard/log-event.cjs (a real copy of the shipped
  // file) under a fresh os.mkdtemp root. Setting FORGE_STORE_ROOT to this fixture's .claude/ for the spawned
  // CLI process only (not the parent test process) makes forge-store.cjs's CLAUDE_DIR — and therefore
  // forge-docs.cjs's logDocEvent() log-event.cjs path — resolve entirely inside the fixture.
  const fixtureRoot = freshDir('forge-docs-cli-run-fixture');
  const fixtureClaudeDir = path.join(fixtureRoot, '.claude');
  const fixtureDashDir = path.join(fixtureClaudeDir, 'forge-dashboard');
  fs.mkdirSync(fixtureDashDir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs'), path.join(fixtureDashDir, 'log-event.cjs'));

  const realRunDir = path.join(__dirname, '..', 'forge-runs', 'nonexistent-run-id');
  const realDirExistedBefore = fs.existsSync(realRunDir);

  const runEnv = Object.assign({}, process.env, { FORGE_STORE_ROOT: fixtureClaudeDir });
  const r = runCLI(['docx', '--in', inPath, '--out', outPath, '--run', 'nonexistent-run-id'], runEnv);
  assert.strictEqual(r.status, 0, 'a log-event warning must never fail doc generation itself: ' + r.stderr);
  assert.ok(fs.existsSync(outPath));

  const fixtureEventsFile = path.join(fixtureClaudeDir, 'forge-runs', 'nonexistent-run-id', 'events.jsonl');
  assert.ok(fs.existsSync(fixtureEventsFile), 'expected the doc_generated event inside the hermetic fixture at ' + fixtureEventsFile);
  const fixtureEvents = fs.readFileSync(fixtureEventsFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(fixtureEvents.some((e) => e.event_type === 'doc_generated'), 'expected a doc_generated event in the fixture events.jsonl');
  // doc_generated is now a registered KNOWN_EVENT_TYPE (WAVE H) — the real log-event.cjs copy must accept it
  // cleanly, never flag it unknown.
  assert.ok(fixtureEvents.every((e) => !e._forge_verify || !e._forge_verify.event_type_unknown), 'doc_generated must be a KNOWN event_type, never flagged unknown');

  // isolation proof: this test must never create (or append to) the REAL project's forge-runs/nonexistent-run-id
  assert.strictEqual(fs.existsSync(realRunDir), realDirExistedBefore, 'CLI --run must never write into the real project\'s .claude/forge-runs/ — use the FORGE_STORE_ROOT fixture instead');
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
