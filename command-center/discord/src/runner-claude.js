import { spawn } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { redactSecrets } from './audit.js';

// Echte runner: headless Claude Code (`claude -p`) per project, met
// gespreksgeheugen (--resume via SessionStore), optionele Forge-modus
// (prompt door het Forge-systeem laten afhandelen) en per-project
// permissiemodus. Prompt gaat via STDIN — nooit via de command line.

import { buildSystemPrompt } from './mobile-profile.js';
import { ensureProjectSettings } from './write-boundary.js';

// Pure helpers (apart geëxporteerd zodat tests ze zonder subprocess kunnen checken).
// Toegestane modellen (alias → CLI-waarde). Onbekende waarden worden geweigerd.
export const MODELS = {
  fable: 'claude-fable-5',
  opus: 'claude-opus-5',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5-20251001',
};
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// Toegestane permissiemodi (allowlist). Een waarde uit een state-bestand of uit
// de owner-verhoging mag NOOIT als vrije tekst achter --permission-mode landen.
export const PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];
export const SESSION_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

export function buildArgs({
  sessionId = null,
  permissionMode = null,
  extraArgs = [],
  systemPrompt = null,
  model = null,
  effort = null,
  stream = false,
  settingsFile = null,
} = {}) {
  const args = stream
    ? ['-p', '--output-format', 'stream-json', '--verbose', ...extraArgs]
    : ['-p', '--output-format', 'json', ...extraArgs];
  // Sessie-ID's komen uit een state-bestand: alleen een veilig formaat toestaan.
  if (sessionId && SESSION_ID_RE.test(sessionId)) args.push('--resume', sessionId);
  if (permissionMode && permissionMode !== 'default' && PERMISSION_MODES.includes(permissionMode)) {
    args.push('--permission-mode', permissionMode);
  }
  if (model && MODELS[model]) args.push('--model', MODELS[model]);
  if (effort && EFFORTS.includes(effort)) args.push('--effort', effort);
  // Schrijf-grens: deny-regels buiten de projectmap (zie write-boundary.js).
  if (settingsFile) args.push('--settings', settingsFile);
  // Mobiel-bewuste huisregels: alleen bij een VERSE sessie meesturen; bij --resume
  // zit de instructie al in de sessiecontext.
  if (systemPrompt && !sessionId) args.push('--append-system-prompt', systemPrompt);
  return args;
}

export function buildPrompt({ content, forgeMode = false, attachmentInfo = '' }) {
  const base = forgeMode ? `/forge ${content}` : content;
  return attachmentInfo ? `${base}\n${attachmentInfo}` : base;
}

// Vertaalt een stream-json-regel naar een korte, mobiel-leesbare voortgangsregel.
// Retourneert null als de regel niets interessants bevat.
export function progressFromEvent(evt) {
  if (!evt || evt.type !== 'assistant') return null;
  const blocks = evt.message?.content ?? [];
  for (const b of blocks) {
    if (b.type !== 'tool_use') continue;
    const i = b.input ?? {};
    const short = (s, n = 60) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);
    switch (b.name) {
      case 'Read': return `leest ${short(i.file_path?.split(/[\\/]/).pop())}`;
      case 'Write': return `schrijft ${short(i.file_path?.split(/[\\/]/).pop())}`;
      case 'Edit': return `past ${short(i.file_path?.split(/[\\/]/).pop())} aan`;
      case 'Bash': return `voert uit: ${short(i.description || i.command, 50)}`;
      case 'Glob':
      case 'Grep': return `zoekt: ${short(i.pattern, 40)}`;
      case 'WebSearch':
      case 'WebFetch': return `zoekt online: ${short(i.query || i.url, 40)}`;
      case 'Task':
      case 'Agent': return `start subagent: ${short(i.description, 40)}`;
      default: return `gebruikt ${b.name}`;
    }
  }
  return null;
}

// Uit een stream-json-uitvoer het eindresultaat halen (laatste `result`-event).
export function parseStream(stdout) {
  let last = null;
  for (const line of String(stdout).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const evt = JSON.parse(trimmed);
      if (evt.type === 'result') last = evt;
    } catch {
      // onvolledige regel — negeren
    }
  }
  return last ? parseClaudeJson(JSON.stringify(last)) : { answer: '', sessionId: null };
}

export function parseClaudeJson(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    return {
      answer: parsed.result ?? parsed.answer ?? String(stdout).trim(),
      sessionId: parsed.session_id ?? null,
      costUsd: parsed.total_cost_usd ?? null,
      durationMs: parsed.duration_ms ?? null,
      numTurns: parsed.num_turns ?? null,
      usage: parsed.usage ?? null,
      isError: parsed.is_error ?? false,
    };
  } catch {
    return { answer: String(stdout).trim(), sessionId: null, costUsd: null, isError: false };
  }
}

/** BROKER-ATTEST v2 (Codex r5 #30-rest, versioned refactor 2026-08-07).
 *  v2: de gateway attesteert bij de servicestart niet alleen het GERESOLVEDE pad maar ook de
 *  FILE-IDENTITEIT van het doel (size + mtimeMs + ino) via env CLAUDE_CLI_ATTEST. De runner
 *  herverifieert die identiteit bij ELKE spawn — een binary die na de attest wordt vervangen of een
 *  link die wordt omgelegd, wordt op het spawn-moment gedetecteerd en hard geweigerd (geen fallback).
 *  v1 (alleen CLAUDE_CLI_PATH) blijft tijdens de gefaseerde migratie werken met de bestaande
 *  realpath-validatie + een deprecatiewaarschuwing. CLI-contracten ongewijzigd. */
export function verifyCliAttest(attest) {
  if (!attest || attest.v !== 2 || typeof attest.path !== 'string') return { ok: false, reason: 'attest ontbreekt of heeft geen v2-vorm' };
  if (!path.isAbsolute(attest.path)) return { ok: false, reason: 'attest-pad is niet absoluut: ' + attest.path };
  if (typeof attest.sha256 !== 'string' || attest.sha256.length !== 64) return { ok: false, reason: 'attest mist een sha256-contentdigest (r6 #5)' };
  let st;
  try { st = fs.statSync(attest.path); } catch (e) { return { ok: false, reason: 'attest-doel onleesbaar: ' + e.message }; }
  if (!st.isFile()) return { ok: false, reason: 'attest-doel is geen regulier bestand' };
  if (st.size !== attest.size || Math.floor(st.mtimeMs) !== Math.floor(attest.mtime_ms)) {
    return { ok: false, reason: 'CLI-binary veranderd sinds de attest (size ' + attest.size + '->' + st.size + ', mtime ' + Math.floor(attest.mtime_ms) + '->' + Math.floor(st.mtimeMs) + ') — spawn geweigerd; herstart de gateway voor een verse attest' };
  }
  /** r6 #5: size+mtime is geen identiteit (opvulbaar + terugzetbaar) — de CONTENT-digest is dat wel.
   *  De hash-kost per spawn (een claude-turn duurt seconden-minuten) is een bewuste, kleine prijs. */
  let digest;
  try { digest = crypto.createHash('sha256').update(fs.readFileSync(attest.path)).digest('hex'); }
  catch (e) { return { ok: false, reason: 'attest-doel niet hashbaar: ' + e.message }; }
  if (digest !== attest.sha256) {
    return { ok: false, reason: 'CLI-binary CONTENT gewijzigd sinds de attest (sha256-mismatch) — spawn geweigerd; herstart de gateway voor een verse attest' };
  }
  return { ok: true, path: attest.path };
}
/** r6 #6: een AANWEZIG maar corrupt/onbekend-versie-attest is een fout, GEEN stille v1-terugval —
 *  het downgrade-pad zou het hele attest-mechanisme uitschakelbaar maken. */
export function readCliAttestFromEnv() {
  const raw = process.env.CLAUDE_CLI_ATTEST;
  // r6b #3: alleen een ECHT afwezige variabele is 'absent'. Een aanwezige lege/whitespace waarde
  // ('CLAUDE_CLI_ATTEST=') is een kapot attest en moet hard falen — anders schakelt een lege string
  // de content-attest uit en glijdt de runner terug naar het zwakkere v1-pad.
  if (raw === undefined) return { state: 'absent', attest: null };
  if (String(raw).trim() === '') return { state: 'invalid', attest: null };
  try { const a = JSON.parse(raw); return (a && a.v === 2) ? { state: 'v2', attest: a } : { state: 'invalid', attest: null }; }
  catch { return { state: 'invalid', attest: null }; }
}
function requireBrokeredCliPath() {
  const env = readCliAttestFromEnv();
  if (env.state === 'invalid') throw new Error('CLAUDE_CLI_ATTEST is aanwezig maar corrupt/onbekende versie — dat is een fout, geen v1-terugval (r6 #6); herstart de gateway');
  if (env.state === 'v2') {
    const v = verifyCliAttest(env.attest);
    if (!v.ok) throw new Error('CLAUDE_CLI_ATTEST (v2) faalt bij constructie: ' + v.reason);
    return { path: v.path, attest: env.attest, protocol: 'v2' };
  }
  const p = process.env.CLAUDE_CLI_PATH;
  if (!p) throw new Error('RUNNER=claude vereist een door de gateway gebrokerd CLAUDE_CLI_ATTEST (v2) of CLAUDE_CLI_PATH (v1, deprecated) — start de bot via de gateway; een kale PATH-lookup is verwijderd (Codex r4 #14)');
  if (!path.isAbsolute(p)) throw new Error('CLAUDE_CLI_PATH moet een ABSOLUUT pad zijn, kreeg: ' + p);
  // v1-pad (r5 #30): resolve symlinks/junctions naar het ECHTE doel en spawn dat.
  let real;
  try { real = fs.realpathSync.native(p); } catch (e) { throw new Error('CLAUDE_CLI_PATH bestaat niet of is niet resolvebaar: ' + p + ' (' + e.message + ')'); }
  if (!fs.existsSync(real)) throw new Error('CLAUDE_CLI_PATH resolvet naar een niet-bestaand doel: ' + real);
  console.error('[runner-claude] DEPRECATED: v1-broker (CLAUDE_CLI_PATH zonder attest) — de gateway hoort CLAUDE_CLI_ATTEST v2 mee te geven; per-spawn identiteitsverificatie is in v1 niet beschikbaar');
  return { path: real, attest: null, protocol: 'v1' };
}

export function createClaudeRunner({
  // AUDIT G8.2 (2026-08-06) + Codex r4 #14 (2026-08-07): de bot spawnde 'claude' via kale PATH-lookup
  // en viel bij ENOENT terug op ongevalideerd CLAUDE_BIN — een PATH/cwd-shadow werd dan alsnog
  // uitgevoerd. De broker faalt nu GESLOTEN: zonder expliciete claudePath-parameter (een bewuste
  // keuze van de aanroeper, bv. een test) is het door de gateway gebrokerde CLAUDE_CLI_PATH verplicht,
  // absoluut en bestaand — anders weigert de constructie. Er bestaat geen kale-'claude'-fallback meer.
  claudePath = null,
  cwd = process.cwd(),
  resolveProject = null, // (item) => { path, forgeMode, permissionMode } | null
  sessionStore = null,
  extraArgs = [],
  onProgress = null, // (item, tekst) => void — live voortgang tijdens lange runs
  stateDir = null,
  projectMemory = null,
  timeoutMs = (Number.parseInt(process.env.RUNNER_TIMEOUT_MIN ?? '30', 10) || 30) * 60 * 1000,
} = {}) {
  const stream = typeof onProgress === 'function';
  // r6 #7: het brokerprotocol wordt EENMALIG bij constructie gepind in deze closure — een latere
  // verwijdering/corruptie van de env kan de per-spawn verificatie niet meer uitschakelen.
  const broker = claudePath !== null
    ? { path: claudePath, attest: null, protocol: 'explicit' }
    : requireBrokeredCliPath();

  function runOnce({ item, signal, sessionId, claudeBin = null }) {
    return new Promise((resolve, reject) => {
      const project = resolveProject?.(item) ?? {};
      const bin = claudeBin ?? broker.path;
      const args = buildArgs({
        sessionId,
        permissionMode: project.permissionMode ?? null,
        extraArgs,
        systemPrompt: buildSystemPrompt({
          forgeMode: project.forgeMode ?? false,
          history: projectMemory?.summary(item.projectId) ?? '',
        }),
        model: project.model ?? null,
        effort: project.effort ?? null,
        stream,
        settingsFile: project.path
          ? ensureProjectSettings(project.path, { botDir: cwd, stateDir })
          : null,
      });
      const prompt = buildPrompt({
        content: item.content,
        forgeMode: project.forgeMode ?? false,
        attachmentInfo: item.attachmentInfo ?? '',
      });
      // claude is hier een echte .exe → direct spawnen (geen shell). Alleen als
      // dat niet lukt (bv. .cmd-shim op een andere machine) via shell proberen.
      // NOOIT shell:true — Node escapet dan niets en plakt argumenten aan elkaar
      // tot één cmd.exe-regel (command-injectie via bv. een sessie-ID).
      /** r5 #30-rest · r6 #7/#8: per-SPAWN herverificatie van de GEPINDE attest, DIRECT voor de
       *  spawn-aanroep (na args/prompt/settings-opbouw) — het venster tussen check en exec is daarmee
       *  minimaal, en een gewiste/gecorrumpeerde env na constructie schakelt niets uit. */
      if (broker.protocol === 'v2' && claudeBin === null) {
        const v = verifyCliAttest(broker.attest);
        if (!v.ok) { reject(new Error('spawn geweigerd (attest v2): ' + v.reason)); return; }
      }
      const child = spawn(bin, args, {
        cwd: project.path ?? cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true, // geen leeg zwart consolevenster op de desktop
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        fn(value);
      };

      const onAbort = () => {
        child.kill();
        const err = new Error('aborted');
        err.name = 'AbortError';
        err.checkpoint = { partialOutput: stdout.slice(-2000) };
        finish(reject, err);
      };

      const timer = setTimeout(() => {
        child.kill();
        finish(reject, new Error(`runner timeout na ${timeoutMs}ms`));
      }, timeoutMs);

      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });

      let lineBuffer = '';
      child.stdout.on('data', (d) => {
        stdout += d;
        if (!stream) return;
        // Stream-json is regel-gebaseerd: per volledige regel een voortgangsregel.
        lineBuffer += d;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() ?? '';
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('{')) continue;
          try {
            const text = progressFromEvent(JSON.parse(t));
            if (text) onProgress(item, text);
          } catch {
            // onvolledige/onbekende regel — negeren
          }
        }
      });
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', (err) => {
        // Codex r4 #14: GEEN onafhankelijke fallbacks meer (CLAUDE_BIN / homedir-gok) — het gebrokerde
        // pad is gevalideerd bij constructie; een spawn-fout is een eerlijke fout, nooit een reden om
        // een ander, ongevalideerd binair te proberen.
        finish(reject, err);
      });
      child.on('close', (code) => {
        if (signal?.aborted) return;
        if (code === 0) {
          finish(resolve, stream ? parseStream(stdout) : parseClaudeJson(stdout));
        } else {
          // stderr kan paden/tokens bevatten → altijd geredacteerd.
          const err = new Error(`claude exit ${code}: ${redactSecrets(stderr).slice(0, 500)}`);
          err.usedSessionId = sessionId ?? null;
          finish(reject, err);
        }
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });
  }

  return async function claudeRunner({ item, signal }) {
    const sessionId = sessionStore?.get(item.conversationId) ?? null;
    let result;
    try {
      result = await runOnce({ item, signal, sessionId });
    } catch (err) {
      // Verlopen/verdwenen sessie: één keer vers opnieuw, daarna pas falen.
      if (err.name !== 'AbortError' && err.usedSessionId) {
        sessionStore?.clear(item.conversationId);
        result = await runOnce({ item, signal, sessionId: null });
      } else {
        throw err;
      }
    }
    if (result.sessionId) sessionStore?.set(item.conversationId, result.sessionId);
    return {
      answer: result.answer || '(leeg antwoord)',
      costUsd: result.costUsd,
      durationMs: result.durationMs,
      numTurns: result.numTurns,
      usage: result.usage,
    };
  };
}
