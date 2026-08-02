// build-lastdemos T2: GET /api/artifacts/:id/content — serves the REAL bytes behind one
// artifact record, closing the "Download" gap ArtifactsView.tsx used to report honestly as
// unavailable.
//
// `proof.mjs` already knows the two real places an artifact's bytes can live (it stat()s both for
// size_bytes) — this module resolves the same two sources to an actual readable file rather than
// just a size:
//   1. a `.claude/forge-artifacts/<id>.json` store doc's own `path` field (the id the frontend's
//      `Artifact.id` carries whenever a row came from proof.mjs's `forge-artifacts-index` source);
//   2. a bare filename inside ANY run's own `<run>/artifacts/` directory (the id the frontend's
//      `Artifact.id` carries whenever a row came from proof.mjs's `run-artifacts-dir` source,
//      which has no id field of its own — see proof.mjs's `listRunArtifactFiles`). The frontend has
//      no per-artifact run reference to send, so this scans every run directory for a same-named
//      file rather than requiring one — bounded by how many runs a project actually has.
// Whichever resolves to a REAL, containment-checked, existing file wins; neither resolving is an
// honest 404, never a fabricated body.
import fs from 'node:fs';
import path from 'node:path';
import { containmentOk } from './security.mjs';

// Filenames under a run's artifacts/ directory carry real extensions (e.g. "wp0-health-report.md")
// that the run-id/conv-id allowlists elsewhere in this gateway (no dots permitted) don't cover —
// this is a deliberately separate, slightly wider allowlist for exactly that reason. Still refuses
// a leading dot (blocks ".." outright) and any path separator.
const SAFE_ARTIFACT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function safeArtifactIdOk(id) {
  return typeof id === 'string' && SAFE_ARTIFACT_ID_RE.test(id) && !id.includes('..');
}

const MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.pdf': 'application/pdf',
};

function mimeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

// Strategy 1: the forge-artifacts index store. Mirrors proof.mjs's own statIndexedArtifactSize —
// `doc.path` is agent-authored free text, resolved against the project root and re-checked with
// the same containment guard every other module here uses, never trusted as-is.
function resolveFromIndex(projectPath, id) {
  const artifactsStoreDir = path.join(projectPath, '.claude', 'forge-artifacts');
  const docPath = path.join(artifactsStoreDir, id + '.json');
  if (!containmentOk(artifactsStoreDir, docPath)) return null;
  let doc;
  try { doc = JSON.parse(fs.readFileSync(docPath, 'utf8')); } catch { return null; }
  if (typeof doc.path !== 'string' || doc.path.length === 0) return null;
  const resolved = path.isAbsolute(doc.path) ? doc.path : path.join(projectPath, doc.path);
  if (!containmentOk(projectPath, resolved)) return null;
  try {
    if (!fs.statSync(resolved).isFile()) return null;
  } catch {
    return null;
  }
  return resolved;
}

// Strategy 2: a bounded scan of every run's own artifacts/ directory for a same-named file.
function resolveFromRunArtifactDirs(projectPath, id) {
  const runsDir = path.join(projectPath, '.claude', 'forge-runs');
  let runDirs;
  try { runDirs = fs.readdirSync(runsDir, { withFileTypes: true }); } catch { return null; }
  for (const entry of runDirs) {
    if (!entry.isDirectory()) continue;
    const artifactsDir = path.join(runsDir, entry.name, 'artifacts');
    const candidate = path.join(artifactsDir, id);
    if (!containmentOk(artifactsDir, candidate)) continue; // belt and suspenders — id is already regex-safe
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* not in this run — keep scanning the rest */
    }
  }
  return null;
}

/** Resolves one artifact id to a real, existing file path under `projectPath`, or null. */
export function resolveArtifactContentPath(projectPath, id) {
  if (!safeArtifactIdOk(id)) return null;
  return resolveFromIndex(projectPath, id) || resolveFromRunArtifactDirs(projectPath, id);
}

// A Content-Disposition header value must never carry a raw CR/LF/quote from untrusted input
// (here: a store doc's own `path` basename) — this is the one piece of the resolved file name that
// is NOT already regex-constrained by SAFE_ARTIFACT_ID_RE (that only bounds the request `id`).
function safeHeaderFileName(name) {
  const stripped = String(name).replace(/[\r\n"]/g, '');
  return stripped.length > 0 ? stripped : 'artifact';
}

/**
 * Builds the full response for GET /api/artifacts/:id/content. Never throws — every failure is a
 * typed `{ ok:false, status, error }`; success is `{ ok:true, status:200, buffer, fileName, mime }`.
 */
export function buildArtifactContentResponse(projectPath, id) {
  const filePath = resolveArtifactContentPath(projectPath, id);
  if (!filePath) return { ok: false, status: 404, error: 'artifact content not found' };
  let buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch (err) {
    return { ok: false, status: 404, error: 'artifact content not found: ' + (err && err.message ? err.message : String(err)) };
  }
  return {
    ok: true,
    status: 200,
    buffer,
    fileName: safeHeaderFileName(path.basename(filePath)),
    mime: mimeFor(filePath),
  };
}
