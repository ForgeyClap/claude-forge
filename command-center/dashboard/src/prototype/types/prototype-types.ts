/**
 * Forge Workspace — prototype type contract.
 *
 * Every record in the prototype data layer carries `prototype: true`. It is not
 * decoration: the runtime guard in `assertPrototype` and the unit tests both key
 * off it, so an example record can never be mistaken for a real Forge record.
 *
 * NOTHING in this file describes a real API. There is no server, no runtime and
 * no transport. These are the shapes of local example data only.
 */

/** Stamped on every example record. Real Forge records never carry this flag. */
export interface Prototyped {
  readonly prototype: true;
}

/* ------------------------------------------------------------------ status */

/**
 * The seven workspace states. Each maps to a `--forge-status-*` token trio
 * (value / style / width) so a state is legible in pure greyscale: the colour
 * only ever carries weight, never meaning.
 */
export type StatusKey =
  | 'running'
  | 'completed'
  | 'waiting'
  | 'verify'
  | 'review'
  | 'failed'
  | 'blocked'
  | 'idle';

export const STATUS_KEYS: readonly StatusKey[] = [
  'running',
  'completed',
  'waiting',
  'verify',
  'review',
  'failed',
  'blocked',
  'idle',
] as const;

/** Non-colour signals. Every status badge must render icon + label, never colour alone. */
export interface StatusPresentation {
  readonly key: StatusKey;
  /** Uppercase label shown next to the icon, e.g. "RUNNING". */
  readonly label: string;
  /** Lucide icon name resolved by the StatusBadge component. */
  readonly icon: string;
  /** True for states that animate (running only). Suppressed under reduced motion. */
  readonly animated: boolean;
  /** Short screen-reader sentence describing the state. */
  readonly description: string;
}

/* ------------------------------------------------------------------ agents */

/** The seven agent groups, mapped to `--forge-group-*` luminance steps. */
export type AgentGroup =
  | 'control'
  | 'context'
  | 'planning'
  | 'domain'
  | 'execution'
  | 'review'
  | 'memory';

export type PermissionLevel = 'read-only' | 'standard' | 'elevated' | 'lead';

export type EffortTier = 'low' | 'medium' | 'high' | 'max';

export interface Agent extends Prototyped {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly group: AgentGroup;
  readonly permission: PermissionLevel;
  readonly status: StatusKey;
  /** 0–100. Only meaningful while `status` is 'running'. */
  readonly progress: number;
  readonly currentTask: string | null;
  /** Example runtime model label. A display string, never a routing instruction. */
  readonly runtimeModel: string;
  /** Example NVIDIA tool-model label. Display only — nothing is ever called. */
  readonly toolModel: string;
  readonly effort: EffortTier;
  readonly skills: readonly string[];
  readonly lastActivity: string;
  /**
   * fix-cert-rest (F5/F6): `'not-required'` is a genuine CLAIM about the role — "this role
   * produces no claim the verify loop has to check" (see `AgentsView.tsx`'s own `VERIFICATION`
   * copy). No real Forge source this app reads (`GET /api/agents`, a mission's `check_passed`/
   * `check_failed` verdicts) reports any such role-level fact — only fixture/example data may
   * assert it. `null` is the separate, honest state for "no verification evidence exists for this
   * agent in this run" (real production absence, not a guess about the role) — views render it as
   * absent, never as a `'NOT REQUIRED'` claim.
   */
  readonly verification: 'verified' | 'pending' | 'rejected' | 'not-required' | null;
  readonly summary: string;
}

/* ---------------------------------------------------------------- projects */

export type ProjectType =
  | 'website'
  | 'full-stack'
  | 'automation'
  | 'chatbot'
  | 'scraping'
  | 'prediction'
  | 'integration'
  | 'research'
  /**
   * cc-wire-usage handoff-fix: the real, honest value for a project the gateway
   * cannot cleanly classify into one of the 8 named types above — a compound or
   * free-text profile description (this project's own real profile is "tooling
   * / meta — ... Mixed."), or no profile at all.
   *
   * Renders as the label `Unclassified` (and the CircleDashed "not determined" icon), never a
   * guess and never one of the 8 real type icons. An earlier version of this comment promised a
   * bare `—`; the views deliberately say `Unclassified` instead, because in a Type column a dash
   * says nothing while "Unclassified" says WHY there is nothing — the profile names no type Forge
   * recognises. Corrected here rather than left standing: a doc comment that promises behaviour
   * the code does not have is the same defect class as a button that lies, only aimed at the next
   * developer instead of the owner.
   * See `gateway-adapter.ts`'s `classifyProjectType` for the mapping rule.
   */
  | 'unknown';

export interface ProjectHealth {
  readonly tests: { readonly passed: number; readonly failed: number; readonly skipped: number };
  readonly openTickets: number;
  readonly blockers: number;
  /**
   * 0–100 composite score shown as a thin meter, never a coloured dial. `null` when this
   * project's health has never been measured (fix-cert-rest, item 3: widened from a
   * shared non-nullable `number` — a bare `0` could not be told apart from a genuinely
   * measured empty project). Views render `null` as `'—'`, never as a fabricated `0`.
   */
  readonly score: number | null;
  /**
   * fix-ui-clutter (forge-2026-07-29-cc-finish, item 6): whether `tests` above actually
   * reflects a real doctor/test-suite measurement right now — `parseDoctorHealth`'s own
   * `present` flag, carried through so a view can tell "genuinely 0 passed/0 failed" apart
   * from "no doctor verdict exists yet" (the exact F3-class gap this item closes: a fresh
   * project with no doctor run was rendering "0 passed · 0 failed · 0 skipped" as though it
   * had been measured and come back empty). `undefined` on every fixture/bridge record —
   * those already carry genuine counts by construction, so absence of this flag means
   * "trust `tests` as-is". An explicit `false` must render as absence ('—'), never as a
   * measured zero.
   */
  readonly testsMeasured?: boolean;
}

export interface Project extends Prototyped {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly type: ProjectType;
  readonly status: StatusKey;
  readonly lastActivity: string;
  /** Example local path. Cosmetic — the prototype never touches the file system. */
  readonly path: string;
  readonly templateVersion: string;
  readonly pinned: boolean;
  readonly conversationCount: number;
  readonly missionCount: number;
  /**
   * `null` when this project's task count has never been measured — every real gateway
   * project this workspace is not currently focused on (fix-cert-rest, item 3: widened from
   * a shared non-nullable `number`, see `ProjectHealth.score`'s own comment for why). Every
   * fixture/example `Project` still carries a real number for every row. Views render `null`
   * as `'—'`, never as a fabricated `0`.
   */
  readonly taskCount: number | null;
  readonly agentCount: number;
  readonly skills: readonly string[];
  readonly health: ProjectHealth;
  /**
   * fix-ui-clutter (item 6): the project directory's own real mtime in ms since epoch, read
   * server-side by the gateway (`dir_mtime_ms` on `GET /api/projects` rows) so a freshly
   * created project can be ranked as "recent" before it has any conversation/run activity of
   * its own to sort by. Optional — every fixture/bridge record omits it (`undefined`), which
   * a sort must treat as "no real recency signal", never as the oldest possible time. `null`
   * is the gateway's own honest "not available" reading for a row it could not stat.
   */
  readonly dirMtimeMs?: number | null;
}

/* ----------------------------------------------------------- conversations */

export type MessageAuthor = 'user' | 'forge';

/** A collapsible progress block rendered inside a Forge response. */
export interface MessageStep {
  readonly id: string;
  readonly label: string;
  readonly status: StatusKey;
  readonly detail: string;
  readonly agent?: string;
}

export interface Attachment {
  readonly id: string;
  readonly name: string;
  readonly kind: 'image' | 'markdown' | 'code' | 'log' | 'archive';
  readonly size: string;
}

export interface ChatMessage extends Prototyped {
  readonly id: string;
  readonly author: MessageAuthor;
  /** Markdown. Rendered by the prototype's small internal renderer. */
  readonly body: string;
  readonly timestamp: string;
  readonly attachments?: readonly Attachment[];
  readonly steps?: readonly MessageStep[];
  /** Example model label shown under a Forge response. */
  readonly model?: string;
  readonly skills?: readonly string[];
  readonly edited?: boolean;
}

export interface Conversation extends Prototyped {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly messageCount: number;
  readonly messages: readonly ChatMessage[];
}

/* --------------------------------------------------- work packages & tasks */

export type TaskPhase = 'intake' | 'plan' | 'build' | 'verify' | 'review' | 'handoff';

export type TaskColumn =
  | 'backlog'
  | 'planned'
  | 'running'
  | 'self-review'
  | 'verify'
  | 'review'
  | 'blocked'
  | 'completed';

export const TASK_COLUMNS: readonly TaskColumn[] = [
  'backlog',
  'planned',
  'running',
  'self-review',
  'verify',
  'review',
  'blocked',
  'completed',
] as const;

export interface Task extends Prototyped {
  readonly id: string;
  readonly title: string;
  readonly agentId: string;
  readonly workPackageId: string;
  readonly phase: TaskPhase;
  readonly column: TaskColumn;
  readonly status: StatusKey;
  readonly progress: number;
  readonly dependencies: readonly string[];
  readonly proofCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly repairAttempts: number;
  readonly detail: string;
  /**
   * cc-wire-usage handoff-fix: how confidently the gateway's `guessWp()` matched
   * this task to `workPackageId` — real values are `'explicit'`/`'inferred'`/etc,
   * whatever `missions.mjs` itself reports; `null` when the gateway did not send
   * one (an orphan-completion row, or an older gateway build). Optional so this
   * addition never breaks an existing fixture/bridge `Task` literal that has no
   * slot for it. ALWAYS an explicitly-labelled confidence signal where rendered
   * — never presented as a certainty.
   */
  readonly wpGuessConfidence?: string | null;
  /**
   * Z1 pairing ambiguity — the gateway's own refusal to guess, carried the last hop.
   *
   * `missions.mjs` will not pair a completion when more than one still-open start shares its
   * exact (agent, role): the identity of the finisher is genuinely unknowable there, and guessing
   * could stamp 'completed' on the dispatch that is really still running. `true` means at least
   * one real completion could NOT be assigned to this task, so `status` is honestly
   * UNDER-reported — what is shown is never MORE finished than the evidence supports.
   *
   * `parseMissionPayload` already carried these onto `MissionTaskRow`, but `toGatewayTask` used
   * to drop them, so the warning could not reach the object components render — the truth existed
   * and was unreachable. These four fields close that last hop.
   *
   * All four are optional so this addition breaks no existing fixture/bridge `Task` literal, and
   * `undefined` (a `Task` from a source that has no pairing concept, e.g. a chat-run todo) is a
   * different, honest thing from a measured `false`. Pure data: nothing here changes `status`,
   * `column`, `phase` or `progress`. Display is a named handoff — no view file was in this
   * round's write scope.
   */
  readonly pairingAmbiguous?: boolean;
  /** Why the pairing was refused (how many open starts shared the key, how many completions were
   *  declined) — `null` when there is no ambiguity to explain. */
  readonly pairingAmbiguityReason?: string | null;
  /** How many real completions this task's key had to refuse. `null` when the gateway did not
   *  report it — never coerced to `0`, which would read as a measured "none". */
  readonly declinedCompletions?: number | null;
  /** Only on a `Task` built from an `orphanCompletions` row: why that completion was left
   *  unmatched. `null` on an ordinary task. */
  readonly unmatchedReason?: string | null;
}

export interface WorkPackage extends Prototyped {
  readonly id: string;
  readonly title: string;
  readonly goal: string;
  readonly status: StatusKey;
  readonly ownerAgentId: string;
  readonly phase: TaskPhase;
  readonly taskIds: readonly string[];
  readonly acceptance: readonly string[];
}

/* -------------------------------------------------------------------- runs */

export interface Run extends Prototyped {
  readonly id: string;
  readonly projectId: string;
  readonly goal: string;
  readonly status: StatusKey;
  readonly startedAt: string;
  readonly duration: string;
  readonly workPackageIds: readonly string[];
  readonly agentIds: readonly string[];
}

/* ------------------------------------------------------------ mission graph */

export type GraphNodeKind =
  | 'request'
  | 'boss'
  | 'head-chef'
  | 'lane-agent'
  | 'step'
  | 'verify'
  | 'review'
  | 'fix'
  | 'output';

export interface GraphNode extends Prototyped {
  readonly id: string;
  readonly label: string;
  readonly kind: GraphNodeKind;
  readonly status: StatusKey;
  /** Grid column index, left to right. Layout is computed from this, not hand-placed. */
  readonly col: number;
  /** Row within the column. Parallel lanes stack by row. */
  readonly row: number;
  readonly laneId: string | null;
  readonly agent?: string;
  readonly duration?: string;
  readonly model?: string;
  readonly skills?: readonly string[];
  readonly detail?: string;
}

export interface GraphEdge extends Prototyped {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  /** 'feedback' edges route backwards (review → head chef) and render dashed. */
  readonly kind: 'flow' | 'feedback' | 'dependency';
  readonly label?: string;
}

export interface GraphLane extends Prototyped {
  readonly id: string;
  readonly label: string;
  readonly group: AgentGroup;
}

export interface MissionGraph extends Prototyped {
  readonly id: string;
  readonly runId: string;
  readonly lanes: readonly GraphLane[];
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

/* --------------------------------------------------------------- artifacts */

export type ArtifactKind =
  | 'screenshot'
  | 'report'
  | 'diagram'
  | 'markdown'
  | 'log'
  | 'receipt'
  | 'proof';

export interface Artifact extends Prototyped {
  readonly id: string;
  readonly name: string;
  readonly kind: ArtifactKind;
  readonly producedBy: string;
  readonly taskId: string | null;
  readonly createdAt: string;
  readonly size: string;
  /** Example body. Markdown for documents, a caption for images. */
  readonly preview: string;
}

/* ------------------------------------------------------------------- files */

export interface FileNode extends Prototyped {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly kind: 'dir' | 'file';
  readonly changed?: 'added' | 'modified' | 'deleted';
  readonly size?: string;
  readonly updatedAt?: string;
  readonly children?: readonly FileNode[];
  /** Example unified-diff text. Rendered read-only. */
  readonly diff?: string;
}

/* ------------------------------------------------------- tests & the proof */

export interface QualityGate extends Prototyped {
  readonly id: string;
  readonly name: string;
  readonly status: StatusKey;
  readonly duration: string;
  readonly lastRun: string;
  readonly evidenceCount: number;
  /** Example console output revealed on expand. Always labelled EXAMPLE. */
  readonly output: string;
}

export interface ProofEntry extends Prototyped {
  readonly id: string;
  readonly timestamp: string;
  readonly claim: string;
  readonly agent: string;
  readonly taskId: string;
  readonly command: string;
  readonly artifact: string | null;
  readonly verdict: 'accepted' | 'rejected' | 'pending';
  /** Why the verify agent accepted or rejected the claim. */
  readonly reason: string;
}

/* ---------------------------------------------------------------- activity */

export type EventKind =
  | 'mission'
  | 'work-package'
  | 'agent'
  | 'task'
  | 'artifact'
  | 'test'
  | 'verify'
  | 'review'
  | 'system';

export interface ActivityEvent extends Prototyped {
  readonly id: string;
  readonly runId: string;
  readonly timestamp: string;
  readonly kind: EventKind;
  readonly agent: string | null;
  readonly status: StatusKey;
  readonly message: string;
  readonly detail: string;
}

/* --------------------------------------------------- local Claude Code link */

/**
 * Presentation-only. The prototype performs NO detection: it never probes for a
 * CLI, never opens an editor, never reads a session. The state is a fixture the
 * settings screen lets you page through so the future design can be reviewed.
 */
export type ClaudeCodeLinkState =
  | 'not-connected'
  | 'detected'
  | 'vscode-available'
  | 'awaiting-bridge'
  | 'busy'
  | 'disconnected';

export interface ClaudeCodeLink extends Prototyped {
  readonly state: ClaudeCodeLinkState;
  readonly title: string;
  readonly detail: string;
  /** Never mentions an API key — the future link uses the local authenticated session. */
  readonly hint: string;
}

/* ------------------------------------------------------------- preferences */

export type Appearance = 'dark' | 'light' | 'system';
export type Density = 'comfortable' | 'compact';
export type AgentLayout = 'list' | 'grid' | 'grouped';
export type TaskLayout = 'kanban' | 'table' | 'work-packages' | 'phases';

/* ------------------------------------------------------------------ guards */

/** Throws if a record is not an example record. Used at store boundaries. */
export function assertPrototype<T extends Prototyped>(record: T, where: string): T {
  if (record?.prototype !== true) {
    throw new Error(
      `Forge prototype: ${where} received a record without prototype:true. ` +
        'Only local example data may enter the prototype store.',
    );
  }
  return record;
}

/** Narrowing helper for collections. */
export function assertAllPrototype<T extends Prototyped>(records: readonly T[], where: string): readonly T[] {
  records.forEach((r) => assertPrototype(r, where));
  return records;
}
