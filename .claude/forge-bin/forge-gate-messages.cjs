#!/usr/bin/env node
'use strict';
/**
 * forge-gate-messages.cjs — the plain-language NL/EN wording for forge-gate-hook.cjs's block/notice text (wp-v3,
 * split out so BOTH the main thread (forge-gate-hook.cjs) and the worker_threads Worker
 * (forge-gate-classify-worker.cjs, via forge-gate-inspect.cjs) build the EXACT SAME message text from ONE
 * source, instead of forge-gate-hook.cjs's copy risking drift from a second copy inside the worker. Pure
 * string-only functions, zero dependencies, no I/O — never a performance concern of any kind.
 */
const MAX_NOTICE_CHARS = 300;
const ONCE_HINT = 'node .claude/forge-bin/forge-config.cjs set gate-hook off --once "<the owner\'s words>"';

/** Plain-language wording per gate — what the command does, and the safe variant to offer. */
const WORDS = {
  'destructive-delete': {
    nl: 'dit commando verwijdert een hele map in één keer, zonder prullenbak',
    en: 'this command deletes a whole folder tree at once, with no recycle bin',
    safeNl: 'noem het exacte pad en controleer het eerst, verwijder losse bestanden, of ruim alleen op binnen _scratch/, node_modules/, dist/ of de tijdelijke map (dat mag zonder vragen)',
    safeEn: 'name the exact path and check it first, delete single files, or clean up only inside _scratch/, node_modules/, dist/ or the temp folder (allowed without asking)',
  },
  'kill-by-name': {
    nl: 'dit commando stopt ALLE processen met die naam, ook andere draaiende diensten',
    en: 'this command kills EVERY process with that name, including unrelated running services',
    safeNl: 'stop alleen het exacte PID dat je zelf gestart hebt (taskkill /PID <pid>, Stop-Process -Id <pid>)',
    safeEn: 'kill only the exact PID you started yourself (taskkill /PID <pid>, Stop-Process -Id <pid>)',
  },
  'git-destructive': {
    nl: 'dit commando gooit onvastgelegd werk weg',
    en: 'this command discards uncommitted work',
    safeNl: 'commit of stash eerst (git stash push), dan is het terug te halen',
    safeEn: 'commit or stash first (git stash push), so it can be recovered',
  },
  'opaque-exec': {
    nl: 'Forge kan niet zien wat dit commando echt zou uitvoeren (het geeft onbekende of gedecodeerde inhoud door aan een interpreter)',
    en: 'Forge cannot see what this would run (it hands unknown or decoded content to an interpreter)',
    safeNl: 'schrijf het commando voluit uit (geen iex/eval/sh -c op een variabele, geen pipe naar sh/bash/pwsh), of laat het als een los, leesbaar script-bestand draaien',
    safeEn: 'write the command out in full (no iex/eval/sh -c on a variable, no pipe into sh/bash/pwsh), or run it as a separate, readable script file instead',
  },
  'gate-hook-self-disable': {
    nl: 'dit commando zet de Forge-poort zelf uit',
    en: 'this command switches the Forge gate itself off',
    safeNl: 'alleen de eigenaar zet de poort uit; met een uitdrukkelijke ja van de eigenaar mag eenmalig (10 minuten): ' + ONCE_HINT,
    safeEn: 'only the owner switches the gate off; with the owner\'s explicit yes a one-off (10 minutes) is allowed: ' + ONCE_HINT,
  },
  'classifier-unavailable': {
    nl: 'de poort-classifier kon niet laden en dit commando lijkt destructief',
    en: 'the gate classifier could not load and this command looks destructive',
    safeNl: 'herstel .claude/config/orchestration/hard-gates.json of forge-actiongate.cjs (draai de doctor)',
    safeEn: 'restore .claude/config/orchestration/hard-gates.json or forge-actiongate.cjs (run the doctor)',
  },
  'command-too-large': {
    nl: 'dit commando is te groot om veilig te controleren (of duurde te lang om te beoordelen)',
    en: 'this command is too large to inspect safely (or took too long to judge)',
    safeNl: 'splits het commando op in kleinere stappen, of schrijf het als een los, leesbaar script-bestand',
    safeEn: 'split the command into smaller steps, or run it as a separate, readable script file instead',
  },
};

const cap = (s) => (s.length > MAX_NOTICE_CHARS ? s.slice(0, MAX_NOTICE_CHARS - 1) + '…' : s);

function blockReason(ids) {
  const lines = ['FORGE GATE (' + ids.join(', ') + '):'];
  for (const id of ids) {
    const w = WORDS[id] || WORDS['classifier-unavailable'];
    lines.push('- ' + w.nl + ' — Forge vraagt eerst. / ' + w.en + ' — Forge asks first.');
    lines.push('  Veilige variant: ' + w.safeNl + '. / Safe variant: ' + w.safeEn + '.');
  }
  lines.push('Forge biedt eerst de veilige variant aan (een gedateerde back-upmap in plaats van verwijderen, alleen dat ene proces stoppen op zijn exacte PID, eerst committen of stashen voordat er iets wordt weggegooid); alleen als de eigenaar uitdrukkelijk ja zegt tegen DIT commando, voert Forge zelf de eenmalige toestemming uit: ' + ONCE_HINT + '.');
  lines.push('Forge offers the safe variant first (dated backup folder instead of delete, stop the one process by its exact PID, commit or stash before discarding); only when the owner explicitly says yes to THIS command does Forge run the one-off approval itself: ' + ONCE_HINT + '.');
  return lines.join('\n');
}

const passNotice = (targets) => cap('FORGE GATE: destructive delete allowed — all targets inside a project scratch area or in the OS temp dir outside the project (' + targets.join(', ') + ')');

module.exports = { WORDS, ONCE_HINT, MAX_NOTICE_CHARS, cap, blockReason, passNotice };
