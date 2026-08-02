#!/usr/bin/env node
// Forge Command Center gateway — forge-ask MCP server (feat-ask-owner, forge-2026-07-30-cc-finish).
//
// Standalone stdio MCP server. It is spawned by the `claude` CLI ITSELF (never by this gateway
// process directly) via the per-execution --mcp-config file `exec-argv.mjs` writes, so it runs in
// its own OS process and cannot share in-memory state with the gateway (`ask-store.mjs`) — it
// reaches the gateway only over plain HTTP, using `node:http` alone (zero-dependency, matching the
// rest of gateway/src). Deliberately NOT the global `fetch`: Node's built-in fetch (undici) applies
// a default dispatcher with a ~5-minute headersTimeout/bodyTimeout, which would abort a tool call
// that can legitimately stay open up to the ask-store's own real timeout (up to 30 minutes) — a
// plain `http.request()` has no such default, and this file sets its own generous, explicit one
// instead (see CLIENT_TIMEOUT_MS below).
//
// PROVEN SHAPE (2026-07-30 scratchpad spike — Build Boss read the working proof files before
// writing this): a minimal JSON-RPC-over-stdio handshake (initialize -> tools/list -> tools/call)
// really works when the spawning `claude -p ... --mcp-config <file> --strict-mcp-config` session
// calls the one tool this server exposes (`ask_owner`) and waits for its real result text.
//
// PERMISSION CORRECTION (coordinator-measured 2026-07-30, two real, non-mock runs): the argv
// `exec-argv.mjs` builds for the spawning session NEVER adds --allowed-tools/--disallowedTools
// alongside --mcp-config. A real test proved --allowed-tools silently starves every OTHER built-in
// tool (Write/Edit/Bash) while the model still claims success afterwards — exactly the dishonest,
// crippled-agent outcome this feature must never cause. --strict-mcp-config alone only restricts
// WHICH MCP SERVERS load (just this one), never which built-in tools the session may use.
'use strict';

import http from 'node:http';

const GATEWAY_ORIGIN = process.env.CC_ASK_GATEWAY_ORIGIN || 'http://127.0.0.1:4100';
const CONV_ID = process.env.CC_ASK_CONV_ID || '';
const TURN_ID = process.env.CC_ASK_TURN_ID || null;
const REQUEST_ID = process.env.CC_ASK_REQUEST_ID || null;
const EXEC_TOKEN = process.env.CC_ASK_EXEC_TOKEN || '';
const EXEC_TOKEN_HEADER = 'x-cc-exec-token';
// Defensive backstop only — the gateway's own ask-store timeout is what actually resolves a call
// honestly (answered or a real "owner did not answer" outcome); this guards solely against the
// gateway process itself dying mid-wait, so it is set comfortably longer than that real timeout.
const CLIENT_TIMEOUT_MS = Number(process.env.CC_ASK_CLIENT_TIMEOUT_MS) > 0
  ? Number(process.env.CC_ASK_CLIENT_TIMEOUT_MS)
  : 32 * 60 * 1000;

let stdinBuffer = '';

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function logErr(message) {
  try {
    process.stderr.write('[forge-ask] ' + message + '\n');
  } catch {
    /* best-effort only — a broken stderr pipe must never crash this process */
  }
}

const ASK_TOOL = {
  name: 'ask_owner',
  description:
    'Ask the human owner one or more questions through the Forge Command Center dashboard and WAIT ' +
    'for the REAL answer before continuing or assuming anything. Use this whenever a choice would ' +
    'materially change what gets built — a single call may carry up to 25 questions for a genuinely ' +
    'thorough intake. Each question may offer multiple-choice options; the dashboard always ALSO ' +
    'lets the owner type something else ("Anders...") instead of picking one. Never guess an answer ' +
    '— call this tool and wait for the real one.',
  inputSchema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: 25,
        items: {
          type: 'object',
          properties: {
            header: { type: 'string', description: 'Short label for this question (optional).' },
            question: { type: 'string', description: 'The actual question text shown to the owner.' },
            options: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional multiple-choice options. The owner can always type a free-text answer instead.',
            },
            multiSelect: { type: 'boolean', description: 'Whether the owner may pick more than one option.' },
            recommended: {
              type: 'string',
              description:
                'Optional: the EXACT text of the one option that is genuinely the best fit for THIS situation, based on what you actually examined (project state, owner words, trade-offs) — never by position, popularity or your own convenience. State the reasoning in the question text. Omit entirely when no option is clearly better.',
            },
          },
          required: ['question'],
        },
      },
    },
    required: ['questions'],
  },
};

/** POSTs the real questions to the gateway's `/api/ask` route and waits for its real response —
 *  this single HTTP call is what actually blocks until the owner answers or the ask times out.
 *  Never throws; every failure resolves to `{ ok:false, error }`. */
function postAsk(questions) {
  return new Promise((resolve) => {
    const bodyStr = JSON.stringify({ conv_id: CONV_ID, turn_id: TURN_ID, request_id: REQUEST_ID, questions });
    let url;
    try {
      url = new URL('/api/ask', GATEWAY_ORIGIN);
    } catch (err) {
      resolve({ ok: false, error: 'invalid CC_ASK_GATEWAY_ORIGIN: ' + (err && err.message ? err.message : String(err)) });
      return;
    }

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(bodyStr),
          [EXEC_TOKEN_HEADER]: EXEC_TOKEN,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(raw);
          } catch {
            /* handled by the fallback below */
          }
          if (parsed === null || typeof parsed !== 'object') {
            resolve({ ok: false, error: 'gateway returned a non-JSON response (HTTP ' + res.statusCode + ')' });
            return;
          }
          if (res.statusCode !== 200 || parsed.ok !== true) {
            resolve({ ok: false, error: typeof parsed.error === 'string' ? parsed.error : 'gateway returned HTTP ' + res.statusCode });
            return;
          }
          resolve(parsed);
        });
      },
    );
    req.setTimeout(CLIENT_TIMEOUT_MS, () => {
      req.destroy(new Error('the gateway did not respond within ' + CLIENT_TIMEOUT_MS + 'ms'));
    });
    req.on('error', (err) => {
      resolve({ ok: false, error: 'could not reach the gateway at ' + GATEWAY_ORIGIN + ': ' + (err && err.message ? err.message : String(err)) });
    });
    req.end(bodyStr);
  });
}

async function handleToolCall(msg) {
  const args = (msg.params && msg.params.arguments) || {};
  const questions = Array.isArray(args.questions) ? args.questions : null;
  if (!questions || questions.length === 0) {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { content: [{ type: 'text', text: 'ask_owner was called with no questions — nothing was asked.' }], isError: true },
    });
    return;
  }

  const outcome = await postAsk(questions);
  if (!outcome.ok) {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { content: [{ type: 'text', text: 'Could not ask the owner: ' + outcome.error + ' — no answer was fabricated.' }], isError: true },
    });
    return;
  }
  if (outcome.timed_out) {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        content: [{
          type: 'text',
          text: outcome.note || 'The owner did not answer within the time limit — no answer was fabricated. Proceed conservatively, or ask again.',
        }],
      },
    });
    return;
  }
  send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ answers: outcome.answers }) }] } });
}

process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk.toString('utf8');
  let newlineIndex;
  while ((newlineIndex = stdinBuffer.indexOf('\n')) >= 0) {
    const line = stdinBuffer.slice(0, newlineIndex).trim();
    stdinBuffer = stdinBuffer.slice(newlineIndex + 1);
    if (!line) continue;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // a malformed line is skipped, never crashes this process
    }

    if (msg.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'forge-ask', version: '1.0.0' } },
      });
    } else if (msg.method === 'notifications/initialized') {
      // a notification carries no id and expects no response
    } else if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: [ASK_TOOL] } });
    } else if (msg.method === 'tools/call') {
      handleToolCall(msg).catch((err) => {
        logErr('tools/call handler threw: ' + (err && err.message ? err.message : String(err)));
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: 'internal ask-mcp error: ' + (err && err.message ? err.message : String(err)) }], isError: true },
        });
      });
    } else if (msg.id !== undefined) {
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
    }
  }
});

process.stdin.on('end', () => process.exit(0));
