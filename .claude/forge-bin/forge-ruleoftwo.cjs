#!/usr/bin/env node
'use strict';
/**
 * forge-ruleoftwo.cjs — Rule-of-Two auto-classifier (2026-07-18, PIECE C4). Activates Meta's "Rule of Two"
 * for prompt-injection risk ("lethal trifecta") as a real, callable classifier: an agent step is risky when
 * it simultaneously (1) ingests untrusted content, (2) accesses private/sensitive data, AND (3) can
 * communicate/act externally — any TWO of those three already deserve a plan-then-execute pause and a
 * capability split, not just the full three-of-three case.
 *
 * PRIOR ART (reused, not duplicated): forge-policy.cjs already exports a pure `ruleOfTwo(flags)` helper for
 * the Lead/Head Chef's own boolean-flag dispatch decisions (its threshold is deliberately stricter — only
 * flags all THREE legs as needing a split, since that call site already knows the flags precisely and wants
 * the narrowest possible trigger). THIS module is the auto-classifier layer PIECE C4 asked for: it adds (a)
 * keyword-based text detection of the three legs from a free-form task description — no caller has to
 * pre-compute booleans — and (b) a more cautious >=2-of-3 threshold suited to an automatic, upstream
 * classification pass where under-triggering is the costlier mistake. Both modules stay independently
 * testable; neither re-implements the other's decision math, so a future caller picks the one matching its
 * own certainty level (explicit flags -> forge-policy.ruleOfTwo; free text -> this module).
 *
 * MODEL:
 *   classify(input, opts) -> { legs, held, count, needsSplit, plan_then_execute, capability_split, reason,
 *                               matched, sourceText }
 *   input may be:
 *     - a plain string (free task text) -> keyword-detects all three legs from it.
 *     - an event-shaped object { text, task, description } -> the same fields are joined and keyword-detected
 *       (mirrors forge-actiongate.cjs's normalizeInput text-join convention).
 *     - an explicit flags object { untrustedInput, privateData, externalComms } (booleans) -> used verbatim,
 *       no keyword detection performed (the caller already knows the answer).
 *   opts.legPatterns (optional) overrides the built-in per-leg RegExp map for hermetic/targeted tests
 *     (same opts.<override> seam every sibling Wave tool uses) — shape: { untrustedInput, privateData,
 *     externalComms } each a RegExp.
 *
 *   `legs`      — { untrustedInput, privateData, externalComms } booleans, the raw per-leg verdict.
 *   `held`      — array of leg names that are true, in canonical order.
 *   `count`     — held.length (0-3).
 *   `needsSplit`/`plan_then_execute` — true when count >= 2 (the "injection trifecta" auto-trigger).
 *   `capability_split` — when needsSplit, one suggested step per held leg, each step scoped to ONLY that
 *     leg's capability and explicitly restricted from the other held legs — so no single step ever holds two
 *     or more of untrusted-input ingestion / private-data access / external communication together. Empty
 *     array when needsSplit is false.
 *   `matched`   — { legName: [matchedPhrase] } — the literal keyword phrase that fired each leg (empty array
 *     when that leg is false, or when explicit boolean flags were supplied instead of text).
 *   `sourceText`— the text actually scanned (null when explicit boolean flags were supplied).
 *
 * CLI:
 *   node forge-ruleoftwo.cjs classify "<task text>" [--json]
 * Exit codes: 0 = classified, no split needed (count < 2) · 3 = split recommended (count >= 2, mirrors the
 * sibling *-gate/-guard tools' STOP=3 convention) · 2 = usage error.
 */

const LEGS = ['untrustedInput', 'privateData', 'externalComms'];

// Keyword patterns for the three Rule-of-Two legs. Deliberately broad-but-scoped: each pattern targets
// phrases that indicate the CAPABILITY (ingest untrusted content / touch sensitive data / act externally),
// not a bare noun that shows up in ordinary conversation about the topic (e.g. "email validation" does not
// fire externalComms; "send an email" does).
const LEG_PATTERNS = {
  untrustedInput: /\b(untrusted (content|input|data|source)|third[- ]party (content|input|data)|external (content|website|webpage|web page)|fetch(?:es|ed|ing)? (a |the )?(url|page|webpage|website)|scrap(?:e|ed|es|ing) (a |the )?(website|page|web)|user[- ]submitted (content|input|data|file)|uploaded (file|document|pdf|attachment)|incoming (email|message|webhook|request)|customer (email|message)|chat transcript|rss feed|web search results?|attacker[- ]controlled|pars(?:e|es|ed|ing) (an? |the )?(email|document|pdf|html|webpage)|read(?:s|ing)? (content|data) from (a |the )?(web|url|website|internet)|public internet|untrusted (content|data|source|input))\b/i,
  privateData: /\b(secrets?|credentials?|api[- ]?keys?|passwords?|private data|\bpii\b|personally identifiable information|customer data|database records?|\bdb\b (record|table|row)|tokens?|social security|financial records?|confidential (data|information|file)|\.env\b|environment variables?|auth(?:entication)? tokens?|session tokens?|encryption keys?|private keys?|access tokens?|user data|sensitive (data|information))\b/i,
  externalComms: /\b(send (an? )?(email|sms|text|message|notification)|email(?:s|ed|ing)? (the|a|customers?|clients?|users?)|post(?:s|ed|ing)? (a|to|it)|publish(?:es|ed|ing)? (the|a)|webhooks?|external api|api call|call(?:s|ing|ed)? an? external (service|api)|make a purchase|execute a transaction|deploy(?:s|ed|ing)?|push to production|notify (the|a)|repl(?:y|ies|ied) to (the )?customer|outbound (request|call|message)|externally communicat\w*|write to (an? )?external system|send (a|the) request to)\b/i,
};

/** detectLegs — scans text against LEG_PATTERNS, returns { legs, matched }. Never throws on empty/undefined
 *  text (treated as no legs held). */
function detectLegs(text, legPatterns) {
  const patterns = legPatterns || LEG_PATTERNS;
  const t = String(text || '');
  const legs = {};
  const matched = {};
  for (const leg of LEGS) {
    const re = patterns[leg];
    const m = re ? t.match(re) : null;
    legs[leg] = !!m;
    matched[leg] = m ? [m[0]] : [];
  }
  return { legs, matched };
}

/** hasExplicitFlags — true when input is an object supplying at least one of the three legs as a real
 *  boolean (the "caller already knows the answer" path — no keyword detection performed). */
function hasExplicitFlags(input) {
  return LEGS.some((k) => typeof input[k] === 'boolean');
}

/** buildCapabilitySplit — one step per held leg, each scoped to ONLY that leg and explicitly restricted
 *  from every other held leg, so a caller has a concrete "split this work package" starting point rather
 *  than just a boolean warning. */
function buildCapabilitySplit(held) {
  const LABELS = {
    untrustedInput: { step: 'ingest-untrusted-content', capability: 'read/parse untrusted or third-party content only' },
    privateData: { step: 'access-private-data', capability: 'read/use private or sensitive data only' },
    externalComms: { step: 'act-externally', capability: 'send/post/communicate or act externally only' },
  };
  return held.map((leg) => ({
    step: LABELS[leg].step,
    capability: LABELS[leg].capability,
    restricts: held.filter((other) => other !== leg),
  }));
}

/** classify — see file header. Pure, never throws on any input shape (null/undefined/number all fall back
 *  to "no legs held"). */
function classify(input, opts) {
  opts = opts || {};
  const legPatterns = opts.legPatterns || LEG_PATTERNS;

  let legs;
  let matched;
  let sourceText = null;

  if (typeof input === 'string') {
    sourceText = input;
    const d = detectLegs(input, legPatterns);
    legs = d.legs;
    matched = d.matched;
  } else if (input && typeof input === 'object') {
    if (hasExplicitFlags(input)) {
      legs = {
        untrustedInput: !!input.untrustedInput,
        privateData: !!input.privateData,
        externalComms: !!input.externalComms,
      };
      matched = { untrustedInput: [], privateData: [], externalComms: [] };
    } else {
      sourceText = [input.text, input.task, input.description].filter(Boolean).join(' ');
      const d = detectLegs(sourceText, legPatterns);
      legs = d.legs;
      matched = d.matched;
    }
  } else {
    legs = { untrustedInput: false, privateData: false, externalComms: false };
    matched = { untrustedInput: [], privateData: [], externalComms: [] };
  }

  const held = LEGS.filter((k) => legs[k]);
  const count = held.length;
  const needsSplit = count >= 2;
  const capability_split = needsSplit ? buildCapabilitySplit(held) : [];
  const reason = needsSplit
    ? 'Rule-of-Two: ' + count + ' of 3 risk legs present (' + held.join(', ') + ') — plan-then-execute and '
      + 'split capabilities across separate steps so no single step holds untrusted-input ingestion + '
      + 'private-data access + external communication together.'
    : count + ' of 3 risk legs present' + (held.length ? ' (' + held.join(', ') + ')' : '') + ' — within Rule-of-Two, no split required.';

  return { legs, held, count, needsSplit, plan_then_execute: needsSplit, capability_split, reason, matched, sourceText };
}

module.exports = { classify, detectLegs, buildCapabilitySplit, LEGS, LEG_PATTERNS };

// ---- CLI ----
function parseArgs(argv) {
  const cmd = argv[0] || null;
  const rest = argv.slice(1);
  const opts = { cmd, json: false, positional: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--json') opts.json = true;
    else opts.positional.push(a);
  }
  return opts;
}
function printUsage() {
  console.error('Usage: node forge-ruleoftwo.cjs classify "<task text>" [--json]');
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  try {
    if (opts.cmd === 'classify') {
      const text = opts.positional[0];
      if (text === undefined) { printUsage(); process.exitCode = 2; }
      else {
        const result = classify(text, {});
        if (opts.json) console.log(JSON.stringify(result));
        else if (result.needsSplit) {
          console.log('SPLIT RECOMMENDED — ' + result.reason);
          for (const s of result.capability_split) console.log('  step: ' + s.step + ' — ' + s.capability + ' (restricted from: ' + s.restricts.join(', ') + ')');
        } else {
          console.log('no split needed — ' + result.reason);
        }
        process.exitCode = result.needsSplit ? 3 : 0;
      }
    } else {
      printUsage();
      process.exitCode = 2;
    }
  } catch (e) {
    console.error('forge-ruleoftwo: ' + e.message);
    process.exitCode = 2;
  }
}
