import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// C1 fix (WP-C1, 2026-09-26 laptop re-audit — coordinator flag): the old default hard-coded the
// maintainer's own username (`C:\Users\YOU\Documents\ForgeProjects`), which does not exist on any
// other machine. Derived from the current user's real home directory instead.
//
// CORRECTION (WP-C2, 2026-09-26 laptop re-audit, finding #5): the previous version of this comment
// claimed this default is "one shared convention" with the gateway's own project-creation route —
// that overstated it. The gateway's `FORGE_PROJECTS_ROOT` (gateway/src/paths.mjs) is
// `path.join(SYNC_SCAN_ROOT, 'ForgeProjects')`, and `SYNC_SCAN_ROOT` is the PARENT of wherever the
// command-center repo itself happens to be cloned — NOT `<home>/Documents`. The two only resolve to
// the exact same folder when that repo is cloned directly under `<home>/Documents` (true for the
// maintainer's own machine, not guaranteed anywhere else). What genuinely IS shared: the folder
// NAME `ForgeProjects`, and the fact that `<home>/Documents` is unconditionally one of the roots
// the gateway's own multi-root discovery (paths.mjs's `SYNC_SCAN_ROOTS`) scans regardless of where
// the repo is cloned — so a project THIS bot creates under its default is always discoverable by
// the gateway, but a project the gateway's own "New project" button creates is only guaranteed
// discoverable by this bot's default when the repo sits directly under Documents. When the two
// diverge, `FORGE_PROJECTS_DIR` (env or `.env`) still overrides this bot's side for anyone who
// keeps projects elsewhere.
const DEFAULT_PROJECTS_DIR = path.join(os.homedir(), 'Documents', 'ForgeProjects');

// Codex run B F-03 (2026-09-28): the gateway's env writer (gateway/src/discord-service.mjs's
// mergeEnvText/encodeEnvValue) wraps a value that would otherwise corrupt this line-based format
// (a real newline, a CR, a NUL, a literal `"`, or leading/trailing whitespace) in JSON-string
// quoting BEFORE writing it — e.g. `FORGE_PROJECTS_DIR="C:\\evil\nRUNNER=claude"` stays ONE line on
// disk, with the embedded newline as the two literal characters `\` `n`, never a real line break.
// decodeEnvValue() reverses that exactly. A value that does not start-and-end with `"` (every
// value ever written before this fix, and every ordinary bot-token/guild-id/plain-path value
// written after it) is returned exactly as before: unmodified, bare text. A value that merely
// LOOKS quoted but is not valid JSON (e.g. a human hand-typed `"C:\Users\me\My Projects"`, which
// uses single backslashes, not JSON's `\\`) falls back to the literal raw text, quotes included —
// identical to this parser's behaviour before this fix, never a new failure mode for an existing
// hand-edited `.env`.
function decodeEnvValue(raw) {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'string') return parsed;
    } catch {
      // Not valid JSON after all -- fall through and treat it as a literal bare value.
    }
  }
  return raw;
}

function parseEnvFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  const out = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    out[key] = decodeEnvValue(value);
  }
  return out;
}

export function loadConfig({ env = process.env, cwd = process.cwd(), envFile = '.env' } = {}) {
  const fileVars = parseEnvFile(path.join(cwd, envFile));
  const get = (key, fallback = '') => env[key] ?? fileVars[key] ?? fallback;

  const config = {
    transport: get('TRANSPORT', 'mock'),
    botToken: get('DISCORD_BOT_TOKEN'),
    guildId: get('DISCORD_GUILD_ID'),
    ownerUserIds: get('OWNER_USER_IDS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    expiryMs: (Number.parseFloat(get('EXPIRY_HOURS', '2')) || 2) * 3600 * 1000,
    maxQueuedPerThread: Number.parseInt(get('MAX_QUEUED_PER_THREAD', '10'), 10) || 10,
    globalMaxActiveRuns: Number.parseInt(get('GLOBAL_MAX_ACTIVE_RUNS', '2'), 10) || 2,
    stateDir: path.resolve(cwd, get('STATE_DIR', './state')),
    projectsDir: get('FORGE_PROJECTS_DIR', DEFAULT_PROJECTS_DIR),
    botHttpPort: Number.parseInt(get('BOT_HTTP_PORT', '3979'), 10) || 3979,
    managerPort: Number.parseInt(get('MANAGER_PORT', '3987'), 10) || 3987,
    runner: get('RUNNER', 'fake'),
    chatResetMinutes: Number.parseInt(get('CHAT_RESET_MINUTES', '30'), 10) || 0,
    ownerWebhookUrl: get('OWNER_WEBHOOK_URL', ''),
    pauseAtPercent: Number.parseInt(get('PAUSE_AT_PERCENT', '90'), 10) || 90,
    resumeAtPercent: Number.parseInt(get('RESUME_AT_PERCENT', '80'), 10) || 80,
    dailyCostLimitUsd: Number.parseFloat(get('DAILY_COST_LIMIT_USD', '0')) || 0,
    // Ongeldige waarde → standaard 8 (niet stil uitschakelen); -1 = expliciet uit.
    briefingHour: (() => {
      const raw = get('BRIEFING_HOUR', '8');
      const n = Number.parseInt(raw, 10);
      if (Number.isNaN(n)) return 8;
      return n >= -1 && n <= 23 ? n : 8;
    })(),
  };

  if (config.transport === 'discord') {
    // WP-v290-B (beginner onboarding, auto-detect): DISCORD_GUILD_ID and OWNER_USER_IDS are no
    // longer required up front — main.js auto-detects both after the bot logs in (exactly one
    // server -> pick it; that server's real owner -> the Forge owner) and persists them itself.
    // Only the token is genuinely required to even attempt a connection.
    if (!config.botToken) {
      throw new Error('TRANSPORT=discord vereist: DISCORD_BOT_TOKEN (zie .env.example)');
    }
  }

  return config;
}

// Veilige weergave voor logs/health. ALLOWLIST: alleen deze velden mogen gelogd
// worden. Zo kan een nieuw configveld met een geheim (webhook, api-key) nooit per
// ongeluk in logs/bot.log en daarmee in het dashboard belanden.
const LOGGABLE = [
  'transport',
  'guildId',
  'expiryMs',
  'maxQueuedPerThread',
  'globalMaxActiveRuns',
  'stateDir',
  'projectsDir',
  'botHttpPort',
  'managerPort',
  'runner',
  'chatResetMinutes',
];
const SECRET_FIELDS = ['botToken', 'ownerWebhookUrl'];

export function describeConfig(config) {
  const safe = {};
  for (const key of LOGGABLE) if (key in config) safe[key] = config[key];
  for (const key of SECRET_FIELDS) {
    if (key in config) safe[key] = config[key] ? '***set***' : '(leeg)';
  }
  // Owner-ID's zijn geen geheim maar wel persoonsgegevens: alleen het aantal.
  if (Array.isArray(config.ownerUserIds)) safe.ownerUserIds = `${config.ownerUserIds.length} owner(s)`;
  return safe;
}
