import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Spraakmemo → tekst. Er is GEEN ingebouwde spraakherkenning: we gebruiken een
// lokale tool als die aanwezig is, en zeggen het eerlijk als dat niet zo is.
// Nooit doen alsof audio gelezen is terwijl dat niet kon.
const CANDIDATES = [
  { bin: 'whisper', args: (file, out) => [file, '--model', 'base', '--output_format', 'txt', '--output_dir', out, '--language', 'nl'] },
  { bin: 'whisper-cli', args: (file, out) => [file, '--output-txt', '--output-dir', out] },
  { bin: 'faster-whisper', args: (file, out) => [file, '--output_dir', out, '--output_format', 'txt'] },
];

function which(bin) {
  const dirs = String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, bin + ext);
      try {
        if (fs.existsSync(full)) return full;
      } catch {
        // onleesbare PATH-map — overslaan
      }
    }
  }
  return null;
}

export function findTranscriber() {
  if (process.env.TRANSCRIBE_BIN && fs.existsSync(process.env.TRANSCRIBE_BIN)) {
    return { bin: process.env.TRANSCRIBE_BIN, args: CANDIDATES[0].args };
  }
  for (const cand of CANDIDATES) {
    const found = which(cand.bin);
    if (found) return { bin: found, args: cand.args };
  }
  return null;
}

export async function transcribe(file, { timeoutMs = 5 * 60 * 1000 } = {}) {
  const tool = findTranscriber();
  if (!tool) return { ok: false, reason: 'geen lokale spraak-naar-tekst-tool gevonden' };
  const outDir = path.dirname(file);
  return new Promise((resolve) => {
    const child = spawn(tool.bin, tool.args(file, outDir), { windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, reason: 'transcriptie duurde te lang' });
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: `transcriptie mislukt (${String(err?.message ?? err).slice(0, 60)})` });
    });
    child.on('close', () => {
      clearTimeout(timer);
      const txt = path.join(outDir, `${path.basename(file, path.extname(file))}.txt`);
      try {
        const text = fs.readFileSync(txt, 'utf8').trim();
        resolve(text ? { ok: true, text, file: txt } : { ok: false, reason: 'transcriptie leverde geen tekst' });
      } catch {
        resolve({ ok: false, reason: 'transcriptiebestand niet gevonden' });
      }
    });
  });
}
