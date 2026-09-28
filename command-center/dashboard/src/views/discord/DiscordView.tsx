/**
 * Discord — the dedicated tab for the Discord↔Forge remote-control bot (WP-D2,
 * forge-2026-07-30-discord).
 *
 * Everything here reads `GET /api/discord/status` through `useGatewayDiscordStatus`
 * (`gateway-discord.ts`) and writes through `requestDiscordStart`/`requestDiscordStop` — the
 * fixed contract this WP was built against, not the gateway's implementation (a parallel Build
 * Boss owns that side; this view never reads `gateway/` source).
 *
 * Three honest states, never collapsed into one generic empty box:
 *   1. `!service.installed` — a distinct empty state ("not installed"), never confused with
 *      "installed but stopped".
 *   2. installed, real service panels — status, environment keys (names/presence only, never a
 *      value), and the bot's own health passthrough rendered defensively (only the fields that
 *      actually exist).
 *   3. a transport error from the status poll itself — shown alongside whatever data is still
 *      known, never wiping it.
 *
 * The on/off switch is never optimistic: it always reflects `service.running` from the last
 * real poll. Clicking it fires the real start/stop request, shows a pending line while the
 * request is in flight, and shows the gateway's own error text verbatim (409 conflict included)
 * on failure — the switch only ever visibly flips once the next status poll confirms it.
 */

import { useState } from 'react';
import type { ReactNode } from 'react';

import { EmptyState, Eyebrow, Icon, Machine, Panel, Switch } from '@/components/primitives';
import {
  requestDiscordStart,
  requestDiscordStop,
  useGatewayDiscordStatus,
} from '@/prototype/state/gateway-discord';
import type { DiscordService } from '@/prototype/state/gateway-discord';
import BotActivitySection from './BotActivitySection';
import ConnectWizard from './ConnectWizard';
import ProjectsDirSection from './ProjectsDirSection';
import { formatHealthValue, healthKeyLabel } from './health-format';
import { computeWizardStep } from './wizard-step';
import './discord.css';

/* ------------------------------------------------------------------ atoms */

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="fw-discord__row">
      <div className="fw-discord__row-text">
        <span className="fw-discord__row-label">{label}</span>
        {hint ? <span className="fw-discord__row-hint">{hint}</span> : null}
      </div>
      <div className="fw-discord__row-control">{children}</div>
    </div>
  );
}

function transportHint(transport: string | null): string {
  if (transport === 'mock') return 'Test transport — no real Discord connection is made.';
  if (transport === 'discord') return 'Live transport — genuinely connected to Discord.';
  return 'Not reported by the gateway.';
}

/** v2.9.0 WP-DA: "will the bot come back by itself when the Command Center starts?", in plain words.
 *  Codex DA-1: "YES" only when the gateway says it will really try (`effective`: setting on, not switched
 *  off, installed AND connected) and the last automatic start did not fail; every other case names the
 *  reason. Codex DA-2: a failed save of the owner's choice comes first, because it makes the rest unsure. */
function autostartText(autostart: DiscordService['autostart']): { value: string; hint: string } {
  if (autostart === null) return { value: '—', hint: 'Not reported by the gateway.' };
  const last =
    autostart.lastOutcome !== null && autostart.lastDetail !== null
      ? ` Last Command Center start: ${autostart.lastDetail}.`
      : '';
  if (autostart.saveError !== null) {
    return {
      value: 'UNSURE',
      hint: `Forge ${autostart.saveError}, so after a restart the bot follows your previous choice. Use the switch once more to save it.${last}`,
    };
  }
  if (autostart.setting === false) {
    return {
      value: 'NO',
      hint: `Turned off in Settings ("discord-autostart"). Turn it on there to have the bot start by itself.${last}`,
    };
  }
  if (autostart.desired === 'stopped') {
    return {
      value: 'NO',
      hint: `You switched the bot off, so it stays off after a restart. Switch it on and it comes back by itself.${last}`,
    };
  }
  if (autostart.setting === null) {
    return {
      value: 'NO',
      hint: `Forge's settings could not be read right now, so the bot does not start by itself (the safe choice). This clears up as soon as the settings can be read again.${last}`,
    };
  }
  if (autostart.envOptOut) {
    return {
      value: 'NO',
      hint: `Automatic start is turned off for this Command Center process (CC_DISCORD_AUTOSTART=off), usually a test or temporary copy.${last}`,
    };
  }
  if (autostart.desiredInvalid) {
    return {
      value: 'NO',
      hint: `Your last on/off choice could not be read${autostart.desiredNote !== null ? ` (${autostart.desiredNote})` : ''}, so the bot does not start by itself. Switch it on here to start it and save your choice again.${last}`,
    };
  }
  if (!autostart.ready) {
    return {
      value: 'NOT YET',
      hint: `It will start by itself once it can: ${autostart.readyReason ?? 'Discord is not set up yet'}. Finish connecting Discord first.`,
    };
  }
  if (autostart.conflict !== null) {
    return {
      value: 'BLOCKED',
      hint: `Another program already answers on the bot's port, so the Command Center will not start a second bot: ${autostart.conflict}. Once that program is gone, the bot starts by itself at the next Command Center start.`,
    };
  }
  if (!autostart.effective) {
    return { value: 'NO', hint: `The gateway says the bot will not start by itself.${last}` };
  }
  if (autostart.lastOutcome === 'failed') {
    return {
      value: 'FAILED',
      hint: `The bot is set to start by itself, but the last automatic start failed: ${autostart.lastDetail ?? 'no reason given'}. It tries again at the next Command Center start.`,
    };
  }
  return {
    value: 'YES',
    hint: `The bot starts by itself whenever the Command Center starts, also after a reboot. Switch it off here and it stays off.${last}`,
  };
}

/* ------------------------------------------------------------------ panels */

function ServicePanel({
  service,
  pending,
  actionError,
  actionWarning,
  onToggle,
}: {
  service: DiscordService;
  pending: 'start' | 'stop' | null;
  actionError: string | null;
  /** WP-DA (Codex DA-2): the switch worked, but the gateway could not save the choice — shown verbatim. */
  actionWarning: string | null;
  onToggle: (next: boolean) => void;
}) {
  const autostart = autostartText(service.autostart);
  return (
    <Panel
      title="Service"
      subtitle="A real on/off switch — the switch itself only flips once the next status poll confirms it."
      actions={
        <Switch
          checked={service.running}
          onChange={onToggle}
          disabled={pending !== null}
          label={service.running ? 'Discord service running' : 'Discord service stopped'}
        />
      }
    >
      {pending !== null ? (
        <p className="fw-discord__pending" role="status">
          <Icon name="Loader" size="xs" spin />
          <span>{pending === 'start' ? 'Starting…' : 'Stopping…'}</span>
        </p>
      ) : null}

      {actionError !== null ? (
        <p className="fw-discord__alert" role="alert">
          <Icon name="TriangleAlert" size="sm" />
          <span>{actionError}</span>
        </p>
      ) : null}

      {actionWarning !== null ? (
        <p className="fw-discord__alert" role="alert">
          <Icon name="TriangleAlert" size="sm" />
          <span>{actionWarning}</span>
        </p>
      ) : null}

      {service.conflict !== null ? (
        <p className="fw-discord__alert" role="alert">
          <Icon name="TriangleAlert" size="sm" />
          <span>{service.conflict}</span>
        </p>
      ) : null}

      <div className="fw-discord__rows">
        <Row label="Status" hint="From the gateway's own live status check.">
          <Machine>{service.running ? 'RUNNING' : 'STOPPED'}</Machine>
        </Row>
        <Row label="Starts automatically" hint={autostart.hint}>
          <Machine muted>{autostart.value}</Machine>
        </Row>
        <Row label="PID">
          <Machine muted>{service.pid ?? '—'}</Machine>
        </Row>
        <Row label="Started at">
          <Machine muted>{service.startedAt ?? '—'}</Machine>
        </Row>
        <Row label="Transport" hint={transportHint(service.transport)}>
          <Machine muted>{service.transport ?? '—'}</Machine>
        </Row>
        <Row label="Bot port">
          <Machine muted>{service.ports.bot ?? '—'}</Machine>
        </Row>
        <Row label="State directory">
          <Machine muted className="fw-discord__row-path">
            {service.stateDir || '—'}
          </Machine>
        </Row>
        <Row label="Log file">
          <Machine muted className="fw-discord__row-path">
            {service.logFile || '—'}
          </Machine>
        </Row>
      </div>
    </Panel>
  );
}

function EnvKeysPanel({ envKeys }: { envKeys: DiscordService['envKeys'] }) {
  return (
    <Panel title="Environment keys" subtitle="Names and presence only — a value is never shown here.">
      {envKeys.length === 0 ? (
        <EmptyState compact icon="Cable" title="No environment keys reported" />
      ) : (
        <ul className="fw-discord__env-list">
          {envKeys.map((key) => (
            <li key={key.name} className="fw-discord__env-item">
              <Machine className="fw-discord__env-name fw-truncate">{key.name}</Machine>
              <span
                className={
                  key.present ? 'fw-discord__env-chip is-present' : 'fw-discord__env-chip is-missing'
                }
              >
                <Icon name={key.present ? 'Check' : 'X'} size="xs" />
                <span>{key.present ? 'Present' : 'Missing'}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function HealthPanel({ health }: { health: DiscordService['health'] }) {
  return (
    <Panel title="Bot health" subtitle="What the bot's own health check reports, in plain words. Hover a label to see the raw field name.">
      {health === null ? (
        <p className="fw-discord__health-empty">
          Bot not reachable — it may be stopped or still starting.
        </p>
      ) : Object.keys(health).length === 0 ? (
        <p className="fw-discord__health-empty">The bot answered with an empty health report.</p>
      ) : (
        <ul className="fw-discord__health-list">
          {Object.entries(health).map(([key, value]) => (
            <li key={key} className="fw-discord__health-item">
              <span className="fw-discord__health-key" title={key}>
                {healthKeyLabel(key)}
              </span>
              <span className="fw-discord__health-value">{formatHealthValue(key, value)}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/* -------------------------------------------------------------------- view */

export default function DiscordView() {
  const status = useGatewayDiscordStatus();
  const [pending, setPending] = useState<'start' | 'stop' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionWarning, setActionWarning] = useState<string | null>(null);

  async function handleToggle(next: boolean): Promise<void> {
    if (pending !== null) return;
    setActionError(null);
    setActionWarning(null);
    setPending(next ? 'start' : 'stop');
    const result = next ? await requestDiscordStart() : await requestDiscordStop();
    setPending(null);
    if (!result.ok) {
      setActionError(result.error ?? 'The gateway could not complete this request.');
      return;
    }
    // WP-DA (Codex DA-2): the switch worked, but the choice was not saved — never a silent success.
    if (result.warning !== null) setActionWarning(result.warning);
  }

  const service = status.data;

  return (
    <div className="fw-discord">
      <header className="fw-discord__head">
        <div className="fw-discord__heading">
          <Eyebrow>Remote control</Eyebrow>
          <h1 className="fw-discord__title">Discord</h1>
          <p className="fw-discord__subtitle">
            Start, stop and inspect the Discord↔Forge remote-control bot for this project.
          </p>
        </div>
      </header>

      <div className="fw-discord__body fw-scroll">
        <div className="fw-discord__panels">
          {status.error !== null ? (
            <p className="fw-discord__transport-error" role="alert">
              <Icon name="Unplug" size="sm" />
              <span>Could not reach the gateway: {status.error}</span>
            </p>
          ) : null}

          {status.loading ? (
            <EmptyState icon="Loader" title="Reading Discord service status…" compact />
          ) : !service.installed ? (
            <EmptyState
              icon="PackageOpen"
              title="Discord service is not installed in this project"
              detail="No Discord bot service was found for this project. Nothing here is running, and nothing can be started yet."
            />
          ) : (
            <>
              {/* WP-v290-B: purely ADDITIVE — shown only while setup genuinely is not done yet
                  (no token, awaiting invite/guild pick, or a failed login). An already-connected
                  owner never sees this; the classic panels below are completely unchanged. */}
              {computeWizardStep(service) !== 'done' ? (
                <ConnectWizard service={service} onChanged={() => {}} />
              ) : null}
              <ServicePanel
                service={service}
                pending={pending}
                actionError={actionError}
                actionWarning={actionWarning}
                onToggle={(next) => void handleToggle(next)}
              />
              {/* v2.9.0 (audit finding 31): the bot's own jobs and recorded cost, which no view showed before. */}
              <BotActivitySection />
              {/* WP-S1: shown regardless of wizard step — before connecting, the folder choice is
                  simply stored and picked up the next time the bot starts. */}
              <ProjectsDirSection />
              <EnvKeysPanel envKeys={service.envKeys} />
              <HealthPanel health={service.health} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
