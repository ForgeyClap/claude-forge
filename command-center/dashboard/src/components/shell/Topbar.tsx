/**
 * Forge Workspace — the topbar.
 *
 * Left: the drawer opener (narrow screens only), the breadcrumb and the view
 * title. Right: a search affordance that opens the command palette, the local
 * Claude Code status chip, the appearance control, the inspector and dock
 * toggles, and an account placeholder.
 *
 * The Claude Code chip is presentation, and only presentation. The prototype
 * runs no detection of any kind: it does not look for a CLI, an editor, a port
 * or a session. The chip states that plainly rather than implying a check.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

import {
  Avatar,
  Icon,
  IconButton,
  KeyHint,
  Machine,
  SegmentedControl,
} from '@/components/primitives';
import { isFixtureMode } from '@/config/mode';
import { selectActiveProject, usePrototype } from '@/prototype/state/prototype-store';
// WP7b: the real gateway connection + Claude Code health, not the
// intentionally-unused bridge ones — see `gateway-adapter.ts`'s header.
import { useGatewayClaudeCodeHealth, useGatewayConnection as useConnection } from '@/prototype/state/gateway-adapter';
import type { Appearance, Density } from '@/prototype/types/prototype-types';

import { liveChipState } from './claude-code-chip';
import { ALL_NAV } from './nav-config';
import { WaitingChip } from './WaitingChip';
import './topbar.css';

const APPEARANCE_OPTIONS = [
  { value: 'dark', label: 'Dark', icon: 'Moon' },
  { value: 'light', label: 'Light', icon: 'Sun' },
  { value: 'system', label: 'System', icon: 'Monitor' },
];

const DENSITY_OPTIONS = [
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'compact', label: 'Compact' },
];

function toAppearance(value: string): Appearance {
  return value === 'dark' || value === 'light' ? value : 'system';
}

function toDensity(value: string): Density {
  return value === 'compact' ? 'compact' : 'comfortable';
}

/* ------------------------------------------------------------- chip */

/**
 * The topbar Claude Code chip. In PRODUCTION it reflects the real connection to
 * the local gateway and the real Claude Code health. In fixtures it keeps the
 * fixed example chip the theme showcase and screenshots rely on.
 */
function ClaudeCodeChip() {
  if (isFixtureMode()) return <FixtureClaudeCodeChip />;
  return <LiveClaudeCodeChip />;
}

/** The unchanged prototype placeholder. Fixture-only; says what is true there. */
function FixtureClaudeCodeChip() {
  const full = 'Claude Code · Local session · Not connected in prototype';
  return (
    <span className="fw-cc" title={`${full} — the prototype performs no detection.`}>
      <Icon name="Terminal" size="xs" className="fw-cc__icon" />
      <Machine className="fw-cc__text">
        <span className="fw-cc__part">Claude Code</span>
        <span className="fw-cc__sep" aria-hidden="true">
          ·
        </span>
        <span className="fw-cc__part">Local session</span>
        <span className="fw-cc__sep" aria-hidden="true">
          ·
        </span>
        <span className="fw-cc__state">Not connected in prototype</span>
      </Machine>
    </span>
  );
}

/** The connected chip: the live gateway connection and Claude Code health, truthfully. */
function LiveClaudeCodeChip() {
  const connection = useConnection();
  const claude = useGatewayClaudeCodeHealth()?.claudeCode ?? null;
  const chip = liveChipState(connection.status, claude);
  return (
    <span className="fw-cc" title={chip.title}>
      <Icon name="Terminal" size="xs" className="fw-cc__icon" />
      <Machine className="fw-cc__text">
        <span className="fw-cc__part">Claude Code</span>
        <span className="fw-cc__sep" aria-hidden="true">
          ·
        </span>
        <span className="fw-cc__state">{chip.state}</span>
      </Machine>
    </span>
  );
}

/* ---------------------------------------------------------- account */

interface AccountPopoverProps {
  readonly onClose: () => void;
}

function AccountPopover({ onClose }: AccountPopoverProps) {
  const { state, dispatch } = usePrototype();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button, a, [tabindex]')?.focus();
  }, []);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="fw-account"
      role="dialog"
      aria-label="Account and preferences"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div className="fw-account__head">
        <Avatar name="Local workspace" size="sm" decorative />
        <span className="fw-account__identity">
          <span className="fw-account__name">Local workspace</span>
          <Machine muted className="fw-account__handle">
            no account or sign-in
          </Machine>
        </span>
      </div>

      <div className="fw-account__group">
        <span className="fg-eyebrow">Appearance</span>
        <SegmentedControl
          label="Appearance"
          size="sm"
          options={APPEARANCE_OPTIONS}
          value={state.appearance}
          onChange={(value) =>
            dispatch({ type: 'appearance/set', appearance: toAppearance(value) })
          }
        />
      </div>

      <div className="fw-account__group">
        <span className="fg-eyebrow">Density</span>
        <SegmentedControl
          label="Density"
          size="sm"
          options={DENSITY_OPTIONS}
          value={state.density}
          onChange={(value) => dispatch({ type: 'density/set', density: toDensity(value) })}
        />
      </div>

      <hr className="fw-divider" />

      <NavLink to="/settings" className="fw-account__item" onClick={onClose}>
        <Icon name="Settings" size="sm" className="fw-account__icon" />
        <span>Open settings</span>
      </NavLink>

      <button
        type="button"
        className="fw-account__item"
        onClick={() => {
          dispatch({ type: 'dock/toggle' });
          onClose();
        }}
      >
        <Icon name="PanelBottom" size="sm" className="fw-account__icon" />
        <span>{state.dockOpen ? 'Hide dock' : 'Show dock'}</span>
      </button>

      <button
        type="button"
        className="fw-account__item"
        onClick={() => {
          dispatch({ type: 'inspector/toggle' });
          onClose();
        }}
      >
        <Icon name="PanelRight" size="sm" className="fw-account__icon" />
        <span>{state.inspectorOpen ? 'Hide inspector' : 'Show inspector'}</span>
      </button>

      <p className="fw-account__note">
        There is no account system. Appearance and layout preferences are the only things saved here.
      </p>
    </div>
  );
}

/* ---------------------------------------------------------- topbar */

export default function Topbar() {
  const { state, dispatch } = usePrototype();
  const location = useLocation();
  const [accountOpen, setAccountOpen] = useState(false);

  const project = selectActiveProject(state);
  const view = ALL_NAV.find((item) => item.path === location.pathname) ?? ALL_NAV[0];

  const closeAccount = useCallback(() => setAccountOpen(false), []);

  return (
    <header className="fw-topbar">
      <IconButton
        className="fw-topbar__drawer"
        icon="PanelLeft"
        label="Open navigation"
        size="sm"
        onClick={() => dispatch({ type: 'drawer/set', open: true })}
      />

      <div className="fw-topbar__identity">
        <nav className="fw-crumbs" aria-label="Breadcrumb">
          <ol className="fw-crumbs__list">
            <li className="fw-crumbs__item">
              <NavLink to="/project" className="fw-crumbs__link fw-truncate">
                {project?.name ?? 'Workspace'}
              </NavLink>
            </li>
            <li className="fw-crumbs__item" aria-hidden="true">
              <Icon name="ChevronRight" size="xs" className="fw-crumbs__sep" />
            </li>
            <li className="fw-crumbs__item">
              <span className="fw-crumbs__current fw-truncate" aria-current="page">
                {view.label}
              </span>
            </li>
          </ol>
        </nav>
        <h1 className="fw-topbar__title fw-truncate" title={view.description}>
          {view.label}
        </h1>
      </div>

      <div className="fw-topbar__tools">
        <button
          type="button"
          className="fw-topbar__search"
          onClick={() => dispatch({ type: 'palette/set', open: true })}
          aria-label="Search the workspace"
          title="Search the workspace (Ctrl + K)"
        >
          <Icon name="Search" size="sm" className="fw-topbar__search-icon" />
          <span className="fw-topbar__search-text">Search…</span>
          <KeyHint keys={['Ctrl', 'K']} />
        </button>

        <WaitingChip />

        <ClaudeCodeChip />

        <span className="fw-topbar__appearance">
          <SegmentedControl
            label="Appearance"
            size="sm"
            options={APPEARANCE_OPTIONS}
            value={state.appearance}
            onChange={(value) =>
              dispatch({ type: 'appearance/set', appearance: toAppearance(value) })
            }
          />
        </span>

        <span className="fw-topbar__panels">
          <IconButton
            icon="PanelBottom"
            label={state.dockOpen ? 'Hide dock' : 'Show dock'}
            size="sm"
            active={state.dockOpen}
            onClick={() => dispatch({ type: 'dock/toggle' })}
          />
          <IconButton
            icon="PanelRight"
            label={state.inspectorOpen ? 'Hide inspector' : 'Show inspector'}
            size="sm"
            active={state.inspectorOpen}
            onClick={() => dispatch({ type: 'inspector/toggle' })}
          />
        </span>

        <span className="fw-topbar__account">
          <button
            type="button"
            className="fw-topbar__account-button"
            aria-haspopup="dialog"
            aria-expanded={accountOpen}
            aria-label="Account and preferences"
            title="Account and preferences"
            onClick={() => setAccountOpen((open) => !open)}
          >
            <Avatar name="Local workspace" size="sm" decorative />
          </button>
          {accountOpen ? <AccountPopover onClose={closeAccount} /> : null}
        </span>
      </div>
    </header>
  );
}
