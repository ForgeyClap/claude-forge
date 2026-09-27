import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { guardRequest } from './local-guard.js';
import { buildInviteUrl } from './invite.js';
import { redactSecrets } from './audit.js';

// Lokale status-API (alleen 127.0.0.1) + heartbeat naar state/BOT_STATUS.json.
// De waarheid komt LIVE uit gateway/queue/scheduler — nooit uit een cache — zodat
// "zegt dat het runt maar doet niets" hier direct zichtbaar zou zijn.
//
// WP-v290-B (beginner onboarding): `invitePermissions` is the decimal bitfield main.js computes
// ONCE at boot (invite.js's computeInvitePermissions() — the only place this whole package touches
// discord.js for that), so this module never needs its own discord.js import: botUsername/
// applicationId/guilds/inviteUrl below are plain reads of whatever the transport's real client
// already reported after login — `null`/`[]` (never fabricated) for the mock transport or before
// login completes.
export function startHealthServer({
  gateway,
  config,
  runnerKind,
  onShutdown,
  getPhase = () => 'ready',
  getLoginError = () => null,
  invitePermissions = null,
}) {
  const startedAt = Date.now();
  const statusFile = path.join(config.stateDir, 'BOT_STATUS.json');

  const snapshot = () => {
    const client = gateway.transport?.client ?? null;
    const applicationId = client?.application?.id ?? null;
    const guildsCache = client?.guilds?.cache;
    const guilds = guildsCache ? [...guildsCache.values()].map((g) => ({ id: g.id, name: g.name })) : [];
    const rawLoginError = getLoginError();
    return {
      live: true,
      phase: getPhase(),
      pid: process.pid,
      startedAt,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      transport: config.transport,
      connected: gateway.transport.connected ?? null,
      busy: gateway.scheduler.activeCount() > 0,
      activeRuns: gateway.scheduler.activeCount(),
      queueDepth: gateway.queue.depth(),
      runner: runnerKind,
      guildId: config.guildId,
      // Codex finding K3-3 (defense in depth): classifyLoginError() already redacts an unrecognised
      // error's raw text at the source, but this is the ONE place that value is written to
      // BOT_STATUS.json on disk and served over /api/health, so it is redacted again here too —
      // never trust a value to already be clean just because its one known producer says so today.
      loginError: typeof rawLoginError === 'string' ? redactSecrets(rawLoginError) : rawLoginError,
      botUsername: client?.user?.username ?? null,
      applicationId,
      guilds,
      inviteUrl: applicationId && invitePermissions ? buildInviteUrl(applicationId, invitePermissions) : null,
      projects: gateway.router.projects.map((p) => ({
        projectId: p.projectId,
        channelId: p.forumChannelId,
        forgeMode: p.forgeMode ?? false,
        archived: p.archived,
      })),
    };
  };

  const writeStatus = (extra = {}) => {
    try {
      fs.mkdirSync(config.stateDir, { recursive: true });
      fs.writeFileSync(statusFile, JSON.stringify({ ...snapshot(), ts: Date.now(), ...extra }, null, 2));
    } catch {
      // heartbeat mag de bot nooit laten crashen
    }
  };
  const heartbeat = setInterval(writeStatus, 10_000);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();
  writeStatus();

  const server = http.createServer((req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const guard = guardRequest(req, config.botHttpPort);
    if (!guard.ok) return send(guard.code, { error: guard.error });
    if (req.method === 'GET' && req.url === '/api/health') return send(200, snapshot());
    if (req.method === 'POST' && req.url === '/api/shutdown') {
      send(200, { ok: true, message: 'bot sluit af…' });
      setTimeout(() => onShutdown?.(), 100);
      return;
    }
    return send(404, { error: 'not found' });
  });

  // De poort fungeert als single-instance-lock: bezet = tweede instantie → stoppen.
  const listening = new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(
          new Error(
            `poort ${config.botHttpPort} is bezet — er draait al een bot-instantie. Deze instantie stopt.`,
          ),
        );
      } else {
        reject(err);
      }
    });
    server.listen(config.botHttpPort, '127.0.0.1', resolve);
  });

  return {
    server,
    listening,
    stop: () => {
      clearInterval(heartbeat);
      writeStatus({ live: false, stoppedAt: Date.now() });
      server.close();
    },
  };
}
