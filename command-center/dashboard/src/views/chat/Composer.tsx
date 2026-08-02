/**
 * Composer — the one place a message is produced.
 *
 * The field grows with its content up to a ceiling and then scrolls. Enter
 * sends, Shift+Enter breaks the line, and an in-progress reply turns the send
 * button into Stop.
 *
 * IN PRODUCTION (`production` set) Send drives a real Claude Code run and Stop
 * cancels it: `onSend` returns whether the bridge accepted the message, and the
 * field is cleared ONLY on acceptance — a refused send keeps the draft and never
 * claims it was sent. IN FIXTURES the same buttons feed the local reveal, and
 * `onSend` returns `true` synchronously, so that path is unchanged.
 *
 * The three left-hand buttons, honestly:
 *   Attach   real (build-lastdemos): once a conversation exists, picking a
 *            file really uploads it via `POST /api/conversations/:id/attachments`
 *            (attachments.mjs) and shows a removable chip. A text-like file's
 *            real content is inlined into the NEXT sent message (bounded,
 *            between clear markers); a binary file is referenced by its real
 *            stored path instead — see `attachmentBlock` below and this WP's
 *            forge-report for the named handoff on that path-reference choice.
 *            Before any conversation exists there is nothing to attach to yet,
 *            so the control stays disabled with an honest title.
 *   Context  real: picking a source (this project / latest run / changed files
 *            / quality gates) reads `state.data` — already real in production —
 *            and prefixes a real context block onto the draft. An empty source
 *            raises an honest "nothing to add" toast instead of faking a block.
 *   Skills   real: `GET /api/skills` (a real gateway route with zero other
 *            callers before this) is fetched lazily, only once the menu is
 *            opened, and lists this project's real skills. Picking one prefixes
 *            a real skill directive onto the draft.
 *
 * WRITE SCOPE (fix-composer-truth, forge-2026-07-29-cc-finish): a production
 * send spawns a real, non-interactive `claude -p` with the active project's
 * folder as its only allowed working directory (`exec-bridge.mjs`, untouched
 * by this file). In Execute/Plan/Accept-edits mode, a request for any other
 * path is refused by the CLI itself, never attempted or silently dropped. The
 * hint below states that scope before a message is sent, naming the real
 * active project path from `state` when one resolves — and, when Bypass mode
 * (composer-modes-ui) is the current selection, says so plainly too: Bypass
 * skips the approval prompts that normally enforce this refusal.
 *
 * MODE / EFFORT / MODEL / AUTO-PLAN (composer-modes-ui, forge-2026-07-29-cc-finish;
 * feat-model-picker adds Model): the send-mode SegmentedControl widens from the original
 * Execute|Plan pair to the full set Claude Code's own `--permission-mode` picker offers (Execute,
 * Plan, Accept edits, Bypass — `ChatSendMode`), alongside a compact Effort picker
 * (Default/Low/Medium/High/Extra high/Max — `ChatSendEffort`) and a compact Model picker
 * (Default/Opus/Fable/Sonnet/Haiku — `ChatSendModel`, mirrors `gateway/src/server.mjs`'s
 * `EXEC_MODEL_VALUES` full-id allowlist), all three reusing this file's own `MenuButton` popover
 * pattern with a labelled trigger instead of an icon-only one. All three choices, plus Auto-plan
 * (below), persist per browser/project in localStorage — see
 * `readStoredMode`/`readStoredEffort`/`readStoredModel`/`readStoredAutoPlan`/`persist` (`effort` is
 * global per browser; `mode`/`model` are scoped per project — see `mode-storage.ts`'s own doc
 * comments for why, including feat-forge-preamble's new Bypass-by-default for a brand-new
 * project).
 *
 * AUTO-PLAN — 3 STAGES, NOT 2 (feat-forge-preamble correction, 2026-07-30-cc-finish): a real,
 * independently-measured finding proved plan mode cannot call ANY external tool at all, ask_owner
 * included — the OLD two-stage design (force the very first turn into plan mode) silently made
 * that first turn unable to ask a single clarifying question, recreating the exact "questions
 * printed as chat text" dead end the owner does not want. So:
 *   Stage 1 — INTAKE: the message the owner actually typed is sent in whatever mode is genuinely
 *     selected (`sendMode` — never forced to `'plan'` anymore), so a turn that needs to ask
 *     something real via ask_owner still can.
 *   Stage 2 — PLAN: once that intake turn's real reply has genuinely arrived (never guessed —
 *     gated on `messages.length` growing by two AND `streaming` going false), an effect below
 *     AUTOMATICALLY sends a second real turn (`AUTO_PLAN_FOLLOWUP_MESSAGE`), always in `'plan'`
 *     mode, asking for the actual plan now that any open questions are answered.
 *   Stage 3 — EXECUTE: once THAT plan turn's own real reply arrives, the existing "Voer dit plan
 *     uit" button appears and sends a third real turn (`RUN_PLAN_MESSAGE`) in whatever
 *     mode/effort/model is CURRENTLY selected at click time.
 * Three real turns through the exact same `onSend` path as every other message — no simulated
 * turn anywhere in the chain. A manually selected Plan send (Auto-plan off) skips the intake stage
 * entirely — the owner explicitly chose Plan mode, so it goes straight from stage 2 to stage 3
 * once its own reply lands; the composer's own plan-mode hint paragraph (below) makes plan mode's
 * no-tools/no-questions limitation honest and visible right at the picker, so this is never a
 * surprise.
 *
 * refactor-chat-split (forge-2026-07-30-cc-finish) UPDATE — this file was 1228 lines, well past
 * this project's own 500-line-per-file guidance. Pure structural split, ZERO behavior change: the
 * generic popover trigger (`MenuButton`) moved to `menu-button.tsx`; the persisted send-mode/
 * effort/auto-plan storage helpers moved to `mode-storage.ts`; the Auto-plan/Effort/Send-mode
 * controls' own JSX moved to `mode-controls.tsx` (`ComposerModeControls`); the `@`-mention and
 * `/`-slash-command popovers' own JSX moved to `suggestion-panels.tsx`; the queued-message list's
 * own JSX moved to `queue-panel.tsx` (`ComposerQueuePanel`). Every piece of STATE these controls
 * display (`sendMode`/`effortChoice`/`autoPlan`/`mentionToken`/`slashQuery`/`queue`/`flushingId`)
 * stays right here — only presentational JSX and pure, project-agnostic logic moved out. The
 * Context/Skills menus, the attachment pipeline, and the send/queue/auto-plan behavior itself were
 * not named by this split and stay exactly where they were.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import {
  nextToastId,
  selectActiveProject,
  selectConversation,
  selectMessages,
  selectProject,
  usePrototype,
} from '@/prototype/state/prototype-store';
import type { PrototypeState } from '@/prototype/state/prototype-store';
import { Button, ExampleTag, Icon, IconButton, KeyHint, Machine } from '@/components/primitives';
import type { ChatSendEffort, ChatSendMode, ChatSendModel, ChatSendOutcome } from '@/prototype/state/chat-send';
import type { ChatMessage } from '@/prototype/types/prototype-types';
import {
  GATEWAY_ORIGIN,
  gwGet,
  pickArray,
  pickBool,
  pickNumber,
  pickRecord,
  pickString,
} from '@/prototype/state/gateway-client';
import { RUN_PLAN_MESSAGE, sendArgsFor } from './compose-args';
import {
  enqueueMessage,
  markQueuedMessageFailed,
  removeQueuedMessage,
  selectNextQueuedMessage,
} from './message-queue';
import type { QueuedMessage } from './message-queue';
import {
  activeMentionToken,
  applyMentionSelection,
  filterMentionEntries,
  useProjectFileMentions,
} from './mention-files';
import type { ActiveMentionToken, MentionFileEntry } from './mention-files';
import { ALL_SLASH_COMMANDS, activeSlashQuery, filterSlashCommands } from './slash-commands';
import type { SlashCommand, SlashCommandContext } from './slash-commands';
import { MenuButton } from './menu-button';
import type { MenuOption } from './menu-button';
import {
  AUTO_PLAN_STORAGE_KEY,
  EFFORT_STORAGE_KEY,
  modelStorageKey,
  modeStorageKey,
  persist,
  readStoredAutoPlan,
  readStoredEffort,
  readStoredMode,
  readStoredModel,
} from './mode-storage';
import type { EffortChoice, ModelChoice } from './mode-storage';
import { ComposerModeControls } from './mode-controls';
import { MentionSuggestions, SlashCommandSuggestions } from './suggestion-panels';
import { ComposerQueuePanel } from './queue-panel';

/**
 * feat-forge-preamble: Auto-plan's own real stage-2 message — sent automatically (no button click)
 * once the stage-1 INTAKE turn's real reply has landed, always in `'plan'` mode regardless of the
 * mode picker. Exported (this file already exports other non-component values, e.g.
 * `ComposerSendResult` — `allowConstantExport: true` in this project's eslint config permits it)
 * so a test can assert against the exact same string rather than a hand-duplicated copy.
 */
export const AUTO_PLAN_FOLLOWUP_MESSAGE =
  'Schrijf nu, op basis van het bovenstaande (inclusief eventuele antwoorden op je vragen), het volledige plan.';

/**
 * Appended to the owner's own text for stage 1 ONLY when Auto-plan is on, and shown verbatim in the
 * chat so it is never a hidden instruction.
 *
 * WHY (measured live, 2026-07-30): with Auto-plan on and a small clear request ("maak een bestand
 * notities.md met drie regels"), stage 1 ran in bypass and simply BUILT the file, after which stage 2
 * dutifully asked for a plan of work that was already finished. That makes the Auto-plan switch lie:
 * the owner turns it on precisely to see a plan BEFORE anything is built. Stage 1 is an intake turn,
 * so it must say so. Deliberately does NOT tell the session to ask questions it does not need — the
 * preamble's own "never ask something the project already answers" rule still governs; this only
 * forbids building during intake.
 */
export const AUTO_PLAN_INTAKE_SUFFIX =
  'LET OP — dit is de intake-stap van een auto-plan: bouw of wijzig nu nog NIETS. Stel eerst, via de '
  + 'ask_owner-tool, de vragen die je echt nodig hebt om dit goed te doen (heb je er geen nodig, zeg dat '
  + 'dan kort). Het plan en de uitvoering volgen daarna in aparte stappen.';

/** Stable empty reference — mirrors `ChatView.tsx`'s own `NO_MESSAGES` constant. */
const EMPTY_MESSAGES: readonly ChatMessage[] = [];
/** feat-composer-power: stable empty references for the two suggestion popovers below, so an
 *  inactive popover never recomputes a new empty array identity on every render. */
const EMPTY_MENTION_RESULTS: readonly MentionFileEntry[] = [];
const EMPTY_SLASH_RESULTS: readonly SlashCommand[] = [];

/**
 * feat-composer-power: `onSend`'s async verdict widens from a bare `boolean` to (optionally) the
 * full `ChatSendOutcome` — the message queue below needs the REAL refusal reason to show on a
 * failed flush, not just whether it was accepted. `boolean` stays a valid resolution too (the
 * fixture reveal path still returns it synchronously, and any existing Promise<boolean> caller
 * remains valid), so this is a pure widening: every pre-existing call site keeps compiling and
 * behaving exactly as before.
 */
export type ComposerSendResult = boolean | ChatSendOutcome;

export interface ComposerProps {
  /**
   * Hand the trimmed message to the caller. Returns whether it was accepted:
   * `true` (or a promise resolving `true`/an accepted `ChatSendOutcome`) clears the field, `false`
   * (or a refused outcome) keeps the draft. Fixtures return `true`; production returns the
   * bridge's real verdict.
   *
   * `mode` (fix-ui-clutter, item 7; widened composer-modes-ui): the send-mode
   * segmented choice next to Send — `'execute'` (the default) is never passed
   * for backward compatibility with any caller that ignores it; only a real
   * non-default selection is threaded through (see `sendArgsFor`).
   * `effort` (composer-modes-ui): the effort picker's choice, omitted entirely
   * when "Default" is selected — never guessed at, never a fabricated level.
   * `model` (feat-model-picker): the model picker's choice, omitted entirely
   * when "Default" is selected — same never-guessed convention one field over.
   */
  readonly onSend: (
    body: string,
    mode?: ChatSendMode,
    effort?: ChatSendEffort,
    model?: ChatSendModel,
  ) => boolean | Promise<ComposerSendResult>;
  readonly onStop: () => void;
  /** True while a reply is still revealing (fixtures) or a run is active (production). Swaps Send for Stop. */
  readonly streaming: boolean;
  readonly conversationTitle: string;
  /**
   * True on the connected production path. Turns off the "local example reply"
   * footer, which would be a false claim once Send reaches a real runtime.
   */
  readonly production?: boolean;
  /**
   * feat-composer-power: wired only where `ChatView.tsx` has a real "start a new conversation"
   * action for this composer instance — surfaces as the `/new` slash command. Omitted entirely
   * (never a disabled-but-visible entry) where there is nothing real for it to do yet.
   */
  readonly onNewChat?: () => void;
  /**
   * feat-composer-power: wired only where a real conversation exists to delete — surfaces as the
   * `/delete` slash command, opening the SAME confirm dialog the toolbar's Delete button opens.
   */
  readonly onRequestDelete?: () => void;
}

const CONTEXT_OPTIONS: readonly MenuOption[] = [
  { id: 'project', icon: 'FolderGit2', label: 'This project', detail: 'Name, type and health score' },
  { id: 'run', icon: 'Activity', label: 'Latest run', detail: 'Work packages and their status' },
  { id: 'files', icon: 'Files', label: 'Changed files', detail: 'The current changed-file list' },
  { id: 'tests', icon: 'FlaskConical', label: 'Quality gates', detail: 'The current gate results' },
];

/* --------------------------------------------------------- context builders */

/**
 * One real context block per source, built straight from `state.data` — already
 * real in production (`useGatewayDataset()`) and honestly fixture-labelled in
 * fixtures. Returns null when the source has nothing to add, so the caller can
 * show an honest "nothing to add" toast instead of prefixing an empty block.
 */
const CONTEXT_BUILDERS: Readonly<Record<string, (state: PrototypeState) => string | null>> = {
  project: (state) => {
    const project = selectProject(state, state.activeProjectId);
    if (!project) return null;
    const { health } = project;
    // fix-cert-rest (item 3): health.score is now `number | null` — '—' when this project has
    // never been measured, never a fabricated "null/100" in the composed chat context block.
    return (
      `Project: ${project.name} (${project.type})\n` +
      `Health: ${health.score ?? '—'}/100 · tests ${health.tests.passed} passed / ${health.tests.failed} failed / ` +
      `${health.tests.skipped} skipped · ${health.openTickets} open tickets · ${health.blockers} blockers`
    );
  },
  run: (state) => {
    const runs = state.data.runs.filter((run) => run.projectId === state.activeProjectId);
    if (runs.length === 0) return null;
    const latest = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    const packages = latest.workPackageIds
      .map((id) => state.data.workPackages.find((wp) => wp.id === id))
      .filter((wp): wp is NonNullable<typeof wp> => wp !== undefined);
    const lines = packages.map((wp) => `- ${wp.title}: ${wp.status}`);
    return [`Latest run: ${latest.goal} (${latest.status})`, ...lines].join('\n');
  },
  files: (state) => {
    const changed: string[] = [];
    const walk = (nodes: PrototypeState['data']['files']): void => {
      for (const node of nodes) {
        if (node.changed) changed.push(`${node.changed} ${node.path}`);
        if (node.children) walk(node.children);
      }
    };
    walk(state.data.files);
    if (changed.length === 0) return null;
    return ['Changed files:', ...changed.map((line) => `- ${line}`)].join('\n');
  },
  tests: (state) => {
    if (state.data.gates.length === 0) return null;
    const lines = state.data.gates.map((gate) => `- ${gate.name}: ${gate.status}`);
    return ['Quality gates:', ...lines].join('\n');
  },
};

/* ------------------------------------------------------------------ attachments */

/** One real uploaded file, as `POST /api/conversations/:id/attachments` reports it back. */
interface ComposerAttachment {
  readonly id: string;
  readonly fileName: string;
  readonly size: number;
  readonly isText: boolean;
  readonly textPreview: string | null;
  readonly textTruncated: boolean;
  readonly storedPath: string;
}

/** Defensive extraction of the gateway's real `attachment` record — mirrors this file's own
 *  `gwGet`/`pickString` convention rather than trusting the response shape blindly. */
function parseAttachment(record: Record<string, unknown>): ComposerAttachment | null {
  const id = pickString(record, ['id']);
  const fileName = pickString(record, ['fileName']);
  const storedPath = pickString(record, ['storedPath']);
  if (id === null || fileName === null || storedPath === null) return null;
  return {
    id,
    fileName,
    size: pickNumber(record, ['size']) ?? 0,
    isText: pickBool(record, ['isText']) ?? false,
    textPreview: pickString(record, ['textPreview']),
    textTruncated: pickBool(record, ['textTruncated']) ?? false,
    storedPath,
  };
}

/**
 * The real block one attachment contributes to the NEXT sent message — a text-like file's own
 * real content, inlined between clear markers (bounded at the gateway's own MAX_TEXT_INLINE_BYTES,
 * so the model reads a real, complete-or-honestly-truncated body, never a lie about completeness);
 * a binary file is referenced by its real, absolute stored path instead (see this file's own
 * header + this WP's forge-report for the named handoff on exposing that path to the model).
 */
function attachmentBlock(attachment: ComposerAttachment): string {
  if (attachment.isText) {
    const truncNote = attachment.textTruncated ? '\n[attachment truncated in this preview — the full file was still uploaded]' : '';
    return (
      `--- Attachment: ${attachment.fileName} (${attachment.size} bytes) ---\n` +
      `${attachment.textPreview ?? ''}${truncNote}\n` +
      `--- End attachment: ${attachment.fileName} ---`
    );
  }
  return `Attachment: ${attachment.fileName} (${attachment.size} bytes, binary) — stored at ${attachment.storedPath}`;
}

/* ------------------------------------------------------------------ composer */

export function Composer({
  onSend,
  onStop,
  streaming,
  conversationTitle,
  production = false,
  onNewChat,
  onRequestDelete,
}: ComposerProps) {
  const { state, dispatch } = usePrototype();
  // Same project a real send actually targets (`chat-send.ts`'s `resolveProjectId`
  // reads this same `state.activeProjectId`) — used only to name the real write
  // scope in the hint below, never fetched or guessed separately.
  const activeProject = selectActiveProject(state);
  // composer-modes-ui: always the LATEST `state`, readable from inside a callback created on an
  // earlier render (the stale-closure fix `submit` below needs to find the real, possibly
  // just-created conversation id once an auto-plan send's promise settles).
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });
  const [value, setValue] = useState('');
  // The project id `skillOptions` was fetched for, or null before the first
  // fetch. A project switch invalidates the cache — adjusted during render
  // (React's documented pattern for "reset state when a prop changes") rather
  // than from an effect, so it never cascades an extra render.
  const [skillsProjectId, setSkillsProjectId] = useState<string | null>(null);
  const [skillOptions, setSkillOptions] = useState<readonly MenuOption[]>([]);
  if (skillsProjectId !== null && skillsProjectId !== state.activeProjectId) {
    setSkillsProjectId(null);
    setSkillOptions([]);
  }
  const skillsLoaded = skillsProjectId === state.activeProjectId && state.activeProjectId !== '';
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // build-lastdemos: real uploaded files awaiting the next Send. A conversation must already
  // exist for there to be somewhere to upload to (POST /api/conversations/:id/attachments is
  // scoped by conversation id) — before that, Attach stays disabled with an honest title.
  const [attachments, setAttachments] = useState<readonly ComposerAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const canAttach = state.activeConversationId !== '';

  // feat-composer-power: messages typed/sent while a run is already active in this conversation.
  // The gateway's own busy check would refuse a second concurrent send with a real 409 — rather
  // than attempt (and fail) that request, `submit()` below queues it instead, and the flush effect
  // sends it for real, through the exact same `onSend` path as every other message, the moment
  // `streaming` goes false. See `message-queue.ts`'s own header for the full honesty rules.
  const [queue, setQueue] = useState<readonly QueuedMessage[]>([]);
  const [flushingId, setFlushingId] = useState<string | null>(null);

  // feat-composer-power: `@`-mention file autocomplete + `/`-slash command menu. Both are derived
  // from the field's own value/caret on every keystroke (see `handleFieldChange` below) — at most
  // one is ever active at a time, since both are anchored to "the token containing the caret".
  const [mentionToken, setMentionToken] = useState<ActiveMentionToken | null>(null);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const { state: mentionState, ensureLoaded: ensureMentionsLoaded } = useProjectFileMentions(state.activeProjectId);

  // composer-modes-ui: the send-mode/effort/auto-plan choices, seeded from localStorage once at
  // mount and persisted on every change (see `mode-storage.ts`). 'execute' + no
  // effort chosen never changes the sent request body (see `sendArgsFor`); only a real non-default
  // pick does. fix-sec-round #2: `sendMode` is scoped to the project it was seeded for
  // (`modeProjectId`) — a project switch re-seeds it from THAT project's own stored choice (or
  // 'execute' when it has none) via the same "adjust state when a prop changes" render-time
  // pattern this file already uses for `skillsProjectId`/`skillOptions` above, rather than an
  // effect (React's documented preference — see this file's own precedent just above).
  // feat-model-picker: `modelChoice` re-seeds in the SAME block for the SAME reason (per-project,
  // never bleeding a heavier/pricier model choice into an unrelated project — see
  // `mode-storage.ts`'s own `MODEL_STORAGE_PREFIX` comment) — it reuses `modeProjectId` as the
  // shared "which project were the per-project choices seeded for" tracker rather than adding a
  // second, redundant one.
  const [modeProjectId, setModeProjectId] = useState<string>(() => state.activeProjectId);
  const [sendMode, setSendModeState] = useState<ChatSendMode>(() => readStoredMode(state.activeProjectId));
  const [modelChoice, setModelChoiceState] = useState<ModelChoice>(() => readStoredModel(state.activeProjectId));
  if (modeProjectId !== state.activeProjectId) {
    setModeProjectId(state.activeProjectId);
    setSendModeState(readStoredMode(state.activeProjectId));
    setModelChoiceState(readStoredModel(state.activeProjectId));
  }
  const [effortChoice, setEffortChoiceState] = useState<EffortChoice>(() => readStoredEffort());
  const [autoPlan, setAutoPlanState] = useState<boolean>(() => readStoredAutoPlan());
  const effort = effortChoice === 'default' ? undefined : effortChoice;
  const model = modelChoice === 'default' ? undefined : modelChoice;

  const setSendMode = useCallback(
    (next: ChatSendMode) => {
      setSendModeState(next);
      // An unknown/empty project has nowhere honest to persist a per-project choice — the picker
      // still responds for this render, it just does not survive a remount until a real project
      // is active (see `readStoredMode`'s own empty-id short-circuit).
      if (state.activeProjectId !== '') persist(modeStorageKey(state.activeProjectId), next);
    },
    [state.activeProjectId],
  );
  const setEffortChoice = useCallback((next: EffortChoice) => {
    setEffortChoiceState(next);
    persist(EFFORT_STORAGE_KEY, next);
  }, []);
  const setModelChoice = useCallback(
    (next: ModelChoice) => {
      setModelChoiceState(next);
      if (state.activeProjectId !== '') persist(modelStorageKey(state.activeProjectId), next);
    },
    [state.activeProjectId],
  );
  const setAutoPlan = useCallback((next: boolean) => {
    setAutoPlanState(next);
    persist(AUTO_PLAN_STORAGE_KEY, next ? '1' : '0');
  }, []);

  // composer-modes-ui: the active conversation's REAL messages (already real in production —
  // `state.data` is fed from `useGatewayDataset()`, see this file's header) — read only to detect
  // whether a genuine plan reply has arrived for the auto-plan flow below. Never fetched
  // separately; this is the same `state.data` every other selector in this file already reads.
  const conversation = selectConversation(state, state.activeConversationId);
  const messages: readonly ChatMessage[] = conversation ? selectMessages(state, conversation.id) : EMPTY_MESSAGES;

  // Stage 2->3 (PLAN reply -> "Voer dit plan uit"): the PLAN turn this composer is currently
  // waiting on a real reply for, or null when there is none in flight. `countAtSend` is the real
  // message count at the moment that plan turn was sent — its reply is "in" once at least two new
  // messages (the plan-request turn, then the assistant's real reply) have genuinely landed AND
  // the run is no longer active (`streaming` is this composer's own real signal for that, already
  // threaded in from `ChatView`/the live run — never a timer guess).
  const [pendingAutoPlan, setPendingAutoPlan] = useState<{ conversationId: string; countAtSend: number } | null>(
    null,
  );
  // Stage 1->2 (INTAKE reply -> automatic PLAN turn): same shape as `pendingAutoPlan` above, one
  // stage earlier — set only when Auto-plan is on (a manually selected Plan send has no intake
  // stage at all, see this file's own header). The effect below watches this and fires the real
  // PLAN turn itself, with no button click, the moment the intake reply genuinely lands.
  const [pendingAutoPlanIntake, setPendingAutoPlanIntake] = useState<{ conversationId: string; countAtSend: number } | null>(
    null,
  );
  const planReady =
    pendingAutoPlan !== null &&
    pendingAutoPlan.conversationId === state.activeConversationId &&
    !streaming &&
    messages.length >= pendingAutoPlan.countAtSend + 2 &&
    messages[messages.length - 1]?.author !== 'user';

  // feat-forge-preamble correction: the mode the NEXT send will actually run in. Auto-plan no
  // longer forces this to 'plan' (see this file's own header for why forcing it would silently
  // break the intake stage's whole purpose — plan mode cannot call ask_owner at all) — it is
  // simply whatever the mode picker currently has selected. Kept as its own named variable since
  // the write-scope hint below (and the queue-enqueue call) already reference `effectiveMode`
  // rather than `sendMode` directly.
  const effectiveMode: ChatSendMode = sendMode;

  const toast = useCallback(
    (title: string, detail?: string, icon?: string) => {
      dispatch({ type: 'toast/push', toast: { id: nextToastId(), title, detail, icon } });
    },
    [dispatch],
  );

  /** Prefixes a real block onto the current draft and refocuses the field. */
  const insertBlock = useCallback((block: string) => {
    setValue((current) => (current.trim().length > 0 ? `${block}\n\n${current}` : `${block}\n\n`));
    fieldRef.current?.focus();
  }, []);

  /**
   * Fetches this project's real skills the first time the Skills menu opens —
   * never eagerly on mount, so simply rendering the composer touches no network.
   */
  const loadSkills = useCallback(() => {
    if (skillsLoaded || state.activeProjectId === '') return;
    setSkillsProjectId(state.activeProjectId);
    void gwGet(`/api/skills?project=${encodeURIComponent(state.activeProjectId)}`).then((result) => {
      if (!result.ok) {
        setSkillOptions([]);
        return;
      }
      const rows = pickArray(result.data, ['skills']);
      setSkillOptions(
        rows.map((row) => {
          const slug = pickString(row, ['slug']) ?? '';
          // fix-ui-clutter (item 5): an empty description omits `detail` entirely rather than
          // substituting the flat "No description recorded." placeholder — see `MenuOption`'s
          // own doc comment.
          const description = pickString(row, ['description']);
          return {
            id: slug,
            icon: 'Sparkles',
            label: pickString(row, ['name']) ?? (slug || 'skill'),
            detail: description ?? undefined,
          };
        }),
      );
    });
  }, [skillsLoaded, state.activeProjectId]);

  /**
   * Uploads the chosen file to the real gateway route and, on success, adds it as a chip. Never
   * throws — a network failure or a gateway-reported error surfaces as a toast, exactly like every
   * other real gateway call in this component.
   */
  const handleFileSelected = useCallback(
    async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
      const file = event.target.files?.[0] ?? null;
      event.target.value = ''; // allow re-selecting the same file again later
      if (!file || state.activeConversationId === '') return;
      setUploading(true);
      try {
        const formData = new FormData();
        formData.append('file', file);
        const res = await globalThis.fetch(
          `${GATEWAY_ORIGIN}/api/conversations/${encodeURIComponent(state.activeConversationId)}/attachments`,
          { method: 'POST', body: formData },
        );
        const body: unknown = await res.json().catch(() => null);
        if (!res.ok) {
          const message = pickString(body, ['error']) ?? `HTTP ${res.status}`;
          toast('Attachment failed', message, 'TriangleAlert');
          return;
        }
        const record = pickRecord(body, ['attachment']);
        const attachment = record ? parseAttachment(record) : null;
        if (!attachment) {
          toast('Attachment failed', 'The gateway did not return a usable attachment record.', 'TriangleAlert');
          return;
        }
        setAttachments((current) => [...current, attachment]);
      } catch (err) {
        toast('Attachment failed', err instanceof Error ? err.message : String(err), 'TriangleAlert');
      } finally {
        setUploading(false);
      }
    },
    [state.activeConversationId, toast],
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((current) => current.filter((a) => a.id !== id));
  }, []);

  // Auto-grow: measure from scratch, then let max-block-size in the stylesheet
  // stop it and hand over to the field's own scrollbar.
  useEffect(() => {
    const element = fieldRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
  }, [value]);

  /**
   * feat-composer-power: the queue's flush loop. Whenever no run is active in THIS conversation
   * and no flush is already in flight, picks the oldest still-eligible queued message (see
   * `selectNextQueuedMessage`'s own doc comment — an item with a real recorded error is skipped,
   * never auto-retried) and sends it through the exact same `onSend` path a manual Send uses. One
   * item at a time: `flushingId` blocks a second concurrent attempt until this one's real verdict
   * (sync boolean or resolved Promise) comes back, at which point the effect re-runs (its own
   * `queue`/`flushingId` dependencies changed) and either removes the now-accepted item or marks
   * the real refusal reason on it — never both, and never silently dropped either way.
   */
  useEffect(() => {
    if (streaming || flushingId !== null) return;
    const next = selectNextQueuedMessage(queue, state.activeConversationId);
    if (next === null) return;

    // The state updates below live inside this nested async function (mirrors
    // `gateway-chat.ts`'s own established `async function check() {...}` + `void check();` shape
    // for the identical "an effect kicks off one async attempt, then records its real outcome"
    // pattern) rather than directly in the effect body.
    async function attemptFlush(item: QueuedMessage): Promise<void> {
      setFlushingId(item.id);
      const result = onSend(
        ...(sendArgsFor(item.body, item.mode, item.effort, item.model) as readonly [string, ChatSendMode?, ChatSendEffort?, ChatSendModel?]),
      );
      const outcome: ComposerSendResult = typeof result === 'boolean' ? result : await result;
      const accepted = typeof outcome === 'boolean' ? outcome : outcome.ok;
      const error = typeof outcome === 'boolean' ? null : outcome.error;
      setFlushingId(null);
      if (accepted) {
        setQueue((current) => removeQueuedMessage(current, item.id));
      } else {
        setQueue((current) => markQueuedMessageFailed(current, item.id, error ?? 'The message was not accepted.'));
      }
    }
    void attemptFlush(next);
  }, [streaming, flushingId, queue, state.activeConversationId, onSend]);

  /**
   * feat-forge-preamble: Auto-plan's stage 1->2 transition. Mirrors the queue-flush effect's own
   * "state updates live inside a nested async function" idiom directly above — the real trigger
   * (`onSend`) always eventually resolves to `true`/`false`/a `ChatSendOutcome`; the nested
   * function keeps that resolution out of the effect body itself so no direct `setState` call ever
   * sits in the effect's own top-level body.
   */
  useEffect(() => {
    if (streaming || pendingAutoPlanIntake === null) return;
    if (pendingAutoPlanIntake.conversationId !== state.activeConversationId) return;
    if (messages.length < pendingAutoPlanIntake.countAtSend + 2) return;
    if (messages[messages.length - 1]?.author === 'user') return;

    async function fireAutoPlanFollowUp(intake: { conversationId: string; countAtSend: number }): Promise<void> {
      setPendingAutoPlanIntake(null);
      const result = onSend(
        ...(sendArgsFor(AUTO_PLAN_FOLLOWUP_MESSAGE, 'plan', effort, model) as readonly [string, ChatSendMode?, ChatSendEffort?, ChatSendModel?]),
      );
      const outcome: ComposerSendResult = typeof result === 'boolean' ? result : await result;
      const accepted = typeof outcome === 'boolean' ? outcome : outcome.ok;
      if (accepted) {
        setPendingAutoPlan({ conversationId: intake.conversationId, countAtSend: messages.length });
      } else {
        toast('Plan not started', 'The automatic follow-up plan turn was not accepted.', 'TriangleAlert');
      }
    }
    void fireAutoPlanFollowUp(pendingAutoPlanIntake);
  }, [streaming, pendingAutoPlanIntake, messages, state.activeConversationId, onSend, effort, model, toast]);

  const submit = useCallback(() => {
    const trimmed = value.trim();
    if (trimmed === '' && attachments.length === 0) return;
    // Every attached file's real content (text) or real stored path (binary) is prepended as its
    // own delimited block — this is what "really carries the attachment into the prompt" means
    // (see attachmentBlock's own header). The visible draft text always comes last.
    // With Auto-plan on, stage 1 is an INTAKE turn and must not build yet — see
    // AUTO_PLAN_INTAKE_SUFFIX's own header for the live measurement that forced this. The suffix is
    // part of the visible message body, so the owner reads exactly what was sent.
    const body = [
      ...attachments.map(attachmentBlock),
      trimmed,
      ...(autoPlan ? [AUTO_PLAN_INTAKE_SUFFIX] : []),
    ]
      .filter((part) => part.length > 0)
      .join('\n\n');

    if (streaming) {
      // feat-composer-power: a run is already active in this conversation — the gateway would
      // 409 a second send right now, so this queues the message instead of attempting (and
      // failing) it. Mode/effort/model are frozen to what is selected AT THIS MOMENT
      // (`effectiveMode`/`effort`/`model`, computed above), never re-read from the picker later
      // when the queue actually flushes.
      setQueue((current) =>
        enqueueMessage(current, { conversationId: state.activeConversationId, body, mode: effectiveMode, effort, model }),
      );
      setValue('');
      setAttachments([]);
      return;
    }
    // A fresh manual send always supersedes any earlier auto-plan proposal still being tracked —
    // the "Run this plan" banner (if showing) disappears immediately rather than pointing at a
    // reply that is no longer the latest thing the user asked for. Both stages are cleared: a
    // fresh send restarts the whole 3-stage flow from scratch.
    setPendingAutoPlan(null);
    setPendingAutoPlanIntake(null);
    // `effectiveMode` is computed once above (component render scope) so the hint text and this
    // send always agree on what is about to happen — see this file's own header for why it no
    // longer differs from `sendMode` at all.
    const conversationIdAtSend = state.activeConversationId;
    const countAtSend = messages.length;
    // fix-ui-clutter (item 7; widened composer-modes-ui): 'execute'/no-effort (the defaults) are
    // never passed — see `onSend`'s own doc comment and `sendArgsFor` for why a bare default send
    // stays byte-identical to before this mode/effort picker existed. feat-model-picker: "Default"
    // (no model chosen) follows the exact same never-passed convention.
    const result = onSend(
      ...(sendArgsFor(body, effectiveMode, effort, model) as readonly [string, ChatSendMode?, ChatSendEffort?, ChatSendModel?]),
    );

    const onAccepted = () => {
      // The freshest known conversation id: a brand-new conversation's real id is only known once
      // `onSend` has already dispatched `conversation/activate` (chat-send.ts/gateway-chat.ts, both
      // synchronous before this promise settles) — `stateRef` avoids the stale-closure trap of
      // reading `state` as it was when `submit` was created.
      const conversationId = stateRef.current.activeConversationId || conversationIdAtSend;
      if (autoPlan) {
        // 3-stage auto-plan flow (feat-forge-preamble correction): this turn was stage 1, INTAKE —
        // it deliberately ran in whatever tool-capable mode was actually selected (never forced to
        // 'plan'), because plan mode in this environment can never call ask_owner at all. The
        // effect above fires the real PLAN turn (stage 2) automatically once this reply lands.
        setPendingAutoPlanIntake({ conversationId, countAtSend });
        return;
      }
      // A manually selected Plan mode turn (Auto-plan off) skips the intake stage entirely — the
      // owner chose Plan mode directly, and the composer's own plan-mode hint already told them
      // tools/questions are not available there. Once this turn's real reply lands, "Voer dit plan
      // uit" (stage 3) is offered directly.
      if (effectiveMode !== 'plan') return;
      setPendingAutoPlan({ conversationId, countAtSend });
    };

    if (typeof result === 'boolean') {
      // Synchronous verdict (the fixture reveal always accepts).
      if (result) {
        setValue('');
        setAttachments([]);
        onAccepted();
      }
      return;
    }
    // Asynchronous verdict (a real bridge round trip). Keep the draft AND the attachment chips on
    // screen until the send is actually accepted, so a refusal never loses either and never reads
    // as though the message went out. Only clear if the field still holds exactly what was
    // submitted, so a fast retype is not wiped.
    void result.then((outcome) => {
      const accepted = typeof outcome === 'boolean' ? outcome : outcome.ok;
      if (!accepted) return;
      setValue((current) => (current === trimmed ? '' : current));
      setAttachments([]);
      onAccepted();
    });
  }, [onSend, value, attachments, effectiveMode, effort, model, autoPlan, state.activeConversationId, messages.length, streaming]);

  /**
   * composer-modes-ui: the real, second turn of the auto-plan flow. Sends `RUN_PLAN_MESSAGE` in
   * whatever mode/effort/model is CURRENTLY selected (read fresh at click time, not captured when
   * the plan turn was sent) through the exact same `onSend` path as every other message — a real
   * turn, never a simulated one.
   */
  const runProposedPlan = useCallback(() => {
    setPendingAutoPlan(null);
    const result = onSend(
      ...(sendArgsFor(RUN_PLAN_MESSAGE, sendMode, effort, model) as readonly [string, ChatSendMode?, ChatSendEffort?, ChatSendModel?]),
    );
    const reportIfRefused = (outcome: ComposerSendResult) => {
      const accepted = typeof outcome === 'boolean' ? outcome : outcome.ok;
      if (!accepted) toast('Plan not started', 'The follow-up turn was not accepted.', 'TriangleAlert');
    };
    if (typeof result === 'boolean') {
      reportIfRefused(result);
      return;
    }
    void result.then(reportIfRefused);
  }, [onSend, sendMode, effort, model, toast]);

  // feat-composer-power: the real, bounded suggestion list for the CURRENT `@`-token, or the
  // stable empty reference when no mention is active.
  const mentionResults = mentionToken !== null ? filterMentionEntries(mentionState.entries, mentionToken.query) : EMPTY_MENTION_RESULTS;

  // feat-composer-power: the slash-command context — recomputed only when one of its own real
  // inputs changes (never a stale snapshot: `setSendMode`/`setEffortChoice`/`setAutoPlan` are
  // themselves already-memoized setters, and `autoPlan`/`onNewChat`/`onRequestDelete` are listed
  // directly), so `chooseSlashCommand` below does not recreate on every unrelated render.
  const slashContext: SlashCommandContext = useMemo(
    () => ({ autoPlan, setSendMode, setEffortChoice, setAutoPlan, onNewChat, onRequestDelete }),
    [autoPlan, setSendMode, setEffortChoice, setAutoPlan, onNewChat, onRequestDelete],
  );
  const slashResults = slashQuery !== null ? filterSlashCommands(ALL_SLASH_COMMANDS, slashQuery, slashContext) : EMPTY_SLASH_RESULTS;

  /** Re-derives the active `@mention`/`/command` token from the field's own live value + caret on
   *  every keystroke — self-closing: once the token that opened a popover no longer matches (a
   *  space was typed, the leading `/`/`@` was deleted, …) the corresponding state simply reads
   *  back null and the popover disappears with no separate "close" step needed. */
  const handleFieldChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    const nextValue = event.target.value;
    setValue(nextValue);
    const caret = event.target.selectionStart ?? nextValue.length;
    const mention = activeMentionToken(nextValue, caret);
    setMentionToken(mention);
    if (mention !== null) ensureMentionsLoaded();
    setSlashQuery(activeSlashQuery(nextValue, caret));
  }, [ensureMentionsLoaded]);

  /** Replaces the active `@token` with the chosen file's real, readable path and refocuses the
   *  field with the caret placed right after it. */
  const chooseMention = useCallback(
    (entry: MentionFileEntry) => {
      if (mentionToken === null) return;
      const applied = applyMentionSelection(value, mentionToken, entry.path);
      setValue(applied.value);
      setMentionToken(null);
      const field = fieldRef.current;
      requestAnimationFrame(() => {
        field?.focus();
        field?.setSelectionRange(applied.caret, applied.caret);
      });
    },
    [mentionToken, value],
  );

  /** Runs the real command against the current context, then clears the typed `/command` text —
   *  see `slash-commands.ts`'s own header for why: a command that only sets state must not leave
   *  its trigger text sitting in the draft as though it were about to be sent as a chat message. */
  const chooseSlashCommand = useCallback(
    (command: SlashCommand) => {
      command.run(slashContext);
      setValue('');
      setSlashQuery(null);
      fieldRef.current?.focus();
    },
    [slashContext],
  );

  const closeSuggestions = useCallback(() => {
    setMentionToken(null);
    setSlashQuery(null);
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Escape' && (mentionToken !== null || slashQuery !== null)) {
        event.preventDefault();
        closeSuggestions();
        return;
      }
      if (event.key !== 'Enter' || event.shiftKey) return;
      if (event.nativeEvent.isComposing) return;
      // An open suggestion popover consumes Enter as "pick the top match" — the raw, unfinished
      // `@partial`/`/partial` text must never be sent as though it were the real message.
      if (mentionToken !== null && mentionResults.length > 0) {
        event.preventDefault();
        chooseMention(mentionResults[0]);
        return;
      }
      if (slashQuery !== null && slashResults.length > 0) {
        event.preventDefault();
        chooseSlashCommand(slashResults[0]);
        return;
      }
      event.preventDefault();
      submit();
    },
    [submit, mentionToken, mentionResults, slashQuery, slashResults, chooseMention, chooseSlashCommand, closeSuggestions],
  );

  const empty = value.trim() === '' && attachments.length === 0;

  return (
    <div className="fw-chat-composer">
      {planReady ? (
        <div className="fw-chat-composer__plan-banner" role="status">
          <Icon name="Workflow" size="sm" />
          <span>A plan was proposed above.</span>
          <span className="fw-spacer" aria-hidden="true" />
          <Button variant="primary" size="sm" icon="Play" onClick={runProposedPlan}>
            Voer dit plan uit
          </Button>
        </div>
      ) : null}

      <ComposerQueuePanel
        queue={queue}
        onRemove={(id) => setQueue((current) => removeQueuedMessage(current, id))}
      />

      <div className="fw-chat-composer__shell">
        {attachments.length > 0 ? (
          <ul className="fw-chat-composer__attachments" aria-label="Attached files">
            {attachments.map((attachment) => (
              <li key={attachment.id} className="fw-chat-composer__attachment">
                <Icon name={attachment.isText ? 'FileText' : 'Paperclip'} size="xs" />
                <Machine className="fw-chat-composer__attachment-name fw-truncate">
                  {attachment.fileName}
                </Machine>
                <IconButton
                  icon="X"
                  label={`Remove ${attachment.fileName}`}
                  size="sm"
                  onClick={() => removeAttachment(attachment.id)}
                />
              </li>
            ))}
          </ul>
        ) : null}

        <div className="fw-chat-composer__field-wrap">
          <textarea
            ref={fieldRef}
            className="fw-chat-composer__field"
            value={value}
            rows={1}
            placeholder="Describe what you want built. Enter sends, Shift+Enter starts a new line. Type @ to mention a file, / for commands."
            aria-label={`Message Forge in ${conversationTitle}`}
            onChange={handleFieldChange}
            onKeyDown={handleKeyDown}
          />

          <MentionSuggestions
            token={mentionToken}
            status={mentionState.status}
            results={mentionResults}
            hasActiveProject={state.activeProjectId !== ''}
            onChoose={chooseMention}
          />

          <SlashCommandSuggestions query={slashQuery} results={slashResults} onChoose={chooseSlashCommand} />
        </div>

        <div className="fw-chat-composer__row">
          <IconButton
            icon="Paperclip"
            label="Attach a file"
            title={
              canAttach
                ? 'Attach a file to this message'
                : 'Start the conversation with a first message before attaching a file'
            }
            size="sm"
            disabled={!canAttach || uploading}
            onClick={() => fileInputRef.current?.click()}
          />
          <input
            ref={fileInputRef}
            type="file"
            className="fw-visually-hidden"
            aria-hidden="true"
            tabIndex={-1}
            onChange={(event) => void handleFileSelected(event)}
          />
          <MenuButton
            icon="AtSign"
            label="Add context"
            title="Context"
            options={CONTEXT_OPTIONS}
            footer="Adds a real block from this project's current data to your draft."
            onPick={(option) => {
              const block = CONTEXT_BUILDERS[option.id]?.(state) ?? null;
              if (block === null) {
                toast('Nothing to add', `${option.label} has no data recorded yet in this project.`, 'AtSign');
                return;
              }
              insertBlock(block);
            }}
          />
          <MenuButton
            icon="Sparkles"
            label="Choose a skill"
            title="Skills"
            options={skillOptions}
            footer={
              skillsLoaded && skillOptions.length === 0
                ? 'No skills are registered for this project yet.'
                : 'Adds a real skill directive to your draft.'
            }
            onOpen={loadSkills}
            onPick={(option) => insertBlock(`Apply the "${option.label}" skill (${option.id}) to this request.`)}
          />

          <span className="fw-spacer" aria-hidden="true" />

          <ComposerModeControls
            autoPlan={autoPlan}
            onAutoPlanChange={setAutoPlan}
            effortChoice={effortChoice}
            onEffortChoiceChange={setEffortChoice}
            modelChoice={modelChoice}
            onModelChoiceChange={setModelChoice}
            sendMode={sendMode}
            onSendModeChange={setSendMode}
          />

          {streaming ? (
            <>
              {/* feat-composer-power: while a run is active, Send itself is replaced by Stop
                  (below, unchanged) — this is the real way to still submit a message: it queues
                  rather than attempts an immediate send the gateway would 409. Enter does the
                  same thing (see `submit`'s own streaming branch). */}
              <IconButton
                icon="Clock"
                label="Queue message"
                title="Queue this message — it sends for real once the current run finishes"
                size="sm"
                disabled={empty}
                onClick={submit}
              />
              <Button variant="danger" size="sm" icon="Square" onClick={onStop}>
                Stop
              </Button>
            </>
          ) : (
            <Button variant="primary" size="sm" icon="ArrowUp" disabled={empty} onClick={submit}>
              Send
            </Button>
          )}
        </div>
      </div>

      <p className="fw-chat-composer__hint">
        <KeyHint keys={['Enter']} /> <span>send</span>
        <span className="fw-chat-composer__hint-sep" aria-hidden="true">
          ·
        </span>
        <KeyHint keys={['Shift', 'Enter']} /> <span>new line</span>
        <span className="fw-spacer" aria-hidden="true" />
        {production ? (
          <span className="fw-chat-composer__live">
            Enter starts a real Claude Code session that can create or edit files only inside{' '}
            {activeProject ? <Machine muted>{activeProject.path}</Machine> : "this project's folder"} —
            a request for any other path is refused, not attempted
            {effectiveMode === 'bypass'
              ? '. Bypass mode is currently selected: it skips the approval prompts that would otherwise have refused a path outside this folder, so treat this run as having full write access on this machine.'
              : '.'}
          </span>
        ) : (
          <ExampleTag detail="Replies are local example text, revealed by a timer in this tab. Nothing is generated and nothing is sent." />
        )}
      </p>
      {production && effectiveMode === 'bypass' ? (
        <p className="fw-chat-composer__hint">
          <span>
            Bypass: voert uit zonder goedkeuringsvragen — nodig voor niet-interactieve dashboard-sessies.
          </span>
        </p>
      ) : null}
      {production && sendMode === 'plan' ? (
        <p className="fw-chat-composer__hint">
          <span>
            Plan-modus: alleen lezen en plannen — er is in plan-modus geen enkele tool beschikbaar
            (ook ask_owner niet), dus er kunnen dan geen vragen gesteld worden.
          </span>
        </p>
      ) : null}
    </div>
  );
}
