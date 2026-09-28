/**
 * ConnectWizard — the "Connect Discord" onboarding flow (WP-v290-B, beginner Discord onboarding).
 *
 * Renders ABOVE the classic Service/EnvKeys/Health panels in `DiscordView.tsx`, never instead of
 * them: an owner whose bot is already fully connected (`computeWizardStep(service) === 'done'`)
 * never sees this component mounted at all — see `DiscordView.tsx`'s own render for that gate.
 *
 * Five steps, ALL shown at once (a beginner can see the whole journey rather than one screen at a
 * time), each marked done/current/upcoming from real, live `DiscordService` state — never a
 * client-side "I clicked next" flag that could drift from reality:
 *   1. Make your own Discord server            — instructions + a link; nothing to poll for.
 *   2. Make the bot in the Developer Portal     — instructions + a link; nothing to poll for.
 *   3. Paste the token                          — the one real input in this whole flow.
 *   4. Get the bot into your server              — an invite-link button, OR (when the bot is
 *      already in several servers) a real picker built from `service.guilds`.
 *   5. Done                                      — the real detected server + whether an owner was
 *      auto-detected + a note about channel setup and the welcome message.
 *
 * Honest limits are shown once, always, regardless of step: why Forge cannot create the server
 * (a bot that creates a guild OWNS it), and why the bot itself must be made on Discord's own site
 * (there is no API for that step).
 */
import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';

import { Button, Field, Icon, Panel } from '@/components/primitives';
import { requestDiscordConnect, requestDiscordSelectGuild } from '@/prototype/state/gateway-discord';
import type { DiscordService } from '@/prototype/state/gateway-discord';
import { computeWizardStep, findConnectedGuildName, ownerDetected } from './wizard-step';
import './connect-wizard.css';

const MAKE_SERVER_URL = 'https://discord.com/channels/@me';
const DEV_PORTAL_URL = 'https://discord.com/developers/applications';

type StepState = 'done' | 'current' | 'upcoming';

function ExternalLinkButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      className="fw-control fw-button fw-button--ghost fw-button--md fw-wizard__link"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      <span className="fw-button__label">{children}</span>
      <Icon name="ArrowRight" size="xs" className="fw-button__icon" />
    </a>
  );
}

function StepMarker({ state }: { state: StepState }) {
  return (
    <span className={`fw-wizard__marker fw-wizard__marker--${state}`}>
      {state === 'done' ? <Icon name="Check" size="xs" /> : null}
    </span>
  );
}

function WizardStep({
  number,
  title,
  state,
  children,
}: {
  number: number;
  title: string;
  state: StepState;
  children: ReactNode;
}) {
  return (
    <li className={`fw-wizard__step fw-wizard__step--${state}`} aria-current={state === 'current' ? 'step' : undefined}>
      <div className="fw-wizard__step-head">
        <StepMarker state={state} />
        <span className="fw-wizard__step-eyebrow">Step {number}</span>
        <h3 className="fw-wizard__step-title">{title}</h3>
      </div>
      <div className="fw-wizard__step-body">{children}</div>
    </li>
  );
}

export default function ConnectWizard({
  service,
  onChanged,
}: {
  service: DiscordService;
  onChanged: () => void;
}) {
  const step = computeWizardStep(service);
  const [token, setToken] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [pickingGuildId, setPickingGuildId] = useState<string | null>(null);
  const [guildError, setGuildError] = useState<string | null>(null);

  const tokenSaved = service.envKeys.some((key) => key.name === 'DISCORD_BOT_TOKEN' && key.present);
  const setupStepState: StepState = tokenSaved ? 'done' : 'current';
  const tokenStepState: StepState = step === 'token' ? 'current' : 'done';
  // 'awaiting-setup' (Codex finding 7): the bot is alive on the real transport but we cannot verify
  // it actually finished setting up — step 4 (getting the bot INTO a server) is treated as already
  // done (an old bot reporting this shape at all implies it got past that point), while step 5
  // shows its own honest waiting message below rather than a premature "Done".
  const inviteStepState: StepState =
    step === 'invite' || step === 'guild' ? 'current' : step === 'done' || step === 'awaiting-setup' ? 'done' : 'upcoming';
  const doneStepState: StepState = step === 'done' ? 'done' : step === 'awaiting-setup' ? 'current' : 'upcoming';

  async function handleConnect(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = token.trim();
    if (trimmed.length === 0 || connecting) return;
    setConnecting(true);
    setConnectError(null);
    // Codex finding K3-9: the pasted token must never linger in React state past this one
    // submission, success OR failure — `finally` clears it unconditionally, rather than only on
    // the success path, so a rejected/failed attempt never leaves it sitting in memory (or visible
    // in the password field) any longer than the single request that just used it.
    try {
      const result = await requestDiscordConnect(trimmed);
      if (!result.ok) {
        setConnectError(result.error ?? 'The gateway could not save this token.');
        return;
      }
      onChanged();
    } finally {
      setConnecting(false);
      setToken('');
    }
  }

  async function handlePickGuild(guildId: string): Promise<void> {
    if (pickingGuildId !== null) return;
    setPickingGuildId(guildId);
    setGuildError(null);
    const result = await requestDiscordSelectGuild(guildId);
    setPickingGuildId(null);
    if (!result.ok) {
      setGuildError(result.error ?? 'The gateway could not save this choice.');
      return;
    }
    onChanged();
  }

  return (
    <Panel
      title="Connect Discord"
      subtitle="Two clicks happen on Discord's own site; everything else happens right here."
      className="fw-wizard"
    >
      <ol className="fw-wizard__list">
        <WizardStep number={1} title="Make your own Discord server" state={setupStepState}>
          <p className="fw-wizard__copy">
            Open Discord and create a new server of your own — this is the server the bot will join. A
            name is all it needs; it takes a few seconds.
          </p>
          <ExternalLinkButton href={MAKE_SERVER_URL}>Open Discord</ExternalLinkButton>
        </WizardStep>

        <WizardStep number={2} title="Make the bot" state={setupStepState}>
          <p className="fw-wizard__copy">
            In the Developer Portal: click <strong className="fw-wizard__ui-label">New Application</strong>,
            give it a name, open the <strong className="fw-wizard__ui-label">Bot</strong> page, click{' '}
            <strong className="fw-wizard__ui-label">Reset Token</strong> and copy the value it shows — then
            turn on <strong className="fw-wizard__ui-label">Message Content Intent</strong> on that same
            page (the bot cannot read messages without it).
          </p>
          <ExternalLinkButton href={DEV_PORTAL_URL}>Open Developer Portal</ExternalLinkButton>
        </WizardStep>

        <WizardStep number={3} title="Paste the token" state={tokenStepState}>
          <form className="fw-wizard__form" onSubmit={(event) => void handleConnect(event)}>
            <Field
              label="Bot token"
              htmlFor="fw-discord-token"
              hint="Sent straight to your own local gateway and saved there — never shown again after this."
            >
              <input
                id="fw-discord-token"
                className="fw-control fw-wizard__input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="Paste the token you copied in step 2"
              />
            </Field>
            <Button type="submit" variant="primary" disabled={connecting || token.trim().length === 0}>
              {connecting ? 'Connecting…' : 'Connect'}
            </Button>
          </form>
          {connectError !== null ? (
            <p className="fw-wizard__alert" role="alert">
              <Icon name="TriangleAlert" size="sm" />
              <span>{connectError}</span>
            </p>
          ) : null}
          {service.loginError !== null && step === 'token' ? (
            <p className="fw-wizard__alert" role="alert">
              <Icon name="TriangleAlert" size="sm" />
              <span>{service.loginError}</span>
            </p>
          ) : null}
          {/* WP-P1: an honest status for the ONE-TIME automatic install of the bot's own
              software — polled independently of this step's own "Connecting…" button label, so
              it shows even while a slow first install is still running in the background. */}
          {service.depsInstallPhase === 'installing' ? (
            <p className="fw-wizard__copy fw-wizard__copy--muted">
              Installing the Discord bot&apos;s software — this only happens once, and can take about a
              minute…
            </p>
          ) : null}
          {service.depsInstallPhase === 'failed' ? (
            <p className="fw-wizard__alert" role="alert">
              <Icon name="TriangleAlert" size="sm" />
              <span>{service.depsInstallError ?? 'The Discord bot’s software could not be installed automatically.'}</span>
            </p>
          ) : null}
        </WizardStep>

        <WizardStep number={4} title="Get the bot into your server" state={inviteStepState}>
          {step === 'guild' ? (
            <div className="fw-wizard__guild-picker">
              <p className="fw-wizard__copy">
                This bot is already in {service.guilds.length} servers — pick the one you just made:
              </p>
              <div className="fw-wizard__guild-options">
                {service.guilds.map((guild) => (
                  <Button
                    key={guild.id}
                    variant="ghost"
                    disabled={pickingGuildId !== null}
                    onClick={() => void handlePickGuild(guild.id)}
                  >
                    {pickingGuildId === guild.id ? 'Connecting…' : guild.name}
                  </Button>
                ))}
              </div>
              {guildError !== null ? (
                <p className="fw-wizard__alert" role="alert">
                  <Icon name="TriangleAlert" size="sm" />
                  <span>{guildError}</span>
                </p>
              ) : null}
            </div>
          ) : service.inviteUrl !== null ? (
            <>
              <p className="fw-wizard__copy">
                Click below, pick the server you made in step 1, then click Discord's own{' '}
                <strong className="fw-wizard__ui-label">Authorise</strong> button on the page that opens —
                that last click has to be yours; nothing can do it for you.
              </p>
              <ExternalLinkButton href={service.inviteUrl}>Invite to my server</ExternalLinkButton>
            </>
          ) : (
            <p className="fw-wizard__copy fw-wizard__copy--muted">Waiting for the bot to log in…</p>
          )}
        </WizardStep>

        <WizardStep number={5} title="Done" state={doneStepState}>
          {step === 'done' ? (
            <ul className="fw-wizard__done-list">
              <li>
                <Icon name="CircleCheck" size="xs" />
                <span>Connected to {findConnectedGuildName(service) ?? 'your server'}.</span>
              </li>
              <li>
                <Icon name={ownerDetected(service) ? 'CircleCheck' : 'TriangleAlert'} size="xs" />
                <span>Owner {ownerDetected(service) ? 'detected automatically.' : 'not detected yet.'}</span>
              </li>
              <li>
                <Icon name="CircleCheck" size="xs" />
                <span>
                  Channels are set up under 🔨 FORGE PROJECTS. A welcome message is posted in #forge-info
                  the first time this connects.
                </span>
              </li>
            </ul>
          ) : step === 'awaiting-setup' ? (
            // Codex finding 7: an older bot that does not report `setup_state` at all is alive on
            // the real transport, but that alone never proves setup actually finished — show the
            // honest unknown instead of guessing "Done".
            <p className="fw-wizard__copy fw-wizard__copy--muted">
              Waiting for the bot to report that setup is finished…
            </p>
          ) : (
            <p className="fw-wizard__copy fw-wizard__copy--muted">Finish the steps above first.</p>
          )}
        </WizardStep>
      </ol>

      <div className="fw-wizard__limits">
        <p className="fw-wizard__limit">
          <Icon name="TriangleAlert" size="xs" />
          <span>
            Forge can&apos;t create the server for you — a bot that creates its own server automatically
            owns it, which would not really be yours to control.
          </span>
        </p>
        <p className="fw-wizard__limit">
          <Icon name="TriangleAlert" size="xs" />
          <span>The bot itself has to be made on Discord&apos;s own site — there is no API for that step.</span>
        </p>
      </div>
    </Panel>
  );
}
