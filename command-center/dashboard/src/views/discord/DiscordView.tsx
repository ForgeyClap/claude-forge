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

function formatHealthValue(value: unknown): string {
  if (value === null) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/* ------------------------------------------------------------------ panels */

function ServicePanel({
  service,
  pending,
  actionError,
  onToggle,
}: {
  service: DiscordService;
  pending: 'start' | 'stop' | null;
  actionError: string | null;
  onToggle: (next: boolean) => void;
}) {
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
    <Panel title="Bot health" subtitle="Whatever the bot's own health endpoint reports, shown as-is.">
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
              <Machine muted className="fw-discord__health-key">
                {key}
              </Machine>
              <span className="fw-discord__health-value">{formatHealthValue(value)}</span>
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

  async function handleToggle(next: boolean): Promise<void> {
    if (pending !== null) return;
    setActionError(null);
    setPending(next ? 'start' : 'stop');
    const result = next ? await requestDiscordStart() : await requestDiscordStop();
    setPending(null);
    if (!result.ok) {
      setActionError(result.error ?? 'The gateway could not complete this request.');
    }
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
              <ServicePanel
                service={service}
                pending={pending}
                actionError={actionError}
                onToggle={(next) => void handleToggle(next)}
              />
              <EnvKeysPanel envKeys={service.envKeys} />
              <HealthPanel health={service.health} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
