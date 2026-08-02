#!/usr/bin/env node
/**
 * Forge Workspace — doctor.
 *
 * Zero dependencies. A pre-flight self-test that prints one PASS/FAIL line per
 * check and exits non-zero if any check FAILs. It checks:
 *
 *   - Node          the running Node version can execute this workspace;
 *   - git           a `git` is on PATH and answers `--version`;
 *   - Claude CLI    the local Claude Code executable is present, and its version;
 *   - projects root a Documents directory exists to hold ForgeProjecten;
 *   - bridge port   the bridge port is free, or occupied by our own healthy
 *                   bridge — never silently blocked by a stranger;
 *   - workspace     the `.forge-workspace` layout, if present, is intact.
 *
 * Every external program is run with `spawnSync(argv, { shell: false })` — an
 * argv array, never a shell string. The only network it touches is an HTTP GET
 * to the loopback bridge port, which is the check itself.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');

const WORKSPACE_DIR_NAME = '.forge-workspace';
const REPO_ROOT = path.resolve(__dirname, '..');

const results = [];
function record(name, status, detail, notes) {
  results.push({ name, status, detail, notes: notes || [] });
}

/* -------------------------------------------------------------------------- */
/*  Node                                                                       */
/* -------------------------------------------------------------------------- */

function checkNode() {
  const version = process.version; // e.g. v24.18.0
  const major = Number.parseInt(version.replace(/^v/, '').split('.')[0], 10);
  if (!Number.isFinite(major)) {
    record('node', 'FAIL', `could not parse Node version ${version}`);
    return;
  }
  if (major < 20) {
    record('node', 'FAIL', `Node ${version}; the bridge needs Node 20 or newer (24 recommended, it runs .ts directly)`);
    return;
  }
  const notes = major < 22 ? ['Node 22.18+/24 is recommended: the bridge entry is a .ts file executed without a build step'] : [];
  record('node', 'PASS', `Node ${version}`, notes);
}

/* -------------------------------------------------------------------------- */
/*  git                                                                        */
/* -------------------------------------------------------------------------- */

function checkGit() {
  const run = spawnSync('git', ['--version'], { shell: false, timeout: 10000, encoding: 'utf8', windowsHide: true });
  if (run.error) {
    record('git', 'FAIL', `git could not be run (${run.error.code || run.error.message}); is it on PATH?`);
    return;
  }
  const out = `${run.stdout || ''}`.trim();
  if (run.status === 0 && /git version/i.test(out)) {
    record('git', 'PASS', out);
  } else {
    record('git', 'FAIL', `git exited ${run.status}: ${out || (run.stderr || '').trim() || 'no output'}`);
  }
}

/* -------------------------------------------------------------------------- */
/*  Claude Code CLI                                                            */
/* -------------------------------------------------------------------------- */

/** Locate a Claude Code executable without spawning anything. Returns a path or null. */
function locateClaude() {
  const isWin = process.platform === 'win32';
  const exeNames = isWin ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude'];

  // 1. The versioned install under %APPDATA%\Claude\claude-code\<version>\claude.exe
  const appData = process.env.APPDATA;
  if (appData) {
    const base = path.join(appData, 'Claude', 'claude-code');
    try {
      const versions = fs
        .readdirSync(base, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort(compareVersionsDesc);
      for (const v of versions) {
        for (const name of exeNames) {
          const candidate = path.join(base, v, name);
          if (isFile(candidate)) return { path: candidate, source: `%APPDATA%\\Claude\\claude-code\\${v}` };
        }
      }
    } catch {
      /* no versioned install; fall through to PATH */
    }
  }

  // 2. PATH search.
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    for (const name of exeNames) {
      const candidate = path.join(dir, name);
      if (isFile(candidate)) return { path: candidate, source: 'PATH' };
    }
  }
  return null;
}

function compareVersionsDesc(a, b) {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10));
  const pb = b.split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da !== db) return db - da;
  }
  return 0;
}

function checkClaude() {
  const found = locateClaude();
  if (found === null) {
    record(
      'claude-cli',
      'FAIL',
      'no Claude Code executable found on PATH or under %APPDATA%\\Claude\\claude-code',
    );
    return;
  }
  // Only probe an .exe/plain binary directly (shell:false). A .cmd shim cannot be
  // executed without a shell, and we never use one.
  const runnable = process.platform !== 'win32' || found.path.toLowerCase().endsWith('.exe');
  if (!runnable) {
    record('claude-cli', 'FAIL', `found ${found.path} (${found.source}), but it is not a directly runnable .exe to probe its version`);
    return;
  }
  const run = spawnSync(found.path, ['--version'], { shell: false, timeout: 20000, encoding: 'utf8', windowsHide: true });
  if (run.error) {
    record('claude-cli', 'FAIL', `found ${found.path}, but it could not be run (${run.error.code || run.error.message})`);
    return;
  }
  const out = `${run.stdout || ''}`.trim() || `${run.stderr || ''}`.trim();
  const versionMatch = out.match(/\d+\.\d+\.\d+/);
  if (run.status === 0 && versionMatch) {
    record('claude-cli', 'PASS', `Claude Code ${versionMatch[0]} at ${found.path} (${found.source})`);
  } else {
    record('claude-cli', 'FAIL', `Claude Code at ${found.path} did not report a version (exit ${run.status}): ${out || 'no output'}`);
  }
}

/* -------------------------------------------------------------------------- */
/*  Projects root                                                              */
/* -------------------------------------------------------------------------- */

const DOCUMENTS_NAMES = ['Documents', 'Documenten', 'Dokumente', 'Documentos', 'Documenti', 'Dokument', 'Dokumenter'];

function checkProjectsRoot() {
  const home = os.homedir();
  const candidates = [];
  for (const name of DOCUMENTS_NAMES) candidates.push(path.join(home, name));
  // OneDrive Known Folder Move.
  try {
    for (const entry of fs.readdirSync(home, { withFileTypes: true })) {
      if (entry.isDirectory() && /^onedrive( - .+)?$/i.test(entry.name)) {
        for (const name of DOCUMENTS_NAMES) candidates.push(path.join(home, entry.name, name));
      }
    }
  } catch {
    /* home unreadable; the candidates above still stand */
  }

  const documents = candidates.find((c) => isDirectory(c));
  if (documents === undefined) {
    record(
      'projects-root',
      'FAIL',
      `no Documents directory found under ${home}; the New Project flow has nowhere to create ForgeProjecten`,
    );
    return;
  }
  const projectsRoot = path.join(documents, 'ForgeProjecten');
  const exists = isDirectory(projectsRoot);
  record(
    'projects-root',
    'PASS',
    `Documents at ${documents}; projects root ${projectsRoot} ${exists ? 'exists' : 'does not exist yet (created on first New Project)'}`,
  );
}

/* -------------------------------------------------------------------------- */
/*  Bridge port                                                                */
/* -------------------------------------------------------------------------- */

function resolveBridgePort() {
  const raw = process.env.FORGE_BRIDGE_PORT;
  if (raw && /^\d{1,5}$/.test(raw.trim())) {
    const value = Number(raw.trim());
    if (value >= 1024 && value <= 65535) return value;
  }
  return 4517; // DEFAULT_PORT in src/bridge/config.ts
}

function checkBridgePort() {
  const port = resolveBridgePort();
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/health', timeout: 2500, headers: { host: `127.0.0.1:${port}`, accept: 'application/json' } },
      (res) => {
        const chunks = [];
        let total = 0;
        res.on('data', (c) => {
          total += c.length;
          if (total > 1_048_576) {
            res.destroy();
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          let body = null;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            body = null;
          }
          if (body && typeof body.ok === 'boolean' && body.bindAddress === '127.0.0.1') {
            record('bridge-port', 'PASS', `port ${port}: a Forge bridge is listening and reports ok=${body.ok}`);
          } else {
            record('bridge-port', 'FAIL', `port ${port} is occupied by a listener that is not the Forge bridge; the bridge cannot start there`);
          }
          resolve();
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      record('bridge-port', 'FAIL', `port ${port} accepted a connection but did not answer /api/health within 2500ms`);
      resolve();
    });
    req.on('error', (err) => {
      if (err.code === 'ECONNREFUSED') {
        record('bridge-port', 'PASS', `port ${port} is free; no bridge is currently listening (start one with npm run bridge)`);
      } else {
        record('bridge-port', 'FAIL', `port ${port} could not be probed: ${err.code || err.message}`);
      }
      resolve();
    });
  });
}

/* -------------------------------------------------------------------------- */
/*  Workspace integrity                                                        */
/* -------------------------------------------------------------------------- */

function checkWorkspace() {
  const dataDir = path.resolve(
    (process.env.FORGE_WORKSPACE_DIR && process.env.FORGE_WORKSPACE_DIR.trim()) || path.join(REPO_ROOT, WORKSPACE_DIR_NAME),
  );
  if (!isDirectory(dataDir)) {
    record('workspace', 'PASS', `no workspace at ${dataDir} yet; it is created on first bridge start`);
    return;
  }

  const notes = [];
  const metaPath = path.join(dataDir, 'meta', 'workspace.json');
  if (!isFile(metaPath)) {
    record('workspace', 'FAIL', `${dataDir} exists but its meta/workspace.json is missing; the layout is incomplete`);
    return;
  }
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch (err) {
    record('workspace', 'FAIL', `meta/workspace.json could not be parsed: ${err.message}`);
    return;
  }
  if (typeof meta.layoutVersion !== 'number') {
    record('workspace', 'FAIL', 'meta/workspace.json has no numeric layoutVersion; the workspace metadata is corrupt');
    return;
  }

  // Scan the event streams for a truncated final line. The store tolerates this
  // (it drops only the bad tail), so it is reported as a note, not a failure.
  const eventsDir = path.join(dataDir, 'events');
  let streams = 0;
  let truncated = 0;
  if (isDirectory(eventsDir)) {
    for (const file of fs.readdirSync(eventsDir)) {
      if (!file.endsWith('.jsonl')) continue;
      streams += 1;
      try {
        const text = fs.readFileSync(path.join(eventsDir, file), 'utf8');
        if (text.length === 0) continue;
        if (!text.endsWith('\n')) {
          const lastLine = text.slice(text.lastIndexOf('\n') + 1).trim();
          if (lastLine.length > 0) {
            try {
              JSON.parse(lastLine);
            } catch {
              truncated += 1;
              notes.push(`${file}: final line is unterminated and does not parse — the bridge will drop only that line on next start`);
            }
          }
        }
      } catch {
        notes.push(`${file}: could not be read`);
      }
    }
  }

  record(
    'workspace',
    'PASS',
    `layout v${meta.layoutVersion} at ${dataDir}; ${streams} event stream(s)${truncated > 0 ? `, ${truncated} with a truncated tail` : ''}`,
    notes,
  );
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/*  Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main() {
  process.stdout.write('[doctor] Forge Workspace pre-flight\n\n');

  checkNode();
  checkGit();
  checkClaude();
  checkProjectsRoot();
  await checkBridgePort();
  checkWorkspace();

  let failed = 0;
  for (const r of results) {
    if (r.status === 'FAIL') failed += 1;
    process.stdout.write(`${r.status === 'PASS' ? 'PASS' : 'FAIL'}  ${r.name.padEnd(14)} ${r.detail}\n`);
    for (const note of r.notes) process.stdout.write(`      note: ${note}\n`);
  }

  process.stdout.write(`\n[doctor] ${results.length - failed}/${results.length} checks passed.\n`);
  return failed > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`[doctor] ERROR: ${err && err.stack ? err.stack : String(err)}\n`);
    process.exit(1);
  });
