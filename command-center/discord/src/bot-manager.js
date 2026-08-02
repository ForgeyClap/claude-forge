// Discord-Bot dashboard-tab: live status + start/stop, lokaal op 127.0.0.1.
// Start: node src/bot-manager.js  →  http://127.0.0.1:<MANAGER_PORT>
// Stop-strategie: eerst netjes via de bot-API; fallback alleen op de EXACTE
// eigen PID uit state/bot.pid (nooit killen op procesnaam).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig } from './config.js';
import { guardRequest } from './local-guard.js';
import { redactSecrets } from './audit.js';

const config = loadConfig();
const PID_FILE = path.join(config.stateDir, 'bot.pid');
const LOG_FILE = path.join(process.cwd(), 'logs', 'bot.log');
const BOT_URL = `http://127.0.0.1:${config.botHttpPort}`;

async function botHealth() {
  try {
    const res = await fetch(`${BOT_URL}/api/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function pidFromFile() {
  try {
    const pid = Number.parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startBot() {
  if (await botHealth()) return { ok: false, message: 'Bot draait al.' };
  const existing = pidFromFile();
  if (existing && processAlive(existing)) {
    return { ok: false, message: `Start is al bezig (pid ${existing}) — even geduld, opstarten duurt ~30s.` };
  }
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  const log = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, ['src/main.js'], {
    cwd: process.cwd(),
    env: { ...process.env, RUNNER: process.env.RUNNER ?? 'claude' },
    detached: true,
    stdio: ['ignore', log, log],
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));
  return { ok: true, message: `Bot start op (pid ${child.pid}) — verbinden duurt ~10-30s…` };
}

async function stopBot() {
  const pid = pidFromFile();
  let graceful = false;
  try {
    const res = await fetch(`${BOT_URL}/api/shutdown`, {
      method: 'POST',
      signal: AbortSignal.timeout(1500),
    });
    graceful = res.ok;
  } catch {
    // bot-API onbereikbaar
  }
  if (graceful) {
    // Pas rapporteren als hij ECHT weg is (max ~12s wachten).
    for (let i = 0; i < 12; i += 1) {
      await sleep(1000);
      if (!(await botHealth())) {
        return { ok: true, message: 'Bot netjes afgesloten (queue blijft bewaard).' };
      }
    }
  }
  if (pid && processAlive(pid)) {
    process.kill(pid);
    await sleep(500);
    return {
      ok: !processAlive(pid),
      message: processAlive(pid)
        ? `Proces ${pid} reageert niet op stop — probeer nogmaals.`
        : `Proces ${pid} gestopt (fallback via eigen PID).`,
    };
  }
  return { ok: false, message: 'Geen draaiende bot gevonden.' };
}

function logTail(lines = 60) {
  try {
    const raw = fs.readFileSync(LOG_FILE, 'utf8');
    // Extra vangnet: het log wordt in het dashboard gerenderd.
    return redactSecrets(raw.split('\n').slice(-lines).join('\n'));
  } catch {
    return '(nog geen log)';
  }
}

const PAGE = `<!doctype html><html lang="nl"><head><meta charset="utf-8">
<title>Forge · Discord Bot</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root{--bg:#0d1117;--card:#161b22;--line:#30363d;--txt:#e6edf3;--dim:#8b949e;
        --green:#3fb950;--red:#f85149;--amber:#d29922}
  *{box-sizing:border-box;margin:0}
  body{background:var(--bg);color:var(--txt);font:14px/1.6 'Segoe UI',system-ui,sans-serif;padding:24px;max-width:900px;margin:auto}
  h1{font-size:18px;display:flex;align-items:center;gap:10px;margin-bottom:16px}
  .dot{width:14px;height:14px;border-radius:50%;background:var(--dim);display:inline-block}
  .dot.on{background:var(--green);box-shadow:0 0 8px var(--green)}
  .dot.busy{background:var(--red);box-shadow:0 0 8px var(--red)}
  .dot.starting{background:var(--amber);box-shadow:0 0 8px var(--amber);animation:pulse 1s infinite alternate}
  @keyframes pulse{from{opacity:.5}to{opacity:1}}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin:14px 0}
  .card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px}
  .card b{display:block;font-size:12px;color:var(--dim);font-weight:600;margin-bottom:4px}
  button{background:var(--card);color:var(--txt);border:1px solid var(--line);border-radius:6px;
         padding:8px 18px;font-size:14px;cursor:pointer;margin-right:8px}
  button:hover{border-color:var(--dim)} button:active{transform:translateY(1px)}
  #start{border-color:var(--green)} #stop{border-color:var(--red)}
  pre{background:#010409;border:1px solid var(--line);border-radius:8px;padding:12px;
      font-size:12px;overflow:auto;max-height:280px;margin-top:14px;white-space:pre-wrap}
  #msg{color:var(--amber);min-height:20px;margin:8px 0;transition:opacity .6s ease}
  #msg.fade{opacity:0}
  .usage-row{display:flex;align-items:center;gap:10px;margin:6px 0;font-size:13px}
  .usage-row span:first-child{min-width:120px;color:var(--dim)}
  .track{flex:1;height:6px;background:#010409;border-radius:3px;overflow:hidden;min-width:80px}
  .fill{height:100%;border-radius:3px;background:var(--green);transition:width .4s ease}
  .fill.warn{background:var(--amber)} .fill.hot{background:var(--red)}
  table{width:100%;border-collapse:collapse;margin-top:6px}
  td,th{text-align:left;padding:4px 8px;border-bottom:1px solid var(--line);font-size:13px}
</style></head><body>
<h1><span class="dot" id="dot"></span> Forge · Discord Bot <span id="state" style="color:var(--dim)"></span></h1>
<div><button id="start" onclick="act('start')">▶ Start</button><button id="stop" onclick="act('stop')">■ Stop</button></div>
<div id="msg"></div>
<div class="grid" id="stats"></div>
<div class="card"><b>ABONNEMENT-VERBRUIK</b><div id="usage">laden…</div></div>
<div class="card"><b>PROJECTEN</b><table id="projects"></table></div>
<pre id="log"></pre>
<script>
let msgTimer, fadeTimer;
function showMsg(text, sticky){
  const el = document.getElementById('msg');
  clearTimeout(msgTimer); clearTimeout(fadeTimer);
  el.classList.remove('fade'); el.textContent = text;
  if (sticky) return;                       // blijft staan tot de status verandert
  msgTimer = setTimeout(()=>{ el.classList.add('fade');
    fadeTimer = setTimeout(()=>{ el.textContent=''; el.classList.remove('fade'); }, 700); }, 6000);
}
async function act(a){ const r = await fetch('/api/'+a,{method:'POST'}); const j = await r.json();
  // Startmelding blijft staan zolang hij opstart en verdwijnt zodra hij live is.
  showMsg(j.message, a === 'start' && j.ok); setTimeout(refresh, 800); }
function stat(k,v){ return '<div class="card"><b>'+k+'</b>'+v+'</div>'; }
async function refresh(){
  const s = await (await fetch('/api/state')).json();
  const dot = document.getElementById('dot');
  dot.className = 'dot' + (s.running ? (s.health.busy ? ' busy' : ' on') : (s.starting ? ' starting' : ''));
  const phase = s.health && s.health.phase && s.health.phase !== 'ready' ? ' ('+s.health.phase+')' : '';
  document.getElementById('state').textContent = s.running
    ? (s.health.busy ? '— 🔴 bezig' + phase : '— 🟢 live & vrij' + phase)
    : (s.starting ? '— ⏳ bezig met starten (pid '+s.pid+')…' : '— offline');
  const h = s.health || {};
  document.getElementById('stats').innerHTML = s.running ? [
    stat('UPTIME', Math.floor(h.uptimeSec/60)+'m '+(h.uptimeSec%60)+'s'),
    stat('ACTIEVE RUNS', h.activeRuns),
    stat('RUNNER', h.runner),
    stat('TRANSPORT', h.transport + (h.connected ? ' ✓' : ' ✗')),
    stat('WACHTRIJ', Object.entries(h.queueDepth||{}).map(([k,v])=>k+':'+v).join(' ')||'leeg'),
    stat('PID', h.pid),
  ].join('') : stat('STATUS','bot is niet actief');
  document.getElementById('projects').innerHTML = (h.projects||[]).map(p =>
    '<tr><td>'+p.projectId+'</td><td>'+(p.forgeMode?'⚒ forge':'claude')+'</td><td>'+(p.archived?'gearchiveerd':'actief')+'</td></tr>').join('');
  document.getElementById('log').textContent = s.log;
  // Zodra de bot echt draait is de "start op…"-melding niet meer waar → weg ermee.
  if (s.running && wasStarting){ wasStarting = false; showMsg('✅ Bot is live.'); }
  if (s.starting) wasStarting = true;
}
let wasStarting = false;
async function refreshUsage(){
  try{
    const u = await (await fetch('/api/usage')).json();
    const el = document.getElementById('usage');
    if (u.unavailable){ el.textContent = u.unavailable; return; }
    el.innerHTML = (u.limits||[]).map(l => {
      const cls = l.percent >= 90 ? 'hot' : l.percent >= 70 ? 'warn' : '';
      return '<div class="usage-row"><span>'+l.label+'</span>'
        + '<span class="track"><span class="fill '+cls+'" style="width:'+Math.min(100,l.percent)+'%"></span></span>'
        + '<span style="min-width:70px;text-align:right">'+l.percent+'% · '+(l.resetIn||'')+'</span></div>';
    }).join('') || 'geen gegevens';
  }catch{ /* dashboard mag hier nooit op stuklopen */ }
}
refresh(); refreshUsage();
setInterval(refresh, 3000); setInterval(refreshUsage, 60000);
</script></body></html>`;

let managerUsage = null;

const server = http.createServer(async (req, res) => {
  const send = (code, obj, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': type });
    res.end(type === 'application/json' ? JSON.stringify(obj) : obj);
  };
  const guard = guardRequest(req, config.managerPort);
  if (!guard.ok) return send(guard.code, { error: guard.error, message: guard.error });
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    return send(200, PAGE, 'text/html; charset=utf-8');
  }
  if (req.method === 'GET' && req.url === '/api/state') {
    const health = await botHealth();
    const pid = pidFromFile();
    const starting = !health && pid ? processAlive(pid) : false;
    return send(200, { running: Boolean(health), starting, pid, health, log: logTail() });
  }
  if (req.method === 'GET' && req.url === '/api/usage') {
    try {
      const { SubscriptionUsage, resetIn } = await import('./subscription-usage.js');
      const usage = await (managerUsage ?? (managerUsage = new SubscriptionUsage())).get();
      return send(200, {
        unavailable: usage.unavailable ?? null,
        limits: (usage.limits ?? []).map((l) => ({
          label: l.label,
          percent: l.percent,
          resetIn: l.resetsAt ? `reset ${resetIn(l.resetsAt)}` : '',
        })),
      });
    } catch (err) {
      return send(200, { unavailable: String(err?.message ?? err).slice(0, 80), limits: [] });
    }
  }
  if (req.method === 'POST' && req.url === '/api/start') return send(200, await startBot());
  if (req.method === 'POST' && req.url === '/api/stop') return send(200, await stopBot());
  return send(404, { error: 'not found' });
});
server.listen(config.managerPort, '127.0.0.1', () => {
  console.log(`[bot-manager] dashboard: http://127.0.0.1:${config.managerPort}`);
});
