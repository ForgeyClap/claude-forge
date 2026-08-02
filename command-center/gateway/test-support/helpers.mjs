// Shared test helper: real HTTP requests against a real, ephemeral-port instance of the
// gateway's own request listener. No mocking of node:http — these are genuine sockets.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EXEC_TOKEN_HEADER, getExecToken } from '../src/security.mjs';

// WP3 addition: a fully-isolated temp project tree for events/incremental-cache/SSE tests —
// this is what "write a TEMP events file in a test dir, NEVER into real .claude/forge-runs"
// means in practice. Every caller is responsible for removing the returned dir in its own
// `after`/`afterEach` (fs.rmSync(dir, { recursive: true, force: true })).
export function makeTempProjectRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gateway-test-'));
}

export function writeEventsFile(projectRoot, runId, lines) {
  const runDir = path.join(projectRoot, '.claude', 'forge-runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  const eventsPath = path.join(runDir, 'events.jsonl');
  const body = lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : '');
  fs.writeFileSync(eventsPath, body, 'utf8');
  return eventsPath;
}

export function appendEventLine(eventsPath, obj) {
  fs.appendFileSync(eventsPath, JSON.stringify(obj) + '\n', 'utf8');
}

export function request(port, urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1', port, path: urlPath, method: options.method || 'GET',
        headers: options.headers || {},
      },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(body); } catch { /* not all responses are JSON */ }
          resolve({ statusCode: res.statusCode, headers: res.headers, body, json });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// WP4 addition: same shape as request() above, but sends a real request body (used by the
// conversation write routes: POST /api/conversations, /messages, /stop). `rawBody`, when given,
// is written verbatim (so a test can exceed the 64KB cap or send oversized non-JSON on purpose);
// otherwise `jsonBody` is JSON.stringify'd with a Content-Type: application/json header.
//
// fix-sec-round #1: POST /messages now requires the real exec token (security.mjs) for every mode
// except 'plan'. Rather than touch every existing call site across the test suite, the real
// current-boot token (read directly from security.mjs — the same module the SERVER under test
// imports, so it is always the SAME token, never a guess) is attached by default on every call.
// A test that specifically needs to exercise the missing/wrong-token path passes
// `omitExecToken: true`, or overrides the header explicitly via `headers`.
export function requestWithBody(port, urlPath, { method = 'POST', jsonBody, rawBody, headers = {}, omitExecToken = false } = {}) {
  return new Promise((resolve, reject) => {
    const bodyStr = rawBody != null ? rawBody : jsonBody !== undefined ? JSON.stringify(jsonBody) : '';
    const execTokenHeader = omitExecToken ? {} : { [EXEC_TOKEN_HEADER]: getExecToken() };
    const finalHeaders = { 'Content-Type': 'application/json', ...execTokenHeader, ...headers };
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method, headers: finalHeaders },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(body); } catch { /* not all responses are JSON */ }
          resolve({ statusCode: res.statusCode, headers: res.headers, body, json });
        });
      },
    );
    req.on('error', reject);
    req.end(bodyStr);
  });
}
