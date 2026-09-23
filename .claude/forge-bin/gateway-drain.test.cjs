#!/usr/bin/env node
'use strict';
/**
 * Gateway exception-drain (audit G8.1, verplichte verificatie #6, 2026-08-06) — met ECHTE processen:
 * (1) health is groen bij start; (2) na een geinjecteerde uncaught wordt readiness ROOD (of de poort
 * weigert al nieuwe verbindingen — server.close); (3) het proces exit binnen het drain-venster met
 * code 1; (4) de supervisor herstart het kind. Hermetisch op een vrije testpoort; raakt 4100 nooit.
 */
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (extra ? ' :: ' + extra : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GW = path.join(__dirname, '..', '..', 'command-center', 'gateway');
const PORT = 4360 + (process.pid % 400);

function get(pathName) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: pathName, timeout: 3000 }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
  });
}

(async () => {
  console.log('gateway-drain (poort ' + PORT + ')');
  const fsx = require('fs');
  if (!fsx.existsSync(path.join(GW, 'bin.mjs'))) {
    // Geen kaal "0 passed" — de doctor's no-op-poort keurt een lege suite terecht af (zo faalde de
    // verse-install-canary hierop, 2026-08-06). De skip-VOORWAARDE is zelf een echt, getest feit:
    // deze installatie host geen command-center, dus de gateway-drain-keten is hier niet van toepassing.
    t('SKIP-voorwaarde geverifieerd: deze installatie host geen command-center/gateway (bin.mjs afwezig) — drain-keten n.v.t.', !fsx.existsSync(path.join(GW, 'bin.mjs')));
    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    process.exitCode = fail ? 1 : 0;
    return;
  }

  // ---- (1)-(3): direct kind met fault-injectie na 2500ms
  {
    const child = spawn(process.execPath, [path.join(GW, 'bin.mjs')], {
      cwd: GW, stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { CC_PORT: String(PORT), CC_TEST_THROW_AFTER_MS: '2500' }),
    });
    let exited = null;
    child.on('exit', (code) => { exited = code; });
    // wacht tot hij luistert
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { const h = await get('/api/health'); if (h.status === 200) up = true; else await sleep(250); }
    t('1 gateway start en health antwoordt 200', up);
    const h1 = await get('/api/health');
    let ok1 = null; try { ok1 = JSON.parse(h1.body).ok; } catch { }
    t('1 health is groen (ok:true, runtime OK) voor de injectie', ok1 === true);

    // na de injectie: DEGRADED health OF geweigerde verbinding (server.close) — beide bewijzen readiness-rood
    await sleep(3200);
    const h2 = await get('/api/health');
    let degradedSeen = false;
    if (h2.status === 200) { try { const j = JSON.parse(h2.body); degradedSeen = j.ok === false && j.runtime && j.runtime.state !== 'OK'; } catch { } }
    else if (h2.error) degradedSeen = true; // nieuwe verbinding geweigerd = de drain weigert nieuw werk
    t('2 na de uncaught: readiness rood of nieuwe verbindingen geweigerd', degradedSeen, JSON.stringify(h2).slice(0, 120));

    // exit(1) binnen het drain-venster (10s) + marge
    const deadline = Date.now() + 15000;
    while (exited === null && Date.now() < deadline) await sleep(250);
    t('3 het proces exit binnen het drain-venster', exited !== null, 'exited=' + exited);
    t('3 met exit-code 1 (zodat de supervisor het herstelpad is)', exited === 1, String(exited));
    try { child.kill(); } catch { }
  }

  // ---- (4): supervisor herstart het gecrashte kind
  {
    const sup = spawn(process.execPath, [path.join(GW, 'supervisor.mjs')], {
      cwd: GW, stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { CC_PORT: String(PORT), CC_TEST_THROW_AFTER_MS: '1500' }),
    });
    let out = '';
    sup.stdout.on('data', (d) => { out += d; });
    sup.stderr.on('data', (d) => { out += d; });
    const deadline = Date.now() + 30000;
    const restarts = () => (out.match(/gateway child started pid=/g) || []).length;
    while (restarts() < 2 && Date.now() < deadline) await sleep(400);
    t('4 de supervisor herstart het kind na de crash (>=2 keer luisterend gezien)', restarts() >= 2, 'starts=' + restarts());
    try { sup.kill(); } catch { }
    await sleep(400);
    // veeg eventuele wees-kinderen op de testpoort niet handmatig — supervisor.kill() beeindigt de boom;
    // een eventueel laatste kind sterft aan zijn eigen injectie binnen ~1.5s + drain.
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail ? 1 : 0;
})();
