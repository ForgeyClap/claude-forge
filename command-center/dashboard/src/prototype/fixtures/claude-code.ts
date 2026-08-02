/**
 * Forge Workspace — local Claude Code link fixtures (compatibility re-export).
 *
 * fix-cert-fixtures (forge-2026-07-29-cc-finish): the six records moved to
 * `prototype/data/claude-code.ts` — that file's header explains why. This
 * thin re-export keeps `prototype/fixtures/index.ts` (and the `FIXTURE_DATASET`
 * barrel it assembles) resolving these two names at their existing path,
 * without duplicating the data or changing anything nothing-production-facing
 * that already imports directly from the barrel (e.g. unit tests).
 *
 * Presentation only. The prototype performs NO detection: it never probes for a
 * CLI, never opens an editor, never reads a session and never starts a bridge.
 */

export { CLAUDE_CODE_LINKS, CLAUDE_CODE_LINK_BY_STATE } from '@/prototype/data/claude-code';
