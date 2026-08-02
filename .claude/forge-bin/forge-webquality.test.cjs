#!/usr/bin/env node
'use strict';
// forge-webquality.test.cjs — real presence/lint guard for the Auto Web-Quality Contract (WAVE C / C3,
// 2026-07-18). Proves config/orchestration/web-quality-contract.md actually exists, is non-empty, and
// still carries the sections the router's Step 3a auto-prepend rule depends on — so a future accidental
// trim/rewrite of that file is caught here instead of silently degrading every website/fullstack dispatch.
// Zero-dependency (fs/path only), picked up automatically by forge-doctor.cjs's *.test.cjs suite runner.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

const CONTRACT_PATH = path.join(__dirname, '..', 'config', 'orchestration', 'web-quality-contract.md');
const ROUTER_SKILL_PATH = path.join(__dirname, '..', 'skills', 'forge-router', 'SKILL.md');

console.log('forge-webquality tests (Auto Web-Quality Contract presence/lint guard — WAVE C / C3)');

// ---------------------------------------------------------------------------
// 1) contract file — presence, non-empty
// ---------------------------------------------------------------------------
console.log('\n1) contract file presence');

t('web-quality-contract.md exists', () => {
  assert.ok(fs.existsSync(CONTRACT_PATH), 'expected ' + CONTRACT_PATH + ' to exist');
});

let contractText = '';
t('web-quality-contract.md is non-empty (not a stub)', () => {
  contractText = fs.readFileSync(CONTRACT_PATH, 'utf8');
  assert.ok(contractText.trim().length > 200, 'expected substantial content, got ' + contractText.trim().length + ' chars');
});

// ---------------------------------------------------------------------------
// 2) required sections/keywords — the checklist a builder actually needs
// ---------------------------------------------------------------------------
console.log('\n2) required sections/keywords');

t('covers responsive desktop+tablet+mobile', () => {
  assert.ok(/responsive/i.test(contractText), 'missing "responsive" coverage');
  assert.ok(/desktop/i.test(contractText) && /tablet/i.test(contractText) && /mobile/i.test(contractText),
    'expected desktop + tablet + mobile all mentioned');
});

t('covers required UI states (loading/empty/error)', () => {
  assert.ok(/loading/i.test(contractText), 'missing "loading" state coverage');
  assert.ok(/empty/i.test(contractText), 'missing "empty" state coverage');
  assert.ok(/error/i.test(contractText), 'missing "error" state coverage');
});

t('covers motion/animation guidance', () => {
  assert.ok(/motion/i.test(contractText), 'missing "motion" coverage');
  assert.ok(/animation|gsap|transform|opacity/i.test(contractText), 'missing concrete motion-implementation guidance');
});

t('covers the screenshot check before "done"', () => {
  assert.ok(/screenshot/i.test(contractText), 'missing "screenshot" coverage');
});

t('covers real content (no lorem/placeholder) and zero console errors and accessibility', () => {
  assert.ok(/lorem|placeholder/i.test(contractText), 'missing real-content / no-placeholder rule');
  assert.ok(/console error/i.test(contractText), 'missing zero console errors rule');
  assert.ok(/accessib/i.test(contractText), 'missing accessibility coverage');
});

t('grounds itself in the existing web design-quality/performance/coding-style rules (no orphan doc)', () => {
  assert.ok(/design-quality\.md/.test(contractText), 'expected a reference to design-quality.md');
  assert.ok(/performance\.md/.test(contractText), 'expected a reference to performance.md');
});

// ---------------------------------------------------------------------------
// 3) router wiring — the auto-prepend rule really references this exact file
// ---------------------------------------------------------------------------
console.log('\n3) router wiring (forge-router SKILL.md references this contract)');

t('forge-router SKILL.md references web-quality-contract.md by name', () => {
  const routerText = fs.readFileSync(ROUTER_SKILL_PATH, 'utf8');
  assert.ok(/web-quality-contract\.md/.test(routerText), 'expected forge-router SKILL.md to reference web-quality-contract.md');
});

t('forge-router SKILL.md auto-prepend rule covers website/landing/spa/fullstack domains', () => {
  const routerText = fs.readFileSync(ROUTER_SKILL_PATH, 'utf8');
  const idx = routerText.indexOf('web-quality-contract.md');
  assert.ok(idx > -1, 'reference not found');
  const windowText = routerText.slice(Math.max(0, idx - 800), idx + 200);
  assert.ok(/website/i.test(windowText), 'expected "website" domain near the wiring rule');
  assert.ok(/fullstack/i.test(windowText), 'expected "fullstack" domain near the wiring rule');
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
