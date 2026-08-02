/**
 * mode-controls — the composer's Auto-plan / Effort / Model / Send-mode controls.
 *
 * refactor-chat-split (forge-2026-07-30-cc-finish): split out of `Composer.tsx` — this component
 * (not the STATE it displays, which stays in `Composer.tsx`; see that file's own header for why) is
 * a pure, controlled presentational unit: every choice and every setter is a prop. Pure structural
 * move: no behavior changed, no class name changed.
 *
 * feat-model-picker: the Model `MenuButton` was added alongside Effort (same component, same
 * popover, no new style language) so the composer can also pick which model the next send runs
 * with — see `Composer.tsx`'s own header for the full state-plumbing story and
 * `gateway/src/server.mjs`'s `EXEC_MODEL_VALUES` for the real allowlist this mirrors.
 */

import { SegmentedControl, Switch } from '@/components/primitives';
import type { ChatSendMode } from '@/prototype/state/chat-send';

import { isChatSendEffort, isChatSendMode, isChatSendModel } from './compose-args';
import { MenuButton } from './menu-button';
import type { MenuOption } from './menu-button';
import type { EffortChoice, ModelChoice } from './mode-storage';

/**
 * composer-modes-ui: the full permission-mode set Claude Code's own picker offers, widened from
 * fix-ui-clutter's original Execute|Plan pair — mirrors `ChatSendMode` exactly, same
 * SegmentedControl style.
 *
 * feat-forge-preamble: a project's very first send now defaults to Bypass, not Execute — see
 * `mode-storage.ts`'s own doc comment for the honest reason (a non-interactive dashboard session
 * can never answer an interactive approval prompt, so `'execute'` would silently refuse most real
 * write work on a brand-new project). `Composer.tsx`'s own hint paragraph states this plainly the
 * moment Bypass is the active mode; Plan's own real limitation (no tool calls at all, so it can
 * never ask a clarifying question) gets the same honest, always-visible treatment right there too.
 */
const SEND_MODE_OPTIONS = [
  { value: 'execute', label: 'Execute' },
  { value: 'plan', label: 'Plan' },
  { value: 'accept-edits', label: 'Accept edits' },
  { value: 'bypass', label: 'Bypass' },
] as const;

const EFFORT_LABELS: Readonly<Record<EffortChoice, string>> = {
  default: 'Default',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

const EFFORT_OPTIONS: readonly MenuOption[] = (['default', 'low', 'medium', 'high', 'xhigh', 'max'] as const).map(
  (id) => ({ id, icon: 'Gauge', label: EFFORT_LABELS[id] }),
);

/**
 * feat-model-picker: the composer's model picker — reuses `MenuButton`'s existing label+detail+
 * checkmark layout (no new style language), header "Select a model" (`title` below), one option
 * per real `ModelChoice` with a short title and a one-line description underneath, matching the
 * real Claude Code model picker's own copy verbatim (owner-provided from a screenshot of that
 * picker). "Default (recommended)" is first and omits `--model` entirely — see
 * `mode-storage.ts`'s `ModelChoice` doc comment. The trigger shows only the SHORT name
 * (`MODEL_TRIGGER_LABELS`); the fuller "(1M context)"/"(recommended)" qualifiers only ever appear
 * inside the open menu, mirroring how the Effort trigger above shows just "High", not "High
 * effort".
 *
 * "Opus (1M context)" sends `'claude-opus-5[1m]'` (2026-07-30 CORRECTION) — real, non-mock
 * `claude -p --model 'claude-opus-5[1m]' ...` CLI runs proved this exact bracket-suffixed id is
 * accepted `--model` INPUT (see `gateway/src/server.mjs`'s own `EXEC_MODEL_VALUES` comment for the
 * exact commands/exit codes), superseding an earlier round that sent the plain `'claude-opus-5'`
 * id for lack of that evidence. The description text is unchanged either way.
 */
const MODEL_OPTIONS: readonly MenuOption[] = [
  { id: 'default', icon: 'Cpu', label: 'Default (recommended)', detail: 'Opus 5 with 1M context · Best for everyday, complex tasks' },
  { id: 'claude-opus-5[1m]', icon: 'Cpu', label: 'Opus (1M context)', detail: 'Opus 5 with 1M context · Best for everyday, complex tasks' },
  { id: 'claude-fable-5', icon: 'Cpu', label: 'Fable', detail: 'Fable 5 · Most capable for your hardest and longest-running tasks' },
  { id: 'claude-sonnet-5', icon: 'Cpu', label: 'Sonnet', detail: 'Sonnet 5 · Efficient for routine tasks' },
  { id: 'claude-haiku-4-5-20251001', icon: 'Cpu', label: 'Haiku', detail: 'Haiku 4.5 · Fastest for quick answers' },
];

// The default-state trigger text is deliberately 'Model', not 'Default' — the Effort trigger right
// next to it ALREADY legitimately shows 'Default' at ITS own default choice (`EFFORT_LABELS`
// above), and RTL's/screen-readers' accessible-name lookup is by visible text: two sibling buttons
// both literally named "Default" would be genuinely ambiguous to a keyboard/screen-reader user,
// not just to a test query. 'Model' also stays honest — the trigger's whole job is showing the
// CURRENT choice, and "no model chosen yet" is accurately described by naming the picker itself.
const MODEL_TRIGGER_LABELS: Readonly<Record<ModelChoice, string>> = {
  default: 'Model',
  'claude-opus-5[1m]': 'Opus',
  'claude-fable-5': 'Fable',
  'claude-sonnet-5': 'Sonnet',
  'claude-haiku-4-5-20251001': 'Haiku',
};

export interface ComposerModeControlsProps {
  readonly autoPlan: boolean;
  readonly onAutoPlanChange: (value: boolean) => void;
  readonly effortChoice: EffortChoice;
  readonly onEffortChoiceChange: (choice: EffortChoice) => void;
  readonly modelChoice: ModelChoice;
  readonly onModelChoiceChange: (choice: ModelChoice) => void;
  readonly sendMode: ChatSendMode;
  readonly onSendModeChange: (mode: ChatSendMode) => void;
}

/**
 * Auto-plan switch + Effort menu + Send-mode segmented control. Returns a Fragment (never a
 * wrapping element) so all three stay direct flex children of `Composer.tsx`'s own
 * `.fw-chat-composer__row`, exactly as before this split.
 */
export function ComposerModeControls({
  autoPlan,
  onAutoPlanChange,
  effortChoice,
  onEffortChoiceChange,
  modelChoice,
  onModelChoiceChange,
  sendMode,
  onSendModeChange,
}: ComposerModeControlsProps) {
  return (
    <>
      <Switch
        checked={autoPlan}
        onChange={onAutoPlanChange}
        label="Auto-plan"
        size="sm"
        className="fw-chat-composer__autoplan"
      />

      <MenuButton
        icon="Gauge"
        label="Effort"
        title="Effort"
        options={EFFORT_OPTIONS}
        triggerLabel={EFFORT_LABELS[effortChoice]}
        selectedId={effortChoice}
        footer="Sets --effort on the next send. Default omits the field entirely — the CLI's own default."
        onPick={(option) => onEffortChoiceChange(isChatSendEffort(option.id) ? option.id : 'default')}
      />

      <MenuButton
        icon="Cpu"
        label="Model"
        title="Select a model"
        options={MODEL_OPTIONS}
        triggerLabel={MODEL_TRIGGER_LABELS[modelChoice]}
        selectedId={modelChoice}
        footer="Sets --model on the next send. Default omits the field entirely — the CLI's own default."
        onPick={(option) => onModelChoiceChange(isChatSendModel(option.id) ? option.id : 'default')}
      />

      <SegmentedControl
        options={SEND_MODE_OPTIONS}
        value={sendMode}
        onChange={(next) => onSendModeChange(isChatSendMode(next) ? next : 'execute')}
        label="Send mode"
        size="sm"
        className="fw-chat-composer__mode"
      />
    </>
  );
}
