'use strict';
/* Forge Control Center — i18n layer (zero-dependency, presentation-only).
   English is the default and the fallback. Real data (agent names, file paths, events, reports)
   is NEVER translated — only UI chrome (labels, headings, tabs, buttons, tooltips). This file does
   NOT touch server.cjs data logic; it only re-labels what the browser already renders.

   How it works:
   - STRINGS holds one flat key->text table per locale. `en` is complete and authoritative.
   - t(key, fallback) returns the current-locale string, else the English string, else the caller's
     fallback (the literal English already in the DOM/JS). Because English is always the fallback,
     a missing translation degrades gracefully to English and never breaks the UI.
   - Static labels carry data-i18n / data-i18n-title / data-i18n-aria attributes and are translated by
     apply(). Dynamic labels (rebuilt via innerHTML in app.js/panels.js) call window.i18nt(key, english).
   - Locale is auto-detected from navigator.language (prefix match), overridable by the visible toggle,
     and remembered in localStorage('forge_lang').

   To add a locale: add a `<code>: { ... }` block to STRINGS mirroring the `en` keys, then add the code to
   AVAILABLE and a display name to LOCALE_NAMES. See docs/INTERNATIONALIZATION.md. Translations welcome. */

(function () {
  const AVAILABLE = ['en', 'nl'];
  const LOCALE_NAMES = { en: 'English', nl: 'Nederlands' };

  const STRINGS = {
    en: {
      // top bar / stats
      'stat.events': 'Events', 'stat.agents': 'Agents', 'stat.files': 'Files', 'stat.port': 'Port',
      'btn.copyUrl': 'Copy URL', 'btn.copied': 'Copied ✓', 'badge.complete': 'COMPLETE',
      'lang.label': 'Language',
      // run state words
      'run.idle': 'IDLE', 'run.building': 'BUILDING', 'run.complete': 'COMPLETE', 'run.failed': 'FAILED',
      'run.armed': 'ARMED — AWAITING START',
      // panel headings
      'head.agentGroups': 'AGENT GROUPS', 'head.liveActivity': 'LIVE ACTIVITY', 'head.summaryMetrics': 'SUMMARY METRICS',
      'ins.selectedAgent': 'SELECTED AGENT', 'ins.selectPrompt': 'Select an agent to inspect it.',
      // summary-metric row keys
      'metric.buildProgress': 'Build Progress', 'metric.criticalPath': 'Critical Path', 'metric.nextStep': 'Next Step',
      'metric.eta': 'Est. Completion', 'metric.eccMode': 'ECC Mode', 'metric.eccAgents': 'ECC Agents',
      'metric.fallback': 'Fallback', 'metric.subagents': 'Subagents', 'metric.reworkLoop': 'Rework Loop',
      'metric.session': 'Session', 'metric.claudemd': 'CLAUDE.md', 'metric.customSkills': 'Custom Skills',
      'metric.codex': 'Codex', 'metric.browserProof': 'Browser Proof',
      // canvas edge legend
      'legend.criticalPath': 'Critical path', 'legend.dataFlow': 'Data flow', 'legend.handoff': 'Handoff',
      'legend.waiting': 'Waiting', 'legend.reviewLoop': 'Review loop', 'legend.artifactFlow': 'Artifact flow',
      'legend.blocked': 'Blocked',
      'act.viewAll': 'View all events →',
      // status legend + status chips
      'status.done': 'COMPLETED', 'status.running': 'RUNNING', 'status.failed': 'FAILED', 'status.waiting': 'WAITING',
      'status.previewing': 'PREVIEWING', 'status.internal': 'INTERNAL ONLY',
      'legend.st.running': 'Running', 'legend.st.done': 'Completed', 'legend.st.waiting': 'Waiting',
      'legend.st.previewing': 'Previewing', 'legend.st.failed': 'Failed', 'legend.st.internal': 'Internal only',
      // inspector tabs
      'tab.summary': 'Summary', 'tab.wp': 'Work Package', 'tab.notes': 'Notes', 'tab.inputs': 'Inputs',
      'tab.files': 'Files', 'tab.output': 'Output', 'tab.evidence': 'Evidence', 'tab.handoff': 'Handoff',
      'tab.events': 'Events',
      // activity filters
      'filter.all': 'All', 'filter.agents': 'Agents', 'filter.files': 'Files', 'filter.checks': 'Checks',
      'filter.errors': 'Errors',
      // dock tabs
      'dock.log': 'Live Log', 'dock.files': 'Files Changed', 'dock.memory': 'Memory Status', 'dock.report': 'Final Report',
      'dock.preview': 'Preview', 'dock.board': 'Agent Board', 'dock.tickets': 'Tickets', 'dock.prd': 'PRD',
      'dock.vault': 'Vault', 'dock.gates': 'Gates', 'dock.trust': 'Proof/Trust', 'dock.cost': 'Cost',
      'dock.doctor': 'Doctor', 'dock.bosses': 'Bosses',
      // viewport / replay tooltips
      'tip.zoomOut': 'Zoom out (−)', 'tip.zoomIn': 'Zoom in (+)', 'tip.fit': 'Fit (f)',
      'tip.replay': 'Replay / Pause', 'tip.speed': 'Replay speed', 'tip.reset': 'Reset to start', 'tip.live': 'Jump to live',
      'rp.liveRun': 'Live run', 'rp.replaying': 'Replaying', 'rp.completedRun': 'Completed run — Replay available'
    },
    nl: {
      'stat.events': 'Gebeurtenissen', 'stat.agents': 'Agents', 'stat.files': 'Bestanden', 'stat.port': 'Poort',
      'btn.copyUrl': 'URL kopiëren', 'btn.copied': 'Gekopieerd ✓', 'badge.complete': 'VOLTOOID',
      'lang.label': 'Taal',
      'run.idle': 'INACTIEF', 'run.building': 'BEZIG', 'run.complete': 'VOLTOOID', 'run.failed': 'MISLUKT',
      'run.armed': 'GEREED — WACHT OP START',
      'head.agentGroups': 'AGENTGROEPEN', 'head.liveActivity': 'LIVE ACTIVITEIT', 'head.summaryMetrics': 'SAMENVATTING',
      'ins.selectedAgent': 'GESELECTEERDE AGENT', 'ins.selectPrompt': 'Selecteer een agent om te inspecteren.',
      'metric.buildProgress': 'Bouwvoortgang', 'metric.criticalPath': 'Kritiek pad', 'metric.nextStep': 'Volgende stap',
      'metric.eta': 'Verwachte voltooiing', 'metric.eccMode': 'ECC-modus', 'metric.eccAgents': 'ECC-agents',
      'metric.fallback': 'Terugval', 'metric.subagents': 'Subagents', 'metric.reworkLoop': 'Herwerk-lus',
      'metric.session': 'Sessie', 'metric.claudemd': 'CLAUDE.md', 'metric.customSkills': 'Eigen skills',
      'metric.codex': 'Codex', 'metric.browserProof': 'Browserbewijs',
      'legend.criticalPath': 'Kritiek pad', 'legend.dataFlow': 'Datastroom', 'legend.handoff': 'Overdracht',
      'legend.waiting': 'Wachtend', 'legend.reviewLoop': 'Review-lus', 'legend.artifactFlow': 'Artefactstroom',
      'legend.blocked': 'Geblokkeerd',
      'act.viewAll': 'Alle gebeurtenissen →',
      'status.done': 'VOLTOOID', 'status.running': 'ACTIEF', 'status.failed': 'MISLUKT', 'status.waiting': 'WACHTEND',
      'status.previewing': 'VOORBEELD', 'status.internal': 'ALLEEN INTERN',
      'legend.st.running': 'Actief', 'legend.st.done': 'Voltooid', 'legend.st.waiting': 'Wachtend',
      'legend.st.previewing': 'Voorbeeld', 'legend.st.failed': 'Mislukt', 'legend.st.internal': 'Alleen intern',
      'tab.summary': 'Samenvatting', 'tab.wp': 'Werkpakket', 'tab.notes': 'Notities', 'tab.inputs': 'Invoer',
      'tab.files': 'Bestanden', 'tab.output': 'Uitvoer', 'tab.evidence': 'Bewijs', 'tab.handoff': 'Overdracht',
      'tab.events': 'Gebeurtenissen',
      'filter.all': 'Alle', 'filter.agents': 'Agents', 'filter.files': 'Bestanden', 'filter.checks': 'Controles',
      'filter.errors': 'Fouten',
      'dock.log': 'Live logboek', 'dock.files': 'Gewijzigde bestanden', 'dock.memory': 'Geheugenstatus',
      'dock.report': 'Eindrapport', 'dock.preview': 'Voorbeeld', 'dock.board': 'Agentbord', 'dock.tickets': 'Tickets',
      'dock.prd': 'PRD', 'dock.vault': 'Kluis', 'dock.gates': 'Poorten', 'dock.trust': 'Bewijs/Vertrouwen',
      'dock.cost': 'Kosten', 'dock.doctor': 'Doctor', 'dock.bosses': 'Bosses',
      'tip.zoomOut': 'Uitzoomen (−)', 'tip.zoomIn': 'Inzoomen (+)', 'tip.fit': 'Passend maken (f)',
      'tip.replay': 'Herhalen / Pauzeren', 'tip.speed': 'Herhaalsnelheid', 'tip.reset': 'Terug naar begin',
      'tip.live': 'Naar live springen', 'rp.liveRun': 'Live run', 'rp.replaying': 'Herhalen', 'rp.completedRun': 'Voltooide run — herhaling beschikbaar'
    }
  };

  function detect() {
    let saved;
    try { saved = localStorage.getItem('forge_lang'); } catch (e) { /* storage may be blocked */ }
    if (saved && STRINGS[saved]) return saved;
    const nav = (navigator.language || navigator.userLanguage || 'en').toLowerCase().split('-')[0];
    return STRINGS[nav] ? nav : 'en';
  }

  let current = detect();

  function t(key, fallback) {
    const tbl = STRINGS[current] || {};
    if (Object.prototype.hasOwnProperty.call(tbl, key)) return tbl[key];
    const en = STRINGS.en || {};
    if (Object.prototype.hasOwnProperty.call(en, key)) return en[key];
    return fallback != null ? fallback : key;
  }

  function apply(root) {
    root = root || document;
    root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.getAttribute('data-i18n'), el.textContent); });
    root.querySelectorAll('[data-i18n-title]').forEach((el) => { el.setAttribute('title', t(el.getAttribute('data-i18n-title'), el.getAttribute('title') || '')); });
    root.querySelectorAll('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria'), el.getAttribute('aria-label') || '')); });
  }

  function nextLocale() { const i = AVAILABLE.indexOf(current); return AVAILABLE[(i + 1) % AVAILABLE.length]; }
  function localeName(loc) { return LOCALE_NAMES[loc] || loc; }

  function updateToggle() {
    const b = document.getElementById('lang-toggle');
    if (!b) return;
    b.textContent = current.toUpperCase();
    const nx = nextLocale();
    const label = t('lang.label', 'Language') + ': ' + localeName(current) + ' → ' + localeName(nx);
    b.title = label; b.setAttribute('aria-label', label);
  }

  function setLocale(loc) {
    if (!STRINGS[loc]) loc = 'en';
    current = loc;
    try { localStorage.setItem('forge_lang', loc); } catch (e) { /* storage may be blocked */ }
    document.documentElement.setAttribute('lang', loc);
    apply(document);
    updateToggle();
    // Re-render dynamic labels (tabs, filters, status chips) through the live render path.
    if (typeof window.renderAll === 'function') { try { window.renderAll(); } catch (e) { /* render owns its own errors */ } }
  }

  function injectStyle() {
    if (document.getElementById('forge-i18n-style')) return;
    const s = document.createElement('style');
    s.id = 'forge-i18n-style';
    s.textContent = '.lang-toggle{cursor:pointer;font:inherit;font-size:11px;font-weight:600;letter-spacing:.05em;' +
      'padding:2px 8px;margin-left:6px;border-radius:5px;border:1px solid var(--line,#2a2f36);' +
      'background:var(--panel,#12151a);color:var(--fg,#c9d1d9);opacity:.85}' +
      '.lang-toggle:hover{opacity:1;border-color:var(--accent,#46e08a)}' +
      '.lang-toggle:focus-visible{outline:2px solid var(--accent,#46e08a);outline-offset:1px}';
    document.head.appendChild(s);
  }

  function boot() {
    injectStyle();
    document.documentElement.setAttribute('lang', current);
    const b = document.getElementById('lang-toggle');
    if (b) { b.addEventListener('click', () => setLocale(nextLocale())); }
    apply(document);
    updateToggle();
  }

  // Scripts are included at end of <body>, so the DOM already exists when this runs.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // Public API (used by app.js / panels.js for dynamically rendered labels).
  window.ForgeI18n = { t, apply, setLocale, getLocale: () => current, available: AVAILABLE, names: LOCALE_NAMES, STRINGS };
  // Compact global alias for hot render paths. Falls back to English literal when i18n is unavailable.
  window.i18nt = t;
})();
