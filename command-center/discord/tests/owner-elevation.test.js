import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Router } from '../src/router.js';
import { AuditLedger } from '../src/audit.js';

import {
  OWNER_ELEVATED_MODE,
  isVerifiedOwner,
  resolveEffectivePermissionMode,
  createOwnerAwareProjectResolver,
} from '../src/owner-elevation.js';
import { buildArgs } from '../src/runner-claude.js';
import { PermissionGateway } from '../src/permissions.js';

// SYNTHETISCHE ID's. Nooit een echt Discord-ID in een test/commentaar/rapport.
const OWNER = 'OWNER_SYNTH_A';
const OWNER_2 = 'OWNER_SYNTH_B';
const STRANGER = 'STRANGER_SYNTH_C';

function fakeAudit() {
  const events = [];
  return { events, record: (type, data = {}) => events.push({ type, data }) };
}

const writableProject = () => ({
  projectId: 'projA',
  path: 'C:/x/projA',
  forgeMode: false,
  permissionMode: 'acceptEdits',
});
const readOnlyProject = () => ({ ...writableProject(), permissionMode: 'default' });

const msg = (senderId, extra = {}) => ({
  id: 'req_1',
  messageId: 'msg_1',
  projectId: 'projA',
  senderId,
  ...extra,
});

// ---------------------------------------------------------------- verhoging

test('geverifieerde owner + schrijfbaar project → volledige rechten', () => {
  const r = resolveEffectivePermissionMode({
    project: writableProject(),
    item: msg(OWNER),
    ownerUserIds: [OWNER, OWNER_2],
  });
  assert.equal(r.elevated, true);
  assert.equal(r.mode, OWNER_ELEVATED_MODE);
  assert.equal(r.mode, 'bypassPermissions');
});

test('verhoogde modus komt echt als CLI-vlag mee', () => {
  const args = buildArgs({ permissionMode: OWNER_ELEVATED_MODE });
  assert.deepEqual(args, ['-p', '--output-format', 'json', '--permission-mode', 'bypassPermissions']);
});

test('buildArgs weigert een niet-toegestane permissiemodus (geen vlag-injectie)', () => {
  assert.deepEqual(buildArgs({ permissionMode: 'zomaarwat' }), ['-p', '--output-format', 'json']);
  assert.deepEqual(buildArgs({ permissionMode: '--dangerously-skip-permissions' }), [
    '-p',
    '--output-format',
    'json',
  ]);
});

// -------------------------------------------------------------- fail closed

test('FAIL CLOSED: lege ownerlijst → geen verhoging', () => {
  const r = resolveEffectivePermissionMode({
    project: writableProject(),
    item: msg(OWNER),
    ownerUserIds: [],
  });
  assert.equal(r.elevated, false);
  assert.equal(r.mode, 'acceptEdits');
  assert.equal(r.reason, 'no_owner_list');
});

test('FAIL CLOSED: ownerlijst ontbreekt of is geen array → geen verhoging', () => {
  for (const ownerUserIds of [undefined, null, 'OWNER_SYNTH_A', {}, ['']]) {
    const r = resolveEffectivePermissionMode({
      project: writableProject(),
      item: msg(OWNER),
      ownerUserIds,
    });
    assert.equal(r.elevated, false, `verhoogd bij ownerUserIds=${JSON.stringify(ownerUserIds)}`);
  }
});

test('FAIL CLOSED: ontbrekende/lege afzender-ID → geen verhoging', () => {
  for (const senderId of [undefined, null, '', '   ', 0, 12345, {}]) {
    const r = resolveEffectivePermissionMode({
      project: writableProject(),
      item: msg(senderId),
      ownerUserIds: [OWNER],
    });
    assert.equal(r.elevated, false, `verhoogd bij senderId=${JSON.stringify(senderId)}`);
    assert.equal(r.mode, 'acceptEdits');
  }
});

test('FAIL CLOSED: andere gebruiker → geen verhoging', () => {
  const r = resolveEffectivePermissionMode({
    project: writableProject(),
    item: msg(STRANGER),
    ownerUserIds: [OWNER],
  });
  assert.equal(r.elevated, false);
  assert.equal(r.reason, 'not_owner');
});

test('FAIL CLOSED: vergelijking is exact — geen prefix/type-truc', () => {
  for (const senderId of ['OWNER_SYNTH_A ', 'owner_synth_a', 'OWNER_SYNTH_AA', 'OWNER_SYNTH']) {
    const r = resolveEffectivePermissionMode({
      project: writableProject(),
      item: msg(senderId),
      ownerUserIds: [OWNER],
    });
    assert.equal(r.elevated, false, `verhoogd bij senderId=${JSON.stringify(senderId)}`);
  }
});

test('FAIL CLOSED: geen project → geen modus, geen verhoging', () => {
  const r = resolveEffectivePermissionMode({
    project: null,
    item: msg(OWNER),
    ownerUserIds: [OWNER],
  });
  assert.equal(r.elevated, false);
  assert.equal(r.mode, null);
});

test('isVerifiedOwner is strikt', () => {
  assert.equal(isVerifiedOwner(OWNER, [OWNER]), true);
  assert.equal(isVerifiedOwner(OWNER, []), false);
  assert.equal(isVerifiedOwner('', ['']), false);
  assert.equal(isVerifiedOwner(null, [OWNER]), false);
  assert.equal(isVerifiedOwner(OWNER, null), false);
});

// ------------------------------------------------- eigen beperking wint

test('/forge write off blijft een BEPERKING: owner wordt niet verhoogd', () => {
  const r = resolveEffectivePermissionMode({
    project: readOnlyProject(),
    item: msg(OWNER),
    ownerUserIds: [OWNER],
  });
  assert.equal(r.elevated, false);
  assert.equal(r.mode, 'default');
  assert.equal(r.reason, 'project_restricted');
});

test('plan-modus is ook een beperking en wint van de verhoging', () => {
  const r = resolveEffectivePermissionMode({
    project: { ...writableProject(), permissionMode: 'plan' },
    item: msg(OWNER),
    ownerUserIds: [OWNER],
  });
  assert.equal(r.elevated, false);
  assert.equal(r.mode, 'plan');
});

// ------------------------------------------------------------------ audit

test('elke verhoging wordt geaudit — met bericht-id, zonder ID-waarde', () => {
  const audit = fakeAudit();
  const resolve = createOwnerAwareProjectResolver({
    findProject: () => writableProject(),
    ownerUserIds: [OWNER],
    audit,
  });
  resolve(msg(OWNER));

  const evt = audit.events.find((e) => e.type === 'owner_permission_elevated');
  assert.ok(evt, 'geen auditgebeurtenis voor de verhoging');
  assert.equal(evt.data.from, 'acceptEdits');
  assert.equal(evt.data.to, 'bypassPermissions');
  assert.equal(evt.data.projectId, 'projA');
  assert.equal(evt.data.messageId, 'msg_1');
  assert.equal(evt.data.sender, 'owner');

  const serialized = JSON.stringify(audit.events);
  assert.ok(!serialized.includes(OWNER), 'ID-waarde lekt in de auditgebeurtenis');
  assert.ok(!Object.keys(evt.data).includes('senderId'));
});

test('een geweigerde verhoging wordt ook geaudit (geen stille stilte)', () => {
  const audit = fakeAudit();
  const resolve = createOwnerAwareProjectResolver({
    findProject: () => readOnlyProject(),
    ownerUserIds: [OWNER],
    audit,
  });
  resolve(msg(OWNER));
  const evt = audit.events.find((e) => e.type === 'owner_elevation_withheld');
  assert.ok(evt, 'geen auditgebeurtenis voor de geweigerde verhoging');
  assert.equal(evt.data.reason, 'project_restricted');
  assert.equal(evt.data.mode, 'default');
  assert.ok(!JSON.stringify(audit.events).includes(OWNER));
});

// ------------------------------------------------------------- resolver

test('resolver verhoogt zonder het opgeslagen project te muteren', () => {
  const stored = writableProject();
  const resolve = createOwnerAwareProjectResolver({
    findProject: () => stored,
    ownerUserIds: [OWNER],
    audit: fakeAudit(),
  });
  const out = resolve(msg(OWNER));
  assert.equal(out.permissionMode, 'bypassPermissions');
  assert.equal(stored.permissionMode, 'acceptEdits', 'opgeslagen project is gemuteerd');
  assert.equal(out.path, stored.path);
});

test('resolver geeft null bij een onbekend project', () => {
  const resolve = createOwnerAwareProjectResolver({
    findProject: () => null,
    ownerUserIds: [OWNER],
    audit: fakeAudit(),
  });
  assert.equal(resolve(msg(OWNER)), null);
});

test('resolver leest de ownerlijst LIVE (geen bevroren kopie)', () => {
  let owners = [];
  const resolve = createOwnerAwareProjectResolver({
    findProject: () => writableProject(),
    ownerUserIds: () => owners,
    audit: fakeAudit(),
  });
  assert.equal(resolve(msg(OWNER)).permissionMode, 'acceptEdits');
  owners = [OWNER];
  assert.equal(resolve(msg(OWNER)).permissionMode, 'bypassPermissions');
});

// ------------------------------------- REGRESSIE: bestaande weigeringen

test('REGRESSIE: andere gebruiker, bot, webhook en eigen bericht blijven geweigerd', () => {
  const gate = new PermissionGateway({ ownerUserIds: [OWNER], botUserId: () => 'BOT_SELF' });
  const base = { messageId: 'm', threadId: 't', isBot: false, isWebhook: false };

  assert.deepEqual(gate.check({ ...base, senderId: OWNER }), { allowed: true });
  assert.equal(gate.check({ ...base, senderId: STRANGER }).allowed, false);
  assert.equal(gate.check({ ...base, senderId: STRANGER }).reason, 'unauthorized_user');
  assert.equal(gate.check({ ...base, senderId: 'BOT_SELF' }).reason, 'own_message');
  assert.equal(gate.check({ ...base, senderId: 'OTHER_BOT', isBot: true }).reason, 'bot_sender');
  assert.equal(gate.check({ ...base, senderId: 'HOOK', isWebhook: true }).reason, 'webhook_sender');
  // Een bot/webhook die zich als owner voordoet blijft geweigerd.
  assert.equal(gate.check({ ...base, senderId: OWNER, isBot: true }).reason, 'bot_sender');
  assert.equal(gate.check({ ...base, senderId: OWNER, isWebhook: true }).reason, 'webhook_sender');
  // Lege ownerlijst = niemand mag iets.
  const dicht = new PermissionGateway({ ownerUserIds: [], botUserId: () => null });
  assert.equal(dicht.check({ ...base, senderId: OWNER }).allowed, false);
});

// ------------------------------------------------------- integratie (echt)

// Zelfde bedrading als src/main.js, maar over een ECHTE Router en een ECHTE
// AuditLedger op schijf: router → resolver → CLI-argumenten.
function wireLikeMain({ owners }) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-elev-'));
  const audit = new AuditLedger(path.join(stateDir, 'audit.jsonl'));
  const router = new Router({ stateDir, audit });
  router.registerProject({ projectId: 'projA', name: 'A', forumChannelId: 'chan1' });
  const resolve = createOwnerAwareProjectResolver({
    findProject: (projectId) => router.projects.find((p) => p.projectId === projectId) ?? null,
    ownerUserIds: () => owners,
    audit: { record: (type, data) => audit.record(type, data) },
  });
  return { stateDir, audit, router, resolve };
}

test('INTEGRATIE: owner-prompt levert echt --permission-mode bypassPermissions op', () => {
  const { router, resolve, audit } = wireLikeMain({ owners: [OWNER] });
  // Nieuw project staat op acceptEdits (owner-besluit 2026-07-30 "read only off").
  assert.equal(router.projects[0].permissionMode, 'acceptEdits');

  const project = resolve(msg(OWNER));
  assert.equal(project.permissionMode, 'bypassPermissions');
  assert.deepEqual(buildArgs({ permissionMode: project.permissionMode }), [
    '-p',
    '--output-format',
    'json',
    '--permission-mode',
    'bypassPermissions',
  ]);

  // Op schijf geschreven audit: gebeurtenis aanwezig, ID-waarde afwezig.
  const raw = fs.readFileSync(audit.log.filePath, 'utf8');
  assert.ok(raw.includes('owner_permission_elevated'));
  assert.ok(raw.includes('"to":"bypassPermissions"'));
  assert.ok(!raw.includes(OWNER), 'ID-waarde staat in de audit-jsonl');

  // Ook via de gelezen ledger: precies één verhoging, met bericht-id.
  const elevaties = audit.readAll().filter((e) => e.type === 'owner_permission_elevated');
  assert.equal(elevaties.length, 1);
  assert.equal(elevaties[0].messageId, 'msg_1');
  assert.equal(elevaties[0].sender, 'owner');
  assert.ok(typeof elevaties[0].ts === 'string');
});

test('INTEGRATIE: /forge write off wint van de owner-verhoging', () => {
  const { router, resolve } = wireLikeMain({ owners: [OWNER] });
  router.setPermissionMode('projA', 'default'); // = /forge write off
  const project = resolve(msg(OWNER));
  assert.equal(project.permissionMode, 'default');
  assert.deepEqual(buildArgs({ permissionMode: project.permissionMode }), [
    '-p',
    '--output-format',
    'json',
  ]);
  // …en /forge write on geeft de verhoging weer terug.
  router.setPermissionMode('projA', 'acceptEdits');
  assert.equal(resolve(msg(OWNER)).permissionMode, 'bypassPermissions');
});

test('INTEGRATIE: lege ownerlijst → mechanisme dood, project-modus blijft staan', () => {
  const { resolve } = wireLikeMain({ owners: [] });
  assert.equal(resolve(msg(OWNER)).permissionMode, 'acceptEdits');
});

test('INTEGRATIE: verhoging is niet gepersisteerd in mappings.json', () => {
  const { router, resolve, stateDir } = wireLikeMain({ owners: [OWNER] });
  resolve(msg(OWNER));
  assert.equal(router.projects[0].permissionMode, 'acceptEdits');
  const saved = JSON.parse(fs.readFileSync(path.join(stateDir, 'mappings.json'), 'utf8'));
  assert.equal(saved.projects[0].permissionMode, 'acceptEdits');
  assert.ok(!JSON.stringify(saved).includes('bypassPermissions'));
});
