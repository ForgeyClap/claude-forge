/**
 * BotActivitySection — "Bot activity" (v2.9.0, Command Center audit finding 31): what the Discord
 * bot has actually done on this machine, its jobs and the cost Claude Code recorded for them. Before
 * this panel, 31 bot jobs and $121.45 of recorded cost appeared in no Command Center view at all.
 *
 * Reads `GET /api/discord/activity` through `useGatewayDiscordActivity()` — read-only, polled, never
 * message text or Discord ids (the gateway does not send them). Every number shown is a real figure
 * from the bot's own queue and usage log; a missing log is shown as "no activity yet", never as a
 * fabricated zero, and anything the gateway could not read is listed as a plain note.
 */

import type { ReactNode } from 'react';

import { EmptyState, Eyebrow, Icon, Machine, Panel, StatusDot } from '@/components/primitives';
import { formatDurationMs, formatRelativeTime } from '@/prototype/state/adapter/rows';
import { useGatewayDiscordActivity } from '@/prototype/state/gateway-discord-activity';
import type { DiscordActivity, DiscordJob } from '@/prototype/state/gateway-discord-activity';
import { formatCompact, formatCount, formatUsd, jobStateLabel, jobsLabel, statusKeyForJobState } from './bot-activity-format';
import './bot-activity.css';

const COST_HINT =
  "Claude Code's own cost figure for each job. On a Claude subscription it estimates usage your plan covers; with an API key it is what was billed.";

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

function projectLabel(name: string | null, id: string | null): string {
  return name ?? id ?? 'Unknown project';
}

function tokensHint(cost: DiscordActivity['cost']): string {
  const parts = ['Across recorded jobs.'];
  if (cost.cacheReadTokens > 0) parts.push(`${formatCompact(cost.cacheReadTokens)} of the input was read from the prompt cache.`);
  if (cost.runsWithoutCost > 0) parts.push(`${jobsLabel(cost.runsWithoutCost)} recorded no cost.`);
  return parts.join(' ');
}

function openHint(open: number): string {
  if (open === 0) return 'None still open.';
  return open === 1 ? '1 still open.' : `${formatCount(open)} still open.`;
}

/* -------------------------------------------------------------- sections */

function StateList({ byState }: { byState: DiscordActivity['jobs']['byState'] }) {
  const entries = Object.entries(byState).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;
  return (
    <ul className="fw-botact__states" aria-label="Jobs by state">
      {entries.map(([state, count]) => (
        <li key={state} className="fw-botact__state">
          <span aria-hidden="true">
            <StatusDot status={statusKeyForJobState(state)} />
          </span>
          <span className="fw-botact__state-label">{jobStateLabel(state)}</span>
          <Machine className="fw-botact__state-count">{formatCount(count)}</Machine>
        </li>
      ))}
    </ul>
  );
}

function ProjectCosts({ cost }: { cost: DiscordActivity['cost'] }) {
  if (cost.byProject.length === 0) return null;
  return (
    <section className="fw-botact__section" aria-label="Recorded cost per project">
      <Eyebrow>Per project</Eyebrow>
      <ul className="fw-botact__list">
        {cost.byProject.map((p) => (
          <li key={p.projectId ?? '(none)'} className="fw-botact__item">
            <span className="fw-botact__item-name fw-truncate">{projectLabel(p.projectName, p.projectId)}</span>
            <span className="fw-botact__item-meta">{jobsLabel(p.runs)}</span>
            <Machine className="fw-botact__item-value">{formatUsd(p.costUsd)}</Machine>
          </li>
        ))}
      </ul>
    </section>
  );
}

function jobWhen(job: DiscordJob): string {
  return formatRelativeTime(job.completedAt ?? job.startedAt ?? job.receivedAt);
}

function RecentJobs({ jobs }: { jobs: readonly DiscordJob[] }) {
  if (jobs.length === 0) return null;
  return (
    <section className="fw-botact__section" aria-label="Recent jobs">
      <Eyebrow>Recent jobs</Eyebrow>
      <ul className="fw-botact__list">
        {jobs.map((job, index) => {
          const meta = [jobStateLabel(job.state), jobWhen(job), formatDurationMs(job.durationMs)].filter((part) => part !== '');
          return (
            <li key={job.id ?? `job-${index}`} className="fw-botact__job">
              <span aria-hidden="true" className="fw-botact__job-dot">
                <StatusDot status={statusKeyForJobState(job.state)} />
              </span>
              <span className="fw-botact__job-main">
                <span className="fw-botact__item-name fw-truncate">{projectLabel(job.projectName, job.projectId)}</span>
                <span className="fw-botact__item-meta">{meta.join(' · ')}</span>
                {job.error !== null ? <span className="fw-botact__job-error">{job.error}</span> : null}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* -------------------------------------------------------------------- view */

export default function BotActivitySection() {
  const { data, error, loading } = useGatewayDiscordActivity();

  return (
    <Panel
      title="Bot activity"
      subtitle="What the Discord bot has done on this machine: its jobs, and the cost Claude Code recorded for them."
    >
      {error !== null ? (
        <p className="fw-discord__transport-error" role="alert">
          <Icon name="Unplug" size="sm" />
          <span>Could not reach the gateway: {error}</span>
        </p>
      ) : null}

      {loading ? (
        <EmptyState compact icon="Loader" title="Reading bot activity…" />
      ) : !data.available ? (
        <EmptyState
          compact
          icon="Inbox"
          title="No bot activity yet"
          detail="The bot has not handled a job on this machine yet. Its jobs and their recorded cost will appear here after the first one."
        />
      ) : (
        <div className="fw-botact">
          <div className="fw-discord__rows">
            <Row label="Jobs" hint={openHint(data.jobs.open)}>
              <Machine>{formatCount(data.jobs.total)}</Machine>
            </Row>
            <Row label="Recorded cost" hint={COST_HINT}>
              <Machine>{formatUsd(data.cost.totalUsd)}</Machine>
            </Row>
            <Row label="Last 7 days">
              <Machine muted>{formatUsd(data.cost.last7dUsd)}</Machine>
            </Row>
            <Row label="Last 24 hours">
              <Machine muted>{formatUsd(data.cost.last24hUsd)}</Machine>
            </Row>
            <Row label="Tokens" hint={tokensHint(data.cost)}>
              <Machine muted>
                {formatCompact(data.cost.inputTokens + data.cost.cacheReadTokens)} in / {formatCompact(data.cost.outputTokens)} out
              </Machine>
            </Row>
          </div>

          <StateList byState={data.jobs.byState} />
          <ProjectCosts cost={data.cost} />
          <RecentJobs jobs={data.jobs.recent} />

          {data.notes.length > 0 ? (
            <ul className="fw-botact__notes" aria-label="Notes">
              {data.notes.map((note) => (
                <li key={note} className="fw-botact__note">
                  <Icon name="Info" size="xs" />
                  <span>{note}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </Panel>
  );
}
