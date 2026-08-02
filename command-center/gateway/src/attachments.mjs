// build-lastdemos T3: real attachment storage for the composer's "Attach" control.
//
// POST /api/conversations/:id/attachments (server.mjs) accepts a multipart/form-data body with
// exactly one file field. This module owns three things: a capped raw-body reader (its own,
// independent ~5MB ceiling — body.mjs's existing 64KB JSON cap for the other conversation write
// routes is never silently raised), a zero-dependency multipart parser (mirrors this gateway's
// existing "no new dependency for a small, well-understood wire format" convention — see
// conversations.mjs's own hand-rolled SSE tailer), and the actual on-disk store, one directory
// per conversation under ATTACHMENTS_DIR (paths.mjs), never under .claude/.
//
// Honest scope note (see this WP's forge-report): the stored record reports whether the file is
// text-like (by extension) and, if so, its own real decoded text (capped) — this is what
// Composer.tsx inlines into the next sent message so the attachment is REALLY carried into the
// prompt, not just uploaded and forgotten. A binary file is reported back with its real, absolute
// `storedPath` instead, for the same reason proof.mjs reports a real `path` — Composer.tsx turns
// that into a path-reference line in the sent message. Whether handing an absolute host path to
// the spawned `claude -p` prompt is itself a good idea is a named handoff for Security Boss, not
// silently decided here.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ATTACHMENTS_DIR } from './paths.mjs';
import { containmentOk, safeConvIdOk } from './security.mjs';

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // ~5MB, per the work package's explicit ceiling
// The inline-in-prompt ceiling for a text-like attachment. Matches body.mjs's own default JSON cap
// in spirit (a bounded, sane "fits in one prompt block" size) without importing or changing it.
export const MAX_TEXT_INLINE_BYTES = 64 * 1024;

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.csv', '.tsv', '.log', '.yaml', '.yml',
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.css', '.html', '.htm',
  '.xml', '.ini', '.cfg', '.conf', '.sh', '.ps1', '.sql',
]);

export class AttachmentTooLargeError extends Error {
  constructor(maxBytes) {
    super('attachment exceeds ' + maxBytes + ' bytes');
    this.code = 'ATTACHMENT_TOO_LARGE';
  }
}

// Test-only override seam (mirrors conversations.mjs's own `_setConversationsDirForTests`) — the
// real ATTACHMENTS_DIR is fixed and global to this gateway's install, so without this seam every
// test would write real files into this project's own real `.data/attachments/`.
let attachmentsDirOverride = null;
function activeAttachmentsDir() {
  return attachmentsDirOverride || ATTACHMENTS_DIR;
}
export function _setAttachmentsDirForTests(dir) { attachmentsDirOverride = dir; }
export function _resetAttachmentsDirForTests() { attachmentsDirOverride = null; }

function conversationAttachmentsDir(convId) {
  return path.join(activeAttachmentsDir(), convId);
}

function ensureConvDir(convId) {
  const dir = conversationAttachmentsDir(convId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Returns the containment-checked attachments directory for one conversation, or null when the
 * id itself is unsafe. Exported so a future read route (or a test) never has to re-derive this
 * path by hand.
 */
export function attachmentsDirForConversation(convId) {
  if (!safeConvIdOk(convId)) return null;
  const dir = conversationAttachmentsDir(convId);
  if (!containmentOk(activeAttachmentsDir(), dir)) return null;
  return dir;
}

// Reads the full request body up to `maxBytes`, never buffering past the cap — same "stop
// growing, keep draining so the client's write still completes and a clean error response can
// still be sent" shape as body.mjs's readJsonBody (see that file's own comment for why
// req.destroy() is deliberately NOT used here either).
export function readRawBody(req, { maxBytes = MAX_ATTACHMENT_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    let settled = false;

    function fail(err) {
      if (settled) return;
      settled = true;
      req.removeAllListeners('data');
      req.resume();
      reject(err);
    }

    req.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) { fail(new AttachmentTooLargeError(maxBytes)); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => fail(err));
  });
}

/**
 * Minimal multipart/form-data parser. Handles exactly the shape a browser's own `FormData` +
 * `fetch` produce (RFC 2046 delimited parts, CRLF-terminated headers, a blank line before the
 * body) — this route only ever needs to read one uploaded file field, never a generic MIME
 * parser. Never throws: a malformed body yields `{ ok:false, error }`, never an exception.
 */
export function parseMultipart(buffer, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;\r\n]+))/i.exec(contentType || '');
  const boundaryValue = boundaryMatch ? (boundaryMatch[1] || boundaryMatch[2]) : null;
  if (!boundaryValue) return { ok: false, error: 'missing multipart boundary' };

  const delimiter = Buffer.from('--' + boundaryValue);
  const CRLF = Buffer.from('\r\n');
  const HEADER_SEP = Buffer.from('\r\n\r\n');
  const fields = [];

  let cursor = buffer.indexOf(delimiter);
  if (cursor === -1) return { ok: false, error: 'multipart body has no boundary delimiter' };

  while (cursor !== -1) {
    const afterDelimiter = cursor + delimiter.length;
    // The closing boundary is "--BOUNDARY--" — stop scanning once it is reached.
    if (buffer[afterDelimiter] === 0x2d && buffer[afterDelimiter + 1] === 0x2d) break;

    const partStart = afterDelimiter + CRLF.length; // skip the CRLF ending the boundary line
    const nextDelimiter = buffer.indexOf(delimiter, partStart);
    if (nextDelimiter === -1) break; // truncated body — parse what was found, never throw

    const partEnd = nextDelimiter - CRLF.length >= partStart ? nextDelimiter - CRLF.length : partStart;
    const part = buffer.subarray(partStart, partEnd);

    const headerEnd = part.indexOf(HEADER_SEP);
    if (headerEnd !== -1) {
      const headerText = part.subarray(0, headerEnd).toString('utf8');
      const body = part.subarray(headerEnd + HEADER_SEP.length);
      const nameMatch = /name="([^"]*)"/i.exec(headerText);
      const fileNameMatch = /filename="([^"]*)"/i.exec(headerText);
      const typeMatch = /content-type:\s*([^\r\n]+)/i.exec(headerText);
      fields.push({
        name: nameMatch ? nameMatch[1] : '',
        fileName: fileNameMatch ? fileNameMatch[1] : null,
        contentType: typeMatch ? typeMatch[1].trim() : 'application/octet-stream',
        data: body,
      });
    }

    cursor = nextDelimiter;
  }

  return { ok: true, fields };
}

// Strips directory components and anything outside a small safe character set — the caller-
// supplied `filename` from a multipart part is untrusted free text, never used verbatim as a
// path segment (mirrors projects-create.mjs's own strict-allowlist convention for request-derived
// names).
function safeFileName(name) {
  const base = path.basename(String(name || 'file').replace(/\\/g, '/'));
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
  return cleaned.length > 0 ? cleaned : 'file';
}

function isTextExtension(fileName) {
  return TEXT_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

/**
 * Stores one uploaded file under `.data/attachments/<convId>/<id>-<safeName>`. Returns the stored
 * record: `{ id, fileName, size, storedPath, isText, textPreview, textTruncated }` —
 * `textPreview` is the file's own real decoded text (capped at MAX_TEXT_INLINE_BYTES) for a
 * text-like extension, `null` for anything else (a binary file is referenced by `storedPath`
 * only). Throws on an invalid conversation id or a path that would escape its own conversation
 * directory — both are real bugs in the caller, never a normal, reportable failure.
 */
export function storeAttachment({ convId, fileName, data }) {
  if (!safeConvIdOk(convId)) throw new Error('invalid conversation id');
  const dir = ensureConvDir(convId);
  const id = 'att-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
  const safeName = safeFileName(fileName);
  const storedPath = path.join(dir, id + '-' + safeName);
  if (!containmentOk(dir, storedPath)) throw new Error('attachment path escapes its conversation directory');

  fs.writeFileSync(storedPath, data);

  const isText = isTextExtension(safeName);
  const textTruncated = isText && data.length > MAX_TEXT_INLINE_BYTES;
  const textPreview = isText ? data.subarray(0, MAX_TEXT_INLINE_BYTES).toString('utf8') : null;

  return {
    id,
    fileName: safeName,
    size: data.length,
    storedPath,
    isText,
    textPreview,
    textTruncated,
  };
}
