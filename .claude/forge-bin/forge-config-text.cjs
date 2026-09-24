#!/usr/bin/env node
'use strict';
/**
 * forge-config-text.cjs — the nl/en wording and the plain-text renderers for forge-config.cjs (v2.7.0,
 * 2026-09-24). WHY a separate file: forge-config.cjs holds the logic (schema, precedence, validation,
 * atomic writes, change detection); this file only turns its structured results into beginner-plain
 * lines, in Dutch or English. It decides nothing about values, files or precedence — keeping the two
 * apart keeps both files a readable size and makes every sentence easy to find and translate.
 * Zero-dependency (no requires). Not a CLI — run forge-config.cjs instead.
 *
 * toAscii() folds every non-ASCII glyph (em dash, arrow, middle dot, accents) to plain 7-bit text so
 * `forge-config.cjs list --ascii` renders on any Windows console code page.
 */

const SET_BY = 'owner /forge config set';
const ONCE_BY = 'owner one-off approval: '; // set_by prefix of a `set <key> off --once "<quote>"` entry
const FLAG_ORDER = ['C', 'N', '$', 'U', 'X', 'D'];

const T = {
  nl: {
    listHeader: (p) => 'Forge instellingen — project "' + p + '" (alles staat standaard AAN; wijzig met één commando)',
    columns: ['Status', 'Instelling', 'Waarde', 'Vanwaar', 'Wat het doet'],
    on: 'AAN', off: 'UIT',
    source: { default: 'standaard', 'product-default': 'product-default', global: 'globaal', project: 'project', flag: 'vlag' },
    footnotesTitle: 'Voetnoten (wat deze instellingen met je gegevens doen)',
    flagsTitle: 'Vlaggen',
    flag: { C: 'leest inloggegevens', N: 'gebruikt internet', $: 'kost quota of geld', U: 'draait onbeheerd', X: 'leest buiten dit project', D: 'verwijdert bestanden' },
    hiddenLine: (n) => n + ' geavanceerde instelling(en) verborgen — toon alles met /forge config list --all',
    notesTitle: 'Opmerkingen',
    lockedTitle: 'Vergrendeld — altijd aan, nooit instelbaar',
    footer: 'Wijzigen: /forge config set <instelling> <waarde> · Uitleg: /forge config explain <instelling> · Alles: /forge config list --all',
    noFiles: (g, p) => 'Nog geen eigen instellingen opgeslagen (geen ' + g + ' en geen ' + p + ') — alles staat op de standaardwaarden, dat is normaal.',
    missingFile: (which, p) => (which === 'global' ? 'Geen globaal instellingenbestand (' : 'Geen instellingenbestand voor dit project (') + p + ') — daar gelden de standaardwaarden, dat is normaal.',
    scopeIgnored: (k) => k + ' geldt voor de hele computer; de waarde in het projectbestand wordt genegeerd. Stel het in met: /forge config set ' + k + ' <waarde> --global',
    fileLockedIgnored: (k, p) => '"' + k + '" in ' + p + ' is vergrendeld en nooit instelbaar — genegeerd.',
    fileUnknownIgnored: (k, p) => '"' + k + '" in ' + p + ' is geen bekende instelling — genegeerd (weghalen: /forge config unset ' + k + ').',
    prefsSkipped: (m) => 'Eigenaarsprofiel niet leesbaar — product-defaults overgeslagen, de schema-standaarden gelden: ' + m,
    prefUnfit: (pref, k, v) => 'Eigenaarsprofiel-voorkeur ' + pref + ' (' + v + ') past niet bij ' + k + ' — genegeerd.',
    lockSourceNote: (m) => 'De lijst met vergrendelde acties kon niet volledig worden geladen (' + m + ') — de schema-lijst blijft vergrendeld.',
    malformed: (p, reason) => 'Het bestand ' + p + ' is beschadigd (' + reason + '). Forge verandert niets tot dit is hersteld.',
    unknownKey: (k, sug) => 'Onbekende instelling "' + k + '".' + (sug ? ' Bedoelde je "' + sug + '"?' : '') + ' Alle instellingen: /forge config list',
    locked: (k, txt) => '"' + k + '" is vergrendeld en kan niet worden veranderd: ' + txt,
    invalid: {
      bool: (k, raw, ex) => k + ' moet aan of uit zijn (ook goed: on/off, ja/nee, true/false) — je gaf "' + raw + '". Voorbeeld: /forge config set ' + k + ' ' + ex,
      int: (k, raw, ex, s) => k + ' moet een heel getal tussen ' + s.min + ' en ' + s.max + ' zijn — je gaf "' + raw + '". Voorbeeld: /forge config set ' + k + ' ' + ex,
      number: (k, raw, ex, s) => k + ' moet een getal tussen ' + s.min + ' en ' + s.max + ' zijn (komma of punt mag) — je gaf "' + raw + '". Voorbeeld: /forge config set ' + k + ' ' + ex,
      enum: (k, raw, ex, s) => k + ' moet een van deze waarden zijn: ' + s.allowed.join(', ') + ' — je gaf "' + raw + '". Voorbeeld: /forge config set ' + k + ' ' + ex,
      'int-or-auto': (k, raw, ex, s) => k + ' moet "auto" of een heel getal tussen ' + s.min + ' en ' + s.max + ' zijn — je gaf "' + raw + '". Voorbeeld: /forge config set ' + k + ' ' + ex,
    },
    badFlag: (f) => 'Een --flag moet de vorm instelling=waarde hebben — je gaf "' + f + '". Voorbeeld: --flag usage-guard.pause-at=95',
    badRun: (r) => 'Ongeldige run-id "' + r + '" (alleen letters, cijfers, _ en -).',
    badLang: (l) => '--lang moet nl of en zijn — je gaf "' + l + '".',
    unknownOption: (o) => 'Onbekende optie ' + o + '. Hulp: /forge config --help',
    missingArg: (cmd, what) => '/forge config ' + cmd + ' mist ' + what + '. Hulp: /forge config ' + cmd + ' --help',
    unknownCmd: (c) => 'Onbekend commando "' + c + '". Hulp: /forge config --help',
    argKey: 'de naam van een instelling', argValue: 'een waarde', argSentence: 'een zin',
    whereGlobal: (p) => 'voor alle projecten, opgeslagen in ' + p,
    whereProject: (p) => 'alleen dit project, opgeslagen in ' + p,
    setOk: (k, a, b, where) => 'OK — ' + k + ': ' + a + ' → ' + b + ' (' + where + '). Forge gebruikt dit vanaf de volgende check.',
    setUnchanged: (k, v, where) => 'OK — ' + k + ' stond al op ' + v + ' (' + where + '). Niets veranderd.',
    autoGlobal: (k) => '(' + k + ' geldt voor de hele computer, daarom opgeslagen voor alle projecten.)',
    shadowed: (k, v, src, cmd) => 'Let op: ' + k + ' blijft voorlopig ' + v + ', omdat de ' + src + '-waarde voorgaat. Weghalen: ' + cmd,
    disclosure: (d) => 'Wat dit doet: ' + d,
    unsetOk: (k, files, v, src) => 'OK — ' + k + ' verwijderd uit ' + files + '. Nu: ' + v + ' [' + src + '].',
    unsetNone: (k, v, src) => k + ' was niet ingesteld — niets veranderd. Nu: ' + v + ' [' + src + '].',
    resetPlan: (n, p, keys, cmd) => (n ? 'Dit verwijdert ' + n + ' instelling(en) uit ' + p + ': ' + keys + '. Bevestig met: ' + cmd : 'Er staat niets in ' + p + ' — er valt niets te resetten.'),
    resetOk: (n, p) => 'OK — ' + n + ' instelling(en) verwijderd uit ' + p + '; die staan weer op de standaardwaarde.',
    diffFirst: (n) => 'instellingen geladen (' + n + ')',
    diffNone: (n) => 'Geen gewijzigde instellingen (' + n + ' gecontroleerd).',
    diffTitle: (n) => n + ' instelling(en) gewijzigd sinds de vorige keer:',
    diffLogged: (r) => 'Gelogd als config_changed in run ' + r + '.',
    diffNotLogged: (r, why) => 'Waarschuwing: config_changed kon niet worden gelogd in run ' + r + ' (' + why + ') — de wijziging blijft als nieuw staan tot het loggen lukt.',
    whoYou: 'jij, /forge config set', whoFlag: 'vlag voor deze run', whoDefault: 'terug naar standaard', whoProfile: 'eigenaarsprofiel',
    newValue: '(nieuw)',
    ago: { now: 'zojuist', min: (n) => n + ' min geleden', hour: (n) => n + ' uur geleden', day: (n) => (n === 1 ? '1 dag geleden' : n + ' dagen geleden') },
    ex: { now: 'Nu', setAt: 'Ingesteld', type: 'Soort waarde', def: 'Standaard', scope: 'Geldt voor', group: 'Groep', does: 'Wat het doet', off: 'Uit / andere waarde', data: 'Let op (je gegevens)', flags: 'Vlaggen', consumers: 'Wie leest dit', change: 'Wijzigen', undo: 'Ongedaan maken' },
    scopeGlobal: 'de hele computer (alle projecten)', scopeProject: 'alleen dit project',
    types: {
      bool: () => 'aan of uit',
      int: (s) => 'heel getal van ' + s.min + ' t/m ' + s.max + (s.unit ? ' (' + s.unit + ')' : ''),
      number: (s) => 'getal van ' + s.min + ' t/m ' + s.max + (s.unit ? ' (' + s.unit + ')' : ''),
      enum: (s) => 'een van: ' + s.allowed.join(', '),
      'int-or-auto': (s) => 'auto, of een heel getal van ' + s.min + ' t/m ' + s.max,
    },
    undoFlag: 'Dit is een vlag voor alleen deze run — er is niets opgeslagen.',
    undoDefault: 'Staat op de standaardwaarde — er is niets om ongedaan te maken.',
    lockedExplain: (k, txt, src) => k + ' — vergrendeld, altijd aan, nooit instelbaar.\n' + txt + (src ? '\nBron: ' + src : ''),
    setBy: (by, at) => (by === SET_BY ? 'jij, /forge config set' : by) + (at ? ' op ' + at : ''),
    parseOk: (cmd) => 'Bedoeld: ' + cmd + '  (er is nog niets veranderd)',
    parseAmbiguous: (keys) => 'Niet eenduidig — dit kan gaan over: ' + keys.join(', ') + '. Noem de instelling precies (zie /forge config list).',
    parseNoKey: 'Geen instelling herkend. Zie /forge config list voor alle instellingen.',
    parseNoValue: (k, vals) => 'Instelling herkend: ' + k + ', maar geen eenduidige geldige waarde. Mogelijke waarden: ' + vals + '.',
    parseLocked: (id, txt) => '"' + id + '" is vergrendeld en nooit instelbaar: ' + txt,
    onceActive: (k, mins, q) => k + ' staat uit voor één commando (eenmalige toestemming' + (q ? ': "' + q + '"' : '') + '); gaat over ' + mins + ' min vanzelf weer aan, of nu meteen met: /forge config set ' + k + ' aan',
    onceExpired: (k, p) => k + ' in ' + p + ': eenmalige toestemming verlopen (expired, back on) — genegeerd, de gewone waarde geldt weer.',
    onceSet: (k, mins, q) => 'OK — ' + k + ' staat UIT voor één commando (eenmalige toestemming: "' + q + '"). Gaat na ' + mins + ' minuten vanzelf weer AAN; meteen weer aan: /forge config set ' + k + ' aan',
    onceCleared: (k) => 'De eenmalige toestemming voor ' + k + ' is opgeheven.',
    onceWho: (mins, q) => 'eenmalig, ' + mins + ' min' + (q ? ', ' + q : ''),
    onceOnlyFor: (k, keys) => '--once werkt alleen voor ' + keys.join(', ') + ', niet voor ' + k + '. Gewoon wijzigen: /forge config set ' + k + ' <waarde>',
    onceNoGlobal: (k) => '--once geldt alleen voor dit project en kan niet samen met --global (' + k + ').',
    onceOnlyOff: (k) => '--once zet ' + k + ' alleen uit voor één commando: /forge config set ' + k + ' uit --once "<de letterlijke ja van de eigenaar>"',
    onceNeedsQuote: (k) => '--once heeft de letterlijke toestemming van de eigenaar nodig, bijv. /forge config set ' + k + ' uit --once "ja, verwijder die map"',
    onceOnlySet: '--once werkt alleen met set.',
    internalError: (m) => 'forge-config: interne fout (' + m + ').',
    degradedUse: (k, w, flagged) => 'Tot dan staat ' + k + ' op ' + w + (flagged ? ' (de veilige waarde: deze instelling gebruikt je gegevens, internet of geld).' : ' (de standaardwaarde).'),
    degradedFix: (cmd) => 'Herstel het bestand, of begin opnieuw met de standaardwaarden: ' + cmd + ' (het beschadigde bestand blijft als reservekopie bewaard).',
    resetDamagedPlan: (p, to, cmd) => p + ' is beschadigd. ' + cmd + ' zet het opzij als ' + to + ' (niets wordt verwijderd) en begint opnieuw met de standaardwaarden.',
    resetDamagedOk: (p, to) => 'OK — het beschadigde ' + p + ' is bewaard als ' + to + '; alle instellingen staan weer op de standaardwaarde.',
    helpTitle: 'Forge instellingen — gebruik (Forge voert dit zelf voor je uit):',
    helpExit: 'Exitcodes: 0 ok · 1 niet gevonden · 2 ongeldige invoer of beschadigd bestand (niets geschreven) · 3 actie nodig (wijziging gevonden, bevestiging nodig, vergrendeld, of zin niet eenduidig)',
    helpCmd: {
      list: 'Toont elke instelling met waarde, herkomst en uitleg. --all toont ook de geavanceerde.',
      get: 'Toont de huidige waarde van één instelling.',
      set: 'Verandert een instelling (computerbrede instellingen gaan automatisch naar het globale bestand).',
      unset: 'Haalt je eigen waarde weg, zodat de standaard weer geldt.',
      reset: 'Haalt al je eigen waarden in het project (of met --global: op de computer) weg. Vraagt --yes.',
      explain: 'Legt één instelling uitgebreid uit: aan/uit, gegevensgebruik, wie het leest, hoe je het terugdraait.',
      diff: 'Laat zien welke instellingen sinds de vorige keer zijn veranderd.',
      parse: 'Vertaalt een gewone zin naar het precieze set-commando (verandert niets).',
    },
  },
  en: {
    listHeader: (p) => 'Forge settings — project "' + p + '" (everything is ON by default; change it with one command)',
    columns: ['Status', 'Setting', 'Value', 'From', 'What it does'],
    on: 'ON', off: 'OFF',
    source: { default: 'default', 'product-default': 'product-default', global: 'global', project: 'project', flag: 'flag' },
    footnotesTitle: 'Footnotes (what these settings do with your data)',
    flagsTitle: 'Flags',
    flag: { C: 'reads credentials', N: 'uses the network', $: 'costs quota or money', U: 'runs unattended', X: 'reads outside this project', D: 'deletes files' },
    hiddenLine: (n) => n + ' advanced setting(s) hidden — show everything with /forge config list --all',
    notesTitle: 'Notes',
    lockedTitle: 'Locked — always on, never settable',
    footer: 'Change: /forge config set <setting> <value> · Explain: /forge config explain <setting> · Everything: /forge config list --all',
    noFiles: (g, p) => 'No settings of your own saved yet (no ' + g + ' and no ' + p + ') — everything is at its default, that is normal.',
    missingFile: (which, p) => (which === 'global' ? 'No global settings file (' : 'No settings file for this project (') + p + ') — defaults apply there, that is normal.',
    scopeIgnored: (k) => k + ' is machine-wide; set it with --global (the value in the project file is ignored): /forge config set ' + k + ' <value> --global',
    fileLockedIgnored: (k, p) => '"' + k + '" in ' + p + ' is locked and never settable — ignored.',
    fileUnknownIgnored: (k, p) => '"' + k + '" in ' + p + ' is not a known setting — ignored (remove it: /forge config unset ' + k + ').',
    prefsSkipped: (m) => 'Owner profile unreadable — product defaults skipped, the schema defaults apply: ' + m,
    prefUnfit: (pref, k, v) => 'Owner-profile pref ' + pref + ' (' + v + ') does not fit ' + k + ' — ignored.',
    lockSourceNote: (m) => 'The list of locked actions could not be fully loaded (' + m + ') — the schema list stays locked.',
    malformed: (p, reason) => 'The file ' + p + ' is damaged (' + reason + '). Forge changes nothing until it is fixed.',
    unknownKey: (k, sug) => 'Unknown setting "' + k + '".' + (sug ? ' Did you mean "' + sug + '"?' : '') + ' All settings: /forge config list',
    locked: (k, txt) => '"' + k + '" is locked and cannot be changed: ' + txt,
    invalid: {
      bool: (k, raw, ex) => k + ' must be on or off (also fine: yes/no, true/false, aan/uit) — you gave "' + raw + '". Example: /forge config set ' + k + ' ' + ex,
      int: (k, raw, ex, s) => k + ' must be a whole number between ' + s.min + ' and ' + s.max + ' — you gave "' + raw + '". Example: /forge config set ' + k + ' ' + ex,
      number: (k, raw, ex, s) => k + ' must be a number between ' + s.min + ' and ' + s.max + ' — you gave "' + raw + '". Example: /forge config set ' + k + ' ' + ex,
      enum: (k, raw, ex, s) => k + ' must be one of: ' + s.allowed.join(', ') + ' — you gave "' + raw + '". Example: /forge config set ' + k + ' ' + ex,
      'int-or-auto': (k, raw, ex, s) => k + ' must be "auto" or a whole number between ' + s.min + ' and ' + s.max + ' — you gave "' + raw + '". Example: /forge config set ' + k + ' ' + ex,
    },
    badFlag: (f) => 'A --flag must look like setting=value — you gave "' + f + '". Example: --flag usage-guard.pause-at=95',
    badRun: (r) => 'Invalid run id "' + r + '" (letters, digits, _ and - only).',
    badLang: (l) => '--lang must be nl or en — you gave "' + l + '".',
    unknownOption: (o) => 'Unknown option ' + o + '. Help: /forge config --help',
    missingArg: (cmd, what) => '/forge config ' + cmd + ' needs ' + what + '. Help: /forge config ' + cmd + ' --help',
    unknownCmd: (c) => 'Unknown command "' + c + '". Help: /forge config --help',
    argKey: 'the name of a setting', argValue: 'a value', argSentence: 'a sentence',
    whereGlobal: (p) => 'for all projects, saved in ' + p,
    whereProject: (p) => 'this project only, saved in ' + p,
    setOk: (k, a, b, where) => 'OK — ' + k + ': ' + a + ' → ' + b + ' (' + where + '). Forge uses this from the next check on.',
    setUnchanged: (k, v, where) => 'OK — ' + k + ' was already ' + v + ' (' + where + '). Nothing changed.',
    autoGlobal: (k) => '(' + k + ' is machine-wide, so it was saved for all projects.)',
    shadowed: (k, v, src, cmd) => 'Heads-up: ' + k + ' stays ' + v + ' for now because the ' + src + ' value wins. Remove it: ' + cmd,
    disclosure: (d) => 'What this does: ' + d,
    unsetOk: (k, files, v, src) => 'OK — ' + k + ' removed from ' + files + '. Now: ' + v + ' [' + src + '].',
    unsetNone: (k, v, src) => k + ' was not set — nothing changed. Now: ' + v + ' [' + src + '].',
    resetPlan: (n, p, keys, cmd) => (n ? 'This removes ' + n + ' setting(s) from ' + p + ': ' + keys + '. Confirm with: ' + cmd : 'There is nothing in ' + p + ' — nothing to reset.'),
    resetOk: (n, p) => 'OK — ' + n + ' setting(s) removed from ' + p + '; they are back at their defaults.',
    diffFirst: (n) => 'settings loaded (' + n + ')',
    diffNone: (n) => 'No changed settings (' + n + ' checked).',
    diffTitle: (n) => n + ' setting(s) changed since last time:',
    diffLogged: (r) => 'Logged as config_changed in run ' + r + '.',
    diffNotLogged: (r, why) => 'Warning: config_changed could not be logged in run ' + r + ' (' + why + ') — the change stays new until logging works.',
    whoYou: 'you, /forge config set', whoFlag: 'per-run flag', whoDefault: 'back to default', whoProfile: 'owner profile',
    newValue: '(new)',
    ago: { now: 'just now', min: (n) => n + ' min ago', hour: (n) => n + ' h ago', day: (n) => (n === 1 ? '1 day ago' : n + ' days ago') },
    ex: { now: 'Now', setAt: 'Set', type: 'Kind of value', def: 'Default', scope: 'Applies to', group: 'Group', does: 'What it does', off: 'Off / other value', data: 'Heads-up (your data)', flags: 'Flags', consumers: 'Who reads it', change: 'Change', undo: 'Undo' },
    scopeGlobal: 'this whole machine (all projects)', scopeProject: 'this project only',
    types: {
      bool: () => 'on or off',
      int: (s) => 'whole number from ' + s.min + ' to ' + s.max + (s.unit ? ' (' + s.unit + ')' : ''),
      number: (s) => 'number from ' + s.min + ' to ' + s.max + (s.unit ? ' (' + s.unit + ')' : ''),
      enum: (s) => 'one of: ' + s.allowed.join(', '),
      'int-or-auto': (s) => 'auto, or a whole number from ' + s.min + ' to ' + s.max,
    },
    undoFlag: 'This is a flag for this run only — nothing was stored.',
    undoDefault: 'It is at its default — there is nothing to undo.',
    lockedExplain: (k, txt, src) => k + ' — locked, always on, never settable.\n' + txt + (src ? '\nSource: ' + src : ''),
    setBy: (by, at) => (by === SET_BY ? 'you, /forge config set' : by) + (at ? ' at ' + at : ''),
    parseOk: (cmd) => 'Maps to: ' + cmd + '  (nothing has been changed yet)',
    parseAmbiguous: (keys) => 'Ambiguous — this could be about: ' + keys.join(', ') + '. Name the setting exactly (see /forge config list).',
    parseNoKey: 'No setting recognised. See /forge config list for every setting.',
    parseNoValue: (k, vals) => 'Setting recognised: ' + k + ', but no single valid value. Possible values: ' + vals + '.',
    parseLocked: (id, txt) => '"' + id + '" is locked and never settable: ' + txt,
    onceActive: (k, mins, q) => k + ' is off for one command only (one-off approval' + (q ? ': "' + q + '"' : '') + '); it switches back on by itself in ' + mins + ' min, or right now with: /forge config set ' + k + ' on',
    onceExpired: (k, p) => k + ' in ' + p + ': one-off approval expired, back on the normal value — the expired entry is ignored.',
    onceSet: (k, mins, q) => 'OK — ' + k + ' is OFF for one command only (one-off approval: "' + q + '"). It switches back ON by itself after ' + mins + ' minutes; back on right away: /forge config set ' + k + ' on',
    onceCleared: (k) => 'The one-off approval for ' + k + ' is cleared.',
    onceWho: (mins, q) => 'one-off, ' + mins + ' min' + (q ? ', ' + q : ''),
    onceOnlyFor: (k, keys) => '--once only works for ' + keys.join(', ') + ', not for ' + k + '. Change it normally: /forge config set ' + k + ' <value>',
    onceNoGlobal: (k) => '--once is for this project only and cannot be combined with --global (' + k + ').',
    onceOnlyOff: (k) => '--once only switches ' + k + ' off for one command: /forge config set ' + k + ' off --once "<the owner\'s exact yes>"',
    onceNeedsQuote: (k) => '--once needs the owner\'s exact words of approval, e.g. /forge config set ' + k + ' off --once "yes, delete that folder"',
    onceOnlySet: '--once only works with set.',
    internalError: (m) => 'forge-config: internal error (' + m + ').',
    degradedUse: (k, w, flagged) => 'Until then ' + k + ' = ' + w + (flagged ? ' (the safe value: this setting uses your data, the network or money).' : ' (its default).'),
    degradedFix: (cmd) => 'Fix the file, or start over with the defaults: ' + cmd + ' (the damaged file is kept as a backup).',
    resetDamagedPlan: (p, to, cmd) => p + ' is damaged. ' + cmd + ' moves it aside as ' + to + ' (nothing is deleted) and starts over with the defaults.',
    resetDamagedOk: (p, to) => 'OK — the damaged ' + p + ' is kept as ' + to + '; every setting is back at its default.',
    helpTitle: 'Forge settings — usage (Forge runs this for you):',
    helpExit: 'Exit codes: 0 ok · 1 not found · 2 invalid input or damaged file (nothing written) · 3 act on this (change found, confirmation needed, locked, or sentence ambiguous)',
    helpCmd: {
      list: 'Shows every setting with its value, where it comes from and what it does. --all adds the advanced ones.',
      get: 'Shows the current value of one setting.',
      set: 'Changes a setting (machine-wide settings go to the global file automatically).',
      unset: 'Removes your own value so the default applies again.',
      reset: 'Removes all your own values in this project (or with --global: on this machine). Needs --yes.',
      explain: 'Explains one setting in full: on/off, data use, who reads it, how to undo it.',
      diff: 'Shows which settings changed since last time.',
      parse: 'Turns a plain sentence into the exact set command (changes nothing).',
    },
  },
};

const USAGE = {
  list: 'list [--all] [--json] [--lang nl|en] [--ascii] [--flag <setting>=<value>]...',
  get: 'get <setting> [--json] [--flag <setting>=<value>]...',
  set: 'set <setting> <value> [--global] [--json]   ·   set gate-hook off --once "<the owner\'s exact yes>" (one command, 10 min)',
  unset: 'unset <setting> [--global] [--json]',
  reset: 'reset [--global] --yes [--json]',
  explain: 'explain <setting> [--lang nl|en] [--json]',
  diff: 'diff [--mark-seen] [--run <id>] [--flag <setting>=<value>]... [--json]',
  parse: 'parse "<sentence>" [--json]',
};

function t(lang) { return T[lang] || T.en; }

// ---- ASCII folding (for old console code pages) ----
const ASCII_MAP = {
  '\u2014': '-', '\u2013': '-', '\u2192': '->', '\u00b7': '-', '\u2026': '...', '\u2018': "'", '\u2019': "'",
  '\u201c': '"', '\u201d': '"', '\u2265': '>=', '\u2264': '<=', '\u00d7': 'x', '\u20ac': 'EUR', '\u00a0': ' ',
};
function toAscii(s) {
  const mapped = String(s).replace(/[\u2014\u2013\u2192\u00b7\u2026\u2018\u2019\u201c\u201d\u2265\u2264\u00d7\u20ac\u00a0]/g, (c) => ASCII_MAP[c]);
  return mapped.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x00-\x7f]/g, '?');
}

// ---- layout helpers ----
function wrap(str, width) {
  const words = String(str).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= width) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
  }
  lines.push(cur);
  return lines;
}
function hanging(str, width, indent) {
  return wrap(str, Math.max(20, width - indent)).map((l, i) => (i ? ' '.repeat(indent) : '') + l);
}
function clampWidth(w) {
  const n = Number(w) || 120;
  return Math.max(80, Math.min(200, n));
}
function statusWord(status, lang) { return status === 'on' ? t(lang).on : status === 'off' ? t(lang).off : '-'; }
function sourceLabel(src, lang) { return t(lang).source[src] || src; }

function relTime(iso, nowMs, lang) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const a = t(lang).ago;
  const s = Math.max(0, Math.round((nowMs - at) / 1000));
  if (s < 60) return a.now;
  const m = Math.round(s / 60);
  if (m < 60) return a.min(m);
  const h = Math.round(m / 60);
  if (h < 48) return a.hour(h);
  return a.day(Math.round(h / 24));
}

/** changeLine(c, lang, nowMs, arrow) — one human line per changed setting, e.g.
 *  "usage-guard.pause-at: 95 → 98 (jij, /forge config set, 2 min geleden)". c carries from_word/to_word
 *  (already rendered by forge-config.cjs) plus source/set_by/set_at. */
function changeLine(c, lang, nowMs, arrow) {
  const x = t(lang);
  let who;
  const once = c.expires_at && typeof c.set_by === 'string' && c.set_by.startsWith(ONCE_BY);
  if (once) who = x.onceWho(Math.round((Date.parse(c.expires_at) - Date.parse(c.set_at)) / 60000) || 10, c.set_by.slice(ONCE_BY.length));
  else if (c.source === 'flag') who = x.whoFlag;
  else if (c.source === 'default') who = x.whoDefault;
  else if (c.source === 'product-default') who = x.whoProfile;
  else who = c.set_by === SET_BY ? x.whoYou : (c.set_by || sourceLabel(c.source, lang));
  const when = c.set_at && !once ? relTime(c.set_at, nowMs, lang) : null;
  const from = c.from_word == null ? x.newValue : c.from_word;
  return c.key + ': ' + from + ' ' + (arrow || '→') + ' ' + c.to_word + ' (' + who + (when ? ', ' + when : '') + ')';
}

// ---- renderers (input = the structured results forge-config.cjs returns) ----
function renderList(L, o) {
  const x = t(L.lang);
  const width = clampWidth(o && o.width);
  const out = [x.listHeader(L.project), ''];
  const refs = new Map();
  for (const s of L.settings) if (s.disclosure || (s.flags && s.flags.length)) refs.set(s.key, refs.size + 1);
  const rows = L.settings.map((s) => ({ s, cells: [statusWord(s.status, L.lang), s.key, s.display, sourceLabel(s.source, L.lang)] }));
  const w = [0, 1, 2, 3].map((i) => Math.max(x.columns[i].length, ...rows.map((r) => r.cells[i].length)));
  const gap = '  ';
  const lead = w.reduce((a, b) => a + b, 0) + gap.length * 4;
  const descW = Math.max(28, width - lead);
  const pad = (cells) => cells.map((c, i) => c.padEnd(w[i])).join(gap) + gap;
  out.push(pad(x.columns.slice(0, 4)) + x.columns[4]);
  out.push(pad(w.map((n) => '-'.repeat(n))) + '-'.repeat(Math.min(descW, 40)));
  for (const g of L.groups) {
    const inGroup = rows.filter((r) => r.s.group === g.id);
    if (!inGroup.length) continue;
    out.push('', '== ' + g.title + ' ==');
    for (const r of inGroup) {
      const desc = r.s.desc + (refs.has(r.s.key) ? ' [' + refs.get(r.s.key) + ']' : '');
      const lines = wrap(desc, descW);
      out.push(pad(r.cells) + lines[0]);
      for (const more of lines.slice(1)) out.push(' '.repeat(lead) + more);
    }
  }
  if (refs.size) {
    const used = new Set();
    out.push('', x.footnotesTitle + ':');
    for (const s of L.settings) {
      if (!refs.has(s.key)) continue;
      const fl = s.flags || [];
      fl.forEach((f) => used.add(f));
      const body = s.disclosure || fl.map((f) => x.flag[f]).join('; ');
      out.push(...hanging('[' + refs.get(s.key) + '] ' + s.key + (fl.length ? ' (' + fl.join(' ') + ')' : '') + ': ' + body, width, 4));
    }
    const legend = FLAG_ORDER.filter((f) => used.has(f)).map((f) => f + ' = ' + x.flag[f]).join(' · ');
    if (legend) out.push(...hanging(x.flagsTitle + ': ' + legend, width, 2));
  }
  if (L.hidden) out.push('', x.hiddenLine(L.hidden));
  if (L.notes && L.notes.length) {
    out.push('', x.notesTitle + ':');
    for (const n of L.notes) out.push(...hanging('- ' + n, width, 2));
  }
  out.push('', ...hanging(x.lockedTitle + ': ' + L.locked.map((l) => l.id + ' (' + l.text + ')').join(' · '), width, 2));
  out.push('', x.footer);
  return out.join('\n');
}

function renderGet(e, lang) {
  return [e.key + ' = ' + e.display + ' [' + sourceLabel(e.source, lang) + '] ' + e.desc].concat((e.notes || []).map((n) => '- ' + n)).join('\n');
}

function renderSet(R, lang) {
  const x = t(lang);
  if (R.once) return x.onceSet(R.key, R.once.minutes, R.once.quote);
  const where = R.scope === 'global' ? x.whereGlobal(R.file_pretty) : x.whereProject(R.file_pretty);
  const same = R.cleared_once ? R.from_word === R.to_word : R.unchanged;
  const out = [same ? x.setUnchanged(R.key, R.to_word, where) : x.setOk(R.key, R.from_word, R.to_word, where)];
  if (R.cleared_once) out.push(x.onceCleared(R.key));
  if (R.auto_global) out.push(x.autoGlobal(R.key));
  if (R.shadow) out.push(x.shadowed(R.key, R.shadow.display, sourceLabel(R.shadow.source, lang), R.shadow.undo));
  if (R.disclosure) out.push(x.disclosure(R.disclosure));
  return out.join('\n');
}

function renderUnset(R, lang) {
  const x = t(lang);
  const src = sourceLabel(R.entry ? R.entry.source : 'default', lang);
  const now = R.entry ? R.entry.display : '-';
  return R.removed ? x.unsetOk(R.key, R.files_pretty.join(' + '), now, src) : x.unsetNone(R.key, now, src);
}

function renderReset(R, lang) {
  const x = t(lang);
  if (R.damaged) return R.confirmed ? x.resetDamagedOk(R.file_pretty, R.moved_to_pretty) : x.resetDamagedPlan(R.file_pretty, R.moved_to_pretty, '/forge config reset' + (R.global ? ' --global' : '') + ' --yes');
  if (R.confirmed) return x.resetOk(R.removed.length, R.file_pretty);
  return x.resetPlan(R.would_remove.length, R.file_pretty, R.would_remove.join(', '), '/forge config reset' + (R.global ? ' --global' : '') + ' --yes');
}

function renderExplain(E, lang) {
  const x = t(lang);
  if (E.locked) return x.lockedExplain(E.key, E.text, E.source);
  const L = x.ex;
  const e = E.current;
  const row = (label, val) => (val == null || val === '' ? null : label + ': ' + val);
  const out = [E.key + ' — ' + E.desc];
  out.push(row(L.now, e.display + '  [' + sourceLabel(e.source, lang) + ']'));
  if (e.set_by || e.set_at) out.push(row(L.setAt, x.setBy(e.set_by || '-', e.set_at)));
  out.push(row(L.type, x.types[E.type](E)));
  out.push(row(L.def, E.default_display));
  out.push(row(L.scope, E.scope === 'global' ? x.scopeGlobal : x.scopeProject));
  out.push(row(L.group, E.group_title));
  out.push(row(L.off, E.off_means));
  out.push(row(L.data, E.disclosure));
  if (E.flags.length) out.push(row(L.flags, E.flags.map((f) => f.flag + ' = ' + f.meaning).join(' · ')));
  out.push(row(L.consumers, E.consumers.join(', ')));
  out.push(row(L.change, E.change_example));
  out.push(row(L.undo, E.undo.command || E.undo.text));
  for (const n of E.notes || []) out.push('- ' + n);
  return out.filter((l) => l != null).join('\n');
}

function renderDiff(D, lang) {
  const x = t(lang);
  if (D.first_run) return x.diffFirst(D.count);
  if (!D.changed.length) return x.diffNone(D.count);
  const out = [x.diffTitle(D.changed.length)].concat(D.lines.map((l) => '  ' + l));
  if (D.run) out.push(D.logged ? x.diffLogged(D.run) : x.diffNotLogged(D.run, String(D.stderr || D.status || '').split(/\r?\n/)[0] || 'unknown'));
  return out.join('\n');
}

function renderHelp(lang, cmd) {
  const x = t(lang);
  const cmds = cmd && USAGE[cmd] ? [cmd] : Object.keys(USAGE);
  const out = [x.helpTitle];
  for (const c of cmds) out.push('  /forge config ' + USAGE[c], '      ' + x.helpCmd[c]);
  out.push('  (terminal: node .claude/forge-bin/forge-config.cjs <command> ...)', x.helpExit);
  return out.join('\n');
}

module.exports = {
  t, toAscii, wrap, relTime, changeLine, statusWord, sourceLabel,
  renderList, renderGet, renderSet, renderUnset, renderReset, renderExplain, renderDiff, renderHelp,
  SET_BY, ONCE_BY, FLAG_ORDER, USAGE,
};
