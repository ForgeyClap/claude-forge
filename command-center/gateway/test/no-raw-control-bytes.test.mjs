// WP-CC1 (item 16) — regression test. `gateway/src/missions.mjs` held a raw NUL byte inside a
// string literal (a key separator `a + '<NUL>' + r` in fallbackKey(), present since before this
// work package). Because of that single byte, git's own binary-content heuristic classified the
// WHOLE FILE as binary (`git show`/`git diff` printed "Binary files ... differ" instead of a real,
// reviewable diff) — every future change to that file was invisible to `git show`/code review.
// Fixed by replacing the literal byte with the `\u0000` ESCAPE SEQUENCE (six ASCII characters:
// backslash, u, 0, 0, 0, 0) inside the same single-quoted string — identical runtime value (the
// string still contains one U+0000 code point), but the FILE ON DISK now contains only ordinary
// text bytes. This test guards every source file in the gateway against a repeat: a raw control
// byte (anything below 0x20 other than tab/LF/CR, or a literal NUL) must never reappear in a
// `gateway/src/*.mjs` file — if a NUL (or similar) value is genuinely needed at runtime, it belongs
// in an escape sequence in the SOURCE TEXT, never as a literal byte in the file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, '..', 'src');

// Tab (0x09), LF (0x0A) and CR (0x0D) are ordinary, expected text bytes. Anything else below 0x20,
// or a raw NUL (0x00), is a control byte that has no business appearing literally in JS source text.
function findControlByteOffsets(buffer) {
  const offsets = [];
  for (let i = 0; i < buffer.length; i++) {
    const b = buffer[i];
    if (b === 0x09 || b === 0x0a || b === 0x0d) continue;
    if (b < 0x20 || b === 0x00) offsets.push(i);
  }
  return offsets;
}

function listSrcMjsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSrcMjsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

test('no gateway/src/*.mjs file contains a raw control byte (tab/LF/CR excepted) — a real value like NUL must be an escape sequence in the source text, never a literal byte', () => {
  const files = listSrcMjsFiles(SRC_DIR);
  assert.ok(files.length > 30, 'sanity check: this must actually be scanning the real gateway/src tree');
  const offenders = [];
  for (const file of files) {
    const buf = fs.readFileSync(file);
    const offsets = findControlByteOffsets(buf);
    if (offsets.length > 0) offenders.push({ file: path.relative(SRC_DIR, file), count: offsets.length, firstOffset: offsets[0] });
  }
  assert.deepEqual(offenders, [], 'every offending file must be free of raw control bytes: ' + JSON.stringify(offenders));
});

test('regression: missions.mjs specifically is git-diffable text, not a NUL-containing binary blob', () => {
  const missionsPath = path.join(SRC_DIR, 'missions.mjs');
  const buf = fs.readFileSync(missionsPath);
  assert.equal(buf.includes(0x00), false, 'missions.mjs must never contain a raw NUL byte again');
  const text = buf.toString('utf8');
  assert.match(text, /\\u0000/, 'the separator must survive as the escape sequence \\u0000, not disappear entirely');
});
