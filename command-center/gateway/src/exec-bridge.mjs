// WP4 T4.5 execution bridge — the A1 mechanism (T1.7 proved `claude -p ... --output-format json`
// exits 0 with structured cost/result data; this module drives the streaming sibling of that same
// call). Zero-dependency (node:child_process + node:readline only).
//
// Honest scope note (see the WP4 forge-report): this spawns ONE `claude -p` process per composer
// turn — a direct chat-turn bridge, NOT the "composer drives a real /forge mission" executor mode
// D2 describes as the eventual target. `T0.3-capability-map.json` names no non-interactive command
// that starts a full `/forge` mission, and driving one from here would mean this gateway writing
// into `.claude/forge-runs/` — forbidden by D2's own write-boundary rule. Building the actual
// mission-driving bridge is out of this WP's literal instructions and is left as a named,
// documented follow-up (naturally sits with WP5's "real multi-task mission" work).
//
// refactor-gateway-split (forge-2026-07-30-cc-finish) UPDATE — this file was ~754 lines, over the
// project's own 500-line-per-file guidance, mixing CLI resolution/env allowlisting, argv
// construction (modes/effort/prompt validation + the mock spawn spec), stream-json parsing/tool-
// activity extraction, and the execution lifecycle (spawn/timeout/kill/slots) together. Pure
// structural split, ZERO behavior change: the real code now lives in `exec-cli.mjs`,
// `exec-argv.mjs`, `exec-stream-parse.mjs` and `exec-lifecycle.mjs`, split along those four real
// seams (see each sibling file's own header for exactly which section it carries and why). This
// file is now a pure re-export façade: every name below is exported under its EXACT original name
// and signature (including every `_...ForTests` seam the test suite already depends on), so no
// other file in the codebase needed to change a single import.
export {
  resolveClaudeCliPath,
  executionAvailability,
  filteredEnv,
} from './exec-cli.mjs';

export {
  _buildRealArgsForTests,
  isUnsafeExecPromptText,
} from './exec-argv.mjs';

export {
  _extractResultUsageForTests,
  _extractFileEditForTests,
  _extractTodoSnapshotForTests,
  _extractShellCommandForTests,
  _extractShellResultForTests,
  _extractSessionIdForTests,
  _extractAgentDispatchForTests,
  _turnArtifactCapsForTests,
} from './exec-stream-parse.mjs';

export {
  _setExecTimeoutMsForTests,
  _pendingExecTimeoutCountForTests,
  isConversationBusy,
  runningExecutionCount,
  maxConcurrentExecutions,
  startExecution,
  stopExecution,
  pauseExecTimeoutForAsk,
  resumeExecTimeoutAfterAsk,
  _isExecTimeoutPausedForAskForTests,
  _execTimeoutRemainingMsForTests,
  _resetExecBridgeForTests,
  enterDrainMode,
  isDraining,
  interruptAllExecutions,
} from './exec-lifecycle.mjs';
