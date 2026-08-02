import { spawn } from 'node:child_process';
import fs from 'node:fs';
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

export function createClaudeRunner({
  claudePath = 'claude',
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

  let triedAltPath = false;

  function runOnce({ item, signal, sessionId, claudeBin = null }) {
    return new Promise((resolve, reject) => {
      const project = resolveProject?.(item) ?? {};
      const bin = claudeBin ?? claudePath;
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
        if (err.code === 'ENOENT' && !triedAltPath) {
          // Geen shell-fallback: probeer het expliciete pad uit CLAUDE_BIN, of het
          // standaard Windows-pad van de claude-executable.
          triedAltPath = true;
          const alt =
            process.env.CLAUDE_BIN ??
            path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
          if (alt && alt !== claudePath && fs.existsSync(alt)) {
            finish(resolve, runOnce({ item, signal, sessionId, claudeBin: alt }));
            return;
          }
        }
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
