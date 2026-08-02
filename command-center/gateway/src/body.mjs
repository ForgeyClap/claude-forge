// JSON request-body reader with a hard byte cap + a tiny allowlist schema validator. Used by
// every WP4 write route (POST /api/conversations, /messages, /stop) so a malicious or malformed
// body is rejected BEFORE it ever reaches conversations.mjs or the execution bridge.
const DEFAULT_MAX_BYTES = 64 * 1024; // 64KB — the work package's explicit body-size limit

export class BodyTooLargeError extends Error {
  constructor(maxBytes) {
    super('request body exceeds ' + maxBytes + ' bytes');
    this.code = 'BODY_TOO_LARGE';
  }
}

export class BadJsonError extends Error {
  constructor(detail) {
    super('invalid JSON body' + (detail ? ': ' + detail : ''));
    this.code = 'BAD_JSON';
  }
}

// Reads the full request body (capped), then JSON.parses it. An empty body parses to `{}` so a
// route that expects an empty POST (none exist yet, but this keeps the helper generically safe)
// never throws on a legitimately empty payload. Rejects (destroys the socket) the instant the
// running byte count exceeds `maxBytes` — never buffers past the cap.
export function readJsonBody(req, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    let settled = false;

    function fail(err) {
      if (settled) return;
      settled = true;
      // Deliberately NOT req.destroy(): destroying the request mid-body on a keep-alive socket
      // tears down the connection before the error RESPONSE can be written, which the caller sees
      // as a raw ECONNRESET instead of a clean 413 — a real regression this exact fix caught in
      // routes-wp4.test.mjs. Instead: stop growing `chunks`, but keep draining (and discarding)
      // whatever is still arriving so the client's write completes and the socket stays healthy
      // enough for the server to still send a proper JSON error response on it.
      req.removeAllListeners('data');
      req.resume();
      reject(err);
    }

    req.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) { fail(new BodyTooLargeError(maxBytes)); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim().length === 0) { resolve({}); return; }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new BadJsonError(err.message));
      }
    });
    req.on('error', (err) => fail(err));
  });
}

// Rejects unknown fields (strict allowlist) and missing required fields. Returns an error string,
// or null when the body is valid. Never mutates `body`.
export function validateSchema(body, allowedKeys, requiredKeys = []) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return 'body must be a JSON object';
  for (const key of Object.keys(body)) {
    if (!allowedKeys.includes(key)) return 'unknown field: ' + key;
  }
  for (const key of requiredKeys) {
    if (!(key in body)) return 'missing required field: ' + key;
  }
  return null;
}
