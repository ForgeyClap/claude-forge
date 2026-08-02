/**
 * Theme showcase — the design-system reference page.
 *
 * Everything the workspace is allowed to use, on one screen, in whichever mode
 * you switch to at the top. It is deliberately drift-proof: the specimens are
 * drawn with the tokens themselves and labelled with the token NAME rather than
 * a copied value, so this page cannot quietly disagree with brand/tokens.json.
 *
 * Nothing here is data. It is the material the rest of the prototype is cut
 * from — surfaces, type, status treatments, group luminance, controls, icons,
 * radii, shadows, spacing, provenance and focus.
 */

import {
  Button,
  Eyebrow,
  Icon,
  IconButton,
  KeyHint,
  Machine,
  Meter,
  Panel,
  SegmentedControl,
  Spacer,
  StatusBadge,
  StatusDot,
  Switch,
  Toolbar,
  ToolbarGroup,
  statusPresentation,
} from '@/components/primitives';
import type { IconSize } from '@/components/primitives';
import { usePrototype } from '@/prototype/state/prototype-store';
import { STATUS_KEYS } from '@/prototype/types/prototype-types';
import type { AgentGroup, Appearance, Density } from '@/prototype/types/prototype-types';

import './theme-showcase.css';

/* ------------------------------------------------------------- specimens */

interface Named {
  readonly key: string;
  readonly token: string;
}

const SURFACES: readonly Named[] = [
  { key: 'canvas', token: '--forge-color-canvas' },
  { key: 'bg', token: '--forge-color-bg' },
  { key: 'surface-1', token: '--forge-color-surface-1' },
  { key: 'surface-2', token: '--forge-color-surface-2' },
  { key: 'surface-3', token: '--forge-color-surface-3' },
  { key: 'raised', token: '--forge-color-raised' },
  { key: 'sunken', token: '--forge-color-sunken' },
];

const LINES: readonly Named[] = [
  { key: 'line-subtle', token: '--forge-color-line-subtle' },
  { key: 'line', token: '--forge-color-line' },
  { key: 'line-strong', token: '--forge-color-line-strong' },
  { key: 'line-loud', token: '--forge-color-line-loud' },
];

const TEXTS: readonly Named[] = [
  { key: 'text', token: '--forge-color-text' },
  { key: 'text-secondary', token: '--forge-color-text-secondary' },
  { key: 'text-muted', token: '--forge-color-text-muted' },
  { key: 'text-faint', token: '--forge-color-text-faint' },
  { key: 'text-on-accent', token: '--forge-color-text-on-accent' },
  { key: 'text-inverse', token: '--forge-color-text-inverse' },
];

const TYPE_SCALE: readonly Named[] = [
  { key: '4xl', token: '--forge-text-4xl' },
  { key: '3xl', token: '--forge-text-3xl' },
  { key: '2xl', token: '--forge-text-2xl' },
  { key: 'xl', token: '--forge-text-xl' },
  { key: 'lg', token: '--forge-text-lg' },
  { key: 'md', token: '--forge-text-md' },
  { key: 'base', token: '--forge-text-base' },
  { key: 'sm', token: '--forge-text-sm' },
  { key: 'xs', token: '--forge-text-xs' },
  { key: '2xs', token: '--forge-text-2xs' },
];

const GROUPS: readonly AgentGroup[] = [
  'control',
  'context',
  'planning',
  'domain',
  'execution',
  'review',
  'memory',
];

const CONTROL_HEIGHTS: readonly Named[] = [
  { key: 'xs', token: '--forge-control-xs' },
  { key: 'sm', token: '--forge-control-sm' },
  { key: 'md', token: '--forge-control-md' },
  { key: 'lg', token: '--forge-control-lg' },
  { key: 'xl', token: '--forge-control-xl' },
];

const ICON_SIZES: readonly { readonly key: IconSize; readonly token: string }[] = [
  { key: 'xs', token: '--forge-icon-xs' },
  { key: 'sm', token: '--forge-icon-sm' },
  { key: 'md', token: '--forge-icon-md' },
  { key: 'lg', token: '--forge-icon-lg' },
  { key: 'xl', token: '--forge-icon-xl' },
];

const RADII: readonly Named[] = [
  { key: 'xs', token: '--forge-radius-xs' },
  { key: 'sm', token: '--forge-radius-sm' },
  { key: 'md', token: '--forge-radius-md' },
  { key: 'lg', token: '--forge-radius-lg' },
  { key: 'xl', token: '--forge-radius-xl' },
  { key: '2xl', token: '--forge-radius-2xl' },
  { key: 'full', token: '--forge-radius-full' },
];

const SHADOWS: readonly Named[] = [
  { key: 'sm', token: '--forge-shadow-sm' },
  { key: 'md', token: '--forge-shadow-md' },
  { key: 'lg', token: '--forge-shadow-lg' },
  { key: 'inset', token: '--forge-shadow-inset' },
];

const SPACES: readonly Named[] = [
  { key: 'px', token: '--forge-space-px' },
  { key: '1', token: '--forge-space-1' },
  { key: '2', token: '--forge-space-2' },
  { key: '3', token: '--forge-space-3' },
  { key: '4', token: '--forge-space-4' },
  { key: '5', token: '--forge-space-5' },
  { key: '6', token: '--forge-space-6' },
  { key: '8', token: '--forge-space-8' },
  { key: '10', token: '--forge-space-10' },
  { key: '12', token: '--forge-space-12' },
  { key: '16', token: '--forge-space-16' },
  { key: '20', token: '--forge-space-20' },
];

const MACHINE_LINES: readonly string[] = [
  'run_8f21c4 · started 14:02:07',
  'agent-build-boss · forge-runtime · high effort',
  'src/views/theme/ThemeShowcaseView.tsx',
  'npm run verify --silent',
  'event: work-package.rejected · code 2',
  'sha 4c1f9ab · port 5173',
];

/* ------------------------------------------------------------------ view */

export default function ThemeShowcaseView() {
  const { state, dispatch } = usePrototype();

  return (
    <div className="fw-theme">
      <header className="fw-theme__head">
        <div className="fw-theme__headings">
          <Eyebrow>DESIGN SYSTEM</Eyebrow>
          <h1 className="fw-theme__title">Theme showcase</h1>
          <p className="fw-theme__lede">
            Every value the workspace is allowed to use. The palette is monochrome; the single hue is
            the rationed ember accent, and it appears only on the focus ring, the one active control
            and running progress. Switch modes below and check that the system still holds.
          </p>
        </div>
        <Toolbar label="Theme controls" className="fw-theme__toolbar">
          <SegmentedControl
            label="Appearance"
            value={state.appearance}
            onChange={(next) => dispatch({ type: 'appearance/set', appearance: next as Appearance })}
            options={[
              { value: 'dark', label: 'Dark', icon: 'Moon' },
              { value: 'light', label: 'Light', icon: 'Sun' },
              { value: 'system', label: 'System', icon: 'Monitor' },
            ]}
          />
          <ToolbarGroup divided>
            <SegmentedControl
              label="Density"
              size="sm"
              value={state.density}
              onChange={(next) => dispatch({ type: 'density/set', density: next as Density })}
              options={[
                { value: 'comfortable', label: 'Comfortable' },
                { value: 'compact', label: 'Compact' },
              ]}
            />
          </ToolbarGroup>
          <Spacer />
          <Machine muted>{`resolved: ${state.resolvedTheme} · density: ${state.density}`}</Machine>
        </Toolbar>
      </header>

      <div className="fw-theme__body fw-scroll">
        <div className="fw-theme__sections">
          {/* ------------------------------------------------- surfaces */}
          <Panel
            title="Surface ramp"
            subtitle="Seven steps from the canvas to the raised panel. Each surface keeps a border so it never dissolves into the page."
          >
            <ul className="fw-theme__swatches">
              {SURFACES.map((surface) => (
                <li key={surface.key} className="fw-theme__swatch">
                  <span className="fw-theme__swatch-chip" data-surface={surface.key} />
                  <span className="fw-theme__swatch-key">{surface.key}</span>
                  <Machine muted className="fw-theme__swatch-token">
                    {surface.token}
                  </Machine>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel
            title="Line values"
            subtitle="Four weights of edge. A divider is a value choice, not a shadow."
          >
            <ul className="fw-theme__lines">
              {LINES.map((line) => (
                <li key={line.key} className="fw-theme__line-row">
                  <span className="fw-theme__line-key">{line.key}</span>
                  <span className="fw-theme__line-rule" data-line={line.key} />
                  <Machine muted>{line.token}</Machine>
                </li>
              ))}
            </ul>
          </Panel>

          {/* ----------------------------------------------------- text */}
          <Panel
            title="Text hierarchy"
            subtitle="Four reading weights plus the two inverted values. Contrast carries rank, never colour."
          >
            <ul className="fw-theme__texts">
              {TEXTS.map((text) => (
                <li key={text.key} className="fw-theme__text-row">
                  <span className="fw-theme__text-sample" data-text={text.key}>
                    The forge is a dark room.
                  </span>
                  <Machine muted>{text.token}</Machine>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel
            title="Type scale"
            subtitle="Ten steps. Headings stay restrained — the largest sizes are for numbers and empty states, not for shouting."
          >
            <ul className="fw-theme__scale">
              {TYPE_SCALE.map((step) => (
                <li key={step.key} className="fw-theme__scale-row">
                  <span className="fw-theme__scale-sample" data-size={step.key}>
                    Forge workspace
                  </span>
                  <Machine muted className="fw-theme__scale-token">
                    {step.token}
                  </Machine>
                </li>
              ))}
            </ul>
          </Panel>

          {/* --------------------------------------------------- status */}
          <Panel
            title="Status system"
            subtitle="Seven states. Each one carries an icon, an uppercase label and a border treatment, so it survives greyscale, colour blindness and a laser printer."
          >
            <ul className="fw-theme__statuses">
              {STATUS_KEYS.map((status) => {
                const presentation = statusPresentation(status);
                return (
                  <li key={status}>
                    <article className="fw-theme__status fw-status" data-status={status}>
                      <header className="fw-theme__status-head">
                        <StatusBadge status={status} />
                        <StatusDot status={status} />
                      </header>
                      <p className="fw-theme__status-desc">{presentation.description}</p>
                      <span className="fw-theme__status-rule" />
                      <ul className="fw-theme__status-tokens">
                        <li>
                          <Machine muted>{`--forge-status-${status}`}</Machine>
                        </li>
                        <li>
                          <Machine muted>{`--forge-status-${status}-style`}</Machine>
                        </li>
                        <li>
                          <Machine muted>{`--forge-status-${status}-width`}</Machine>
                        </li>
                      </ul>
                    </article>
                  </li>
                );
              })}
            </ul>
            <p className="fw-theme__caption">
              The card border, the ring around the dot and the rule above the token list all use the
              same <Machine muted>-style</Machine> and <Machine muted>-width</Machine> pair, which is
              why solid, dashed and dotted read as three different states before you read a word.
            </p>
          </Panel>

          {/* --------------------------------------------------- groups */}
          <Panel
            title="Agent groups"
            subtitle="Seven luminance steps, in heat order. Group identity tempers a surface; it never competes with status."
          >
            <ul className="fw-theme__groups">
              {GROUPS.map((group) => (
                <li key={group} className="fw-theme__group" data-group={group}>
                  <span className="fw-theme__group-bar" />
                  <div className="fw-theme__group-text">
                    <span className="fw-theme__group-name">{group}</span>
                    <Machine muted>{`--forge-group-${group}`}</Machine>
                  </div>
                  <Machine muted className="fw-theme__group-soft">
                    -soft · -line
                  </Machine>
                </li>
              ))}
            </ul>
          </Panel>

          {/* ------------------------------------------------- controls */}
          <Panel
            title="Control heights"
            subtitle="Five heights. Every interactive thing in the workspace snaps to one of them, and density retunes which one a component picks."
          >
            <ul className="fw-theme__controls">
              {CONTROL_HEIGHTS.map((control) => (
                <li key={control.key} className="fw-theme__control-row">
                  <span className="fw-theme__control-box" data-control={control.key}>
                    <span className="fw-theme__control-key">{control.key}</span>
                  </span>
                  <Machine muted>{control.token}</Machine>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel
            title="Controls in place"
            subtitle="The primitives at their real sizes, so a new component has something to line up against."
          >
            <div className="fw-theme__control-demo">
              <Button variant="primary" icon="Play">
                Primary
              </Button>
              <Button icon="RefreshCw">Ghost</Button>
              <Button variant="quiet" icon="ChevronDown">
                Quiet
              </Button>
              <Button variant="danger" icon="TriangleAlert">
                Danger
              </Button>
              <Button size="sm" icon="Plus">
                Small
              </Button>
              <IconButton icon="Settings" label="Settings" />
              <IconButton icon="PanelRight" label="Toggle inspector" active />
              <Switch checked onChange={() => undefined} label="Switch on" />
              <Switch checked={false} onChange={() => undefined} label="Switch off" />
              <KeyHint keys={['Ctrl', 'K']} />
              <KeyHint keys={['Esc']} size="md" />
            </div>
            <div className="fw-theme__meters">
              <Meter value={68} label="Neutral progress" showValue />
              <Meter value={41} label="Running progress" tone="accent" showValue />
            </div>
            <p className="fw-theme__caption">
              Two of the four rationed uses of ember are visible here: the primary button and the
              accent meter. The other two are the focus ring and the marker under the selected
              segment.
            </p>
          </Panel>

          {/* ---------------------------------------------------- icons */}
          <Panel
            title="Icon sizes"
            subtitle="Five sizes, one stroke language: 1.5 for most of the interface, 2 where a mark needs weight."
          >
            <ul className="fw-theme__icons">
              {ICON_SIZES.map((size) => (
                <li key={size.key} className="fw-theme__icon-cell">
                  <span className="fw-theme__icon-frame">
                    <Icon name="Hammer" size={size.key} />
                  </span>
                  <span className="fw-theme__icon-key">{size.key}</span>
                  <Machine muted className="fw-theme__icon-token">
                    {size.token}
                  </Machine>
                </li>
              ))}
            </ul>
            <div className="fw-theme__stroke-demo">
              <span className="fw-theme__stroke-cell">
                <Icon name="ShieldCheck" size="lg" strokeWidth={1.5} />
                <Machine muted>strokeWidth 1.5</Machine>
              </span>
              <span className="fw-theme__stroke-cell">
                <Icon name="ShieldCheck" size="lg" strokeWidth={2} />
                <Machine muted>strokeWidth 2</Machine>
              </span>
            </div>
          </Panel>

          {/* ---------------------------------------------------- radii */}
          <Panel
            title="Radii"
            subtitle="Seven steps. Small radii for controls, larger ones for panels and dialogs, full only for pills and dots."
          >
            <ul className="fw-theme__radii">
              {RADII.map((radius) => (
                <li key={radius.key} className="fw-theme__radius">
                  <span className="fw-theme__radius-box" data-radius={radius.key} />
                  <span className="fw-theme__radius-key">{radius.key}</span>
                  <Machine muted className="fw-theme__radius-token">
                    {radius.token}
                  </Machine>
                </li>
              ))}
            </ul>
          </Panel>

          {/* -------------------------------------------------- shadows */}
          <Panel
            title="Shadows"
            subtitle="Depth is rationed too. A shadow separates a floating layer from the page; it is never decoration."
          >
            <ul className="fw-theme__shadows">
              {SHADOWS.map((shadow) => (
                <li key={shadow.key} className="fw-theme__shadow">
                  <span className="fw-theme__shadow-box" data-shadow={shadow.key} />
                  <span className="fw-theme__shadow-key">{shadow.key}</span>
                  <Machine muted className="fw-theme__shadow-token">
                    {shadow.token}
                  </Machine>
                </li>
              ))}
            </ul>
          </Panel>

          {/* -------------------------------------------------- spacing */}
          <Panel
            title="Spacing scale"
            subtitle="Twelve steps. Rhythm does most of the work that a border or a background would otherwise be asked to do."
          >
            <ul className="fw-theme__spaces">
              {SPACES.map((space) => (
                <li key={space.key} className="fw-theme__space-row">
                  <span className="fw-theme__space-key">{space.key}</span>
                  <span className="fw-theme__space-bar" data-space={space.key} />
                  <Machine muted>{space.token}</Machine>
                </li>
              ))}
            </ul>
          </Panel>

          {/* ----------------------------------------------- provenance */}
          <Panel
            title="Provenance"
            subtitle="Type marks where a line came from. Sans is what a person wrote; mono is what the system recorded."
          >
            <div className="fw-theme__provenance">
              <article className="fw-theme__prov-card">
                <Eyebrow>HUMAN — SANS</Eyebrow>
                <p className="fw-theme__prov-prose">
                  The booking flow now holds availability per barber rather than per shop, which is
                  what the owner actually described. Two edge cases still need a decision: a barber
                  who works a half day, and a service that runs past closing time.
                </p>
                <p className="fw-theme__prov-note">
                  Chat messages, descriptions, reports, summaries, any sentence a person is
                  responsible for.
                </p>
              </article>
              <article className="fw-theme__prov-card">
                <Eyebrow>MACHINE — MONO</Eyebrow>
                <ul className="fw-theme__prov-lines">
                  {MACHINE_LINES.map((line) => (
                    <li key={line}>
                      <Machine>{line}</Machine>
                    </li>
                  ))}
                </ul>
                <p className="fw-theme__prov-note">
                  Ids, agent names, model labels, timestamps, paths, commands, hashes, ports, event
                  names, test output, ledger lines.
                </p>
              </article>
            </div>
            <p className="fw-theme__caption">
              If you cannot tell which face a piece of text should take, it probably is not ready to
              be in the interface yet.
            </p>
          </Panel>

          {/* ---------------------------------------------------- focus */}
          <Panel
            title="Focus and motion"
            subtitle="One ring, everywhere, drawn with the focus-ring token so it reads on both canvases. Keyboard only — pointer focus stays silent."
          >
            <p className="fw-theme__caption">
              Press <KeyHint keys={['Tab']} /> to walk the row below and watch the ring. It is the
              third rationed use of ember.
            </p>
            <div className="fw-theme__focus-row">
              <Button>Focusable button</Button>
              <IconButton icon="Search" label="Search" />
              <input
                className="fw-theme__input"
                type="text"
                defaultValue="focusable input"
                aria-label="Focusable input example"
              />
              <SegmentedControl
                label="Focus demo"
                size="sm"
                value="one"
                onChange={() => undefined}
                options={[
                  { value: 'one', label: 'One' },
                  { value: 'two', label: 'Two' },
                ]}
              />
              {/* Points at this route: the shell uses a hash router, so a bare
                  in-page fragment would read as a navigation. */}
              <a className="fw-theme__link" href="#/theme">
                Focusable link
              </a>
            </div>
            <ul className="fw-theme__facts">
              <li>
                <Machine muted>--forge-shadow-focus-ring</Machine>
                <span>Two rings: a canvas-coloured gap, then the ember line.</span>
              </li>
              <li>
                <Machine muted>prefers-reduced-motion: reduce</Machine>
                <span>
                  Disables every animation and transition in the workspace, unconditionally. The
                  spinning status icon stops, the theme flip snaps, nothing moves on its own.
                </span>
              </li>
              <li>
                <Machine muted>--forge-motion-fast / -base / -slow</Machine>
                <span>
                  The only durations in use. Motion is there to explain a change of state, never to
                  decorate one.
                </span>
              </li>
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}
