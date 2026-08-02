/**
 * Forge Workspace — example mission graph.
 *
 * Left to right: the request, Boss, Head Chef, then six parallel lanes of three
 * steps each, then verification, review, the fix loop and the final output.
 *
 * Layout is computed from `col` and `row` — a renderer only needs
 * `x = col * colGap` and `y = row * laneGap`. Each lane owns a whole row band so
 * the chains stack without crossing; the spine sits on row 2.5, centred against
 * the six lanes.
 */

import type { GraphEdge, GraphLane, GraphNode, MissionGraph } from '@/prototype/types/prototype-types';

/** The spine (request → boss → head chef → verify → review → fix → output). */
const SPINE_ROW = 2.5;

const LANES: readonly GraphLane[] = [
  { prototype: true, id: 'lane-search', label: 'Search Boss', group: 'context' },
  { prototype: true, id: 'lane-build', label: 'Build Boss', group: 'execution' },
  { prototype: true, id: 'lane-ui', label: 'UI Boss', group: 'execution' },
  { prototype: true, id: 'lane-test', label: 'Test Boss', group: 'review' },
  { prototype: true, id: 'lane-security', label: 'Security Boss', group: 'review' },
  { prototype: true, id: 'lane-docs', label: 'Docs Boss', group: 'domain' },
];

const NODES: readonly GraphNode[] = [
  /* ------------------------------------------------------------ col 0–2 */
  {
    prototype: true,
    id: 'gn-request',
    label: 'User Request',
    kind: 'request',
    status: 'completed',
    col: 0,
    row: SPINE_ROW,
    laneId: null,
    duration: '—',
    detail:
      'One sentence from the owner: "Build a premium booking website for a barbershop." Everything to the right of this node is an interpretation of it, which is why intake came before planning.',
  },
  {
    prototype: true,
    id: 'gn-boss',
    label: 'Boss',
    kind: 'boss',
    status: 'running',
    col: 1,
    row: SPINE_ROW,
    laneId: null,
    agent: 'Boss',
    duration: '7h 06m',
    model: 'forge-runtime · max effort',
    skills: ['forge-router', 'forge-intake'],
    detail:
      'Classified the request as a website build at complexity L3 and opened a single intake round. Holds the mission open until the evidence matches the claims — it has already refused one completion.',
  },
  {
    prototype: true,
    id: 'gn-head-chef',
    label: 'Head Chef',
    kind: 'head-chef',
    status: 'running',
    col: 2,
    row: SPINE_ROW,
    laneId: null,
    agent: 'Head Chef',
    duration: '24m',
    model: 'forge-runtime · high effort',
    skills: ['forge-prd', 'forge-mindmap'],
    detail:
      'Cut the mission into seven work packages and six parallel lanes, ordered so no lane waits on another for its first task. Re-cut the plan once after review sent WP4 back.',
  },

  /* ------------------------------------------------------- lane: search */
  {
    prototype: true,
    id: 'gn-search-1',
    label: 'Gather context',
    kind: 'lane-agent',
    status: 'completed',
    col: 3,
    row: 0,
    laneId: 'lane-search',
    agent: 'Search Boss',
    duration: '18m',
    model: 'forge-runtime · medium effort',
    skills: ['forge-deeplearn'],
    detail:
      'Read the intake answers and the existing front-end kit before looking outward, so the reference sweep knew what already existed and did not recommend rebuilding it.',
  },
  {
    prototype: true,
    id: 'gn-search-2',
    label: 'Inspect sources',
    kind: 'step',
    status: 'completed',
    col: 4,
    row: 0,
    laneId: 'lane-search',
    agent: 'Search Boss',
    duration: '39m',
    model: 'forge-runtime · medium effort',
    skills: ['forge-scraping'],
    detail:
      'Twelve published booking flows walked end to end, nine of them at 390px. Public pages only, recorded by what each flow asks for and in which order.',
  },
  {
    prototype: true,
    id: 'gn-search-3',
    label: 'Research report',
    kind: 'step',
    status: 'completed',
    col: 5,
    row: 0,
    laneId: 'lane-search',
    agent: 'Search Boss',
    duration: '27m',
    model: 'forge-runtime · medium effort',
    skills: ['forge-rag'],
    detail:
      'Three patterns recommended, two rejected, and one gap reported: none of the twelve stated a deposit policy before the payment screen.',
  },

  /* -------------------------------------------------------- lane: build */
  {
    prototype: true,
    id: 'gn-build-1',
    label: 'Architecture',
    kind: 'lane-agent',
    status: 'completed',
    col: 3,
    row: 1,
    laneId: 'lane-build',
    agent: 'Build Boss',
    duration: '50m',
    model: 'forge-runtime · high effort',
    skills: ['forge-fullstack'],
    detail:
      'Four tables and one rule that decided the rest: a slot belongs to a barber, never to the shop. Service duration and buffer time modelled separately.',
  },
  {
    prototype: true,
    id: 'gn-build-2',
    label: 'Implementation',
    kind: 'step',
    status: 'running',
    col: 4,
    row: 1,
    laneId: 'lane-build',
    agent: 'Build Boss',
    duration: '4h 31m',
    model: 'forge-runtime · high effort',
    skills: ['forge-fullstack', 'forge-website'],
    detail:
      'Availability calculator and the four-step form. Currently collapsing duplicate slots by barber instead of by service — the fix loop routes back into this node.',
  },
  {
    prototype: true,
    id: 'gn-build-3',
    label: 'Local checks',
    kind: 'step',
    status: 'verify',
    col: 5,
    row: 1,
    laneId: 'lane-build',
    agent: 'Build Boss',
    duration: '36s',
    model: 'forge-runtime · high effort',
    skills: ['forge-verify'],
    detail:
      'Typecheck, lint and build, clean on all three. Emits the build hash that every screenshot footer is matched against downstream.',
  },

  /* ----------------------------------------------------------- lane: ui */
  {
    prototype: true,
    id: 'gn-ui-1',
    label: 'Design pass',
    kind: 'lane-agent',
    status: 'completed',
    col: 3,
    row: 2,
    laneId: 'lane-ui',
    agent: 'UI Boss',
    duration: '34m',
    model: 'forge-runtime · high effort',
    skills: ['forge-website', 'artifact-design'],
    detail:
      'One type scale, five steps, a 4px grid. The display size came down twice so the headline stopped competing with the only control that matters.',
  },
  {
    prototype: true,
    id: 'gn-ui-2',
    label: 'Responsive pass',
    kind: 'step',
    status: 'running',
    col: 4,
    row: 2,
    laneId: 'lane-ui',
    agent: 'UI Boss',
    duration: '1h 12m',
    model: 'forge-runtime · high effort',
    skills: ['forge-website', 'gsap'],
    detail:
      '360, 768 and 1440. The known risk is the slot grid, which is the section the mobile journey already broke on.',
  },
  {
    prototype: true,
    id: 'gn-ui-3',
    label: 'Screenshot review',
    kind: 'step',
    status: 'verify',
    col: 5,
    row: 2,
    laneId: 'lane-ui',
    agent: 'UI Boss',
    duration: '38s',
    model: 'forge-runtime · high effort',
    skills: ['artifact-design'],
    detail:
      'Desktop capture accepted. The mobile capture is held rather than failed: its build hash does not match the tested build, so it supports no conclusion at all.',
  },

  /* --------------------------------------------------------- lane: test */
  {
    prototype: true,
    id: 'gn-test-1',
    label: 'Unit tests',
    kind: 'lane-agent',
    status: 'completed',
    col: 3,
    row: 3,
    laneId: 'lane-test',
    agent: 'Test Boss',
    duration: '4.1s',
    model: 'forge-runtime · high effort',
    skills: ['forge-verify'],
    detail:
      'Eighty-two cases across slots, pricing and validation. The expensive ones are the boundaries: closing time, timezone drift, the daylight-saving Sunday.',
  },
  {
    prototype: true,
    id: 'gn-test-2',
    label: 'Browser tests',
    kind: 'step',
    status: 'failed',
    col: 4,
    row: 3,
    laneId: 'lane-test',
    agent: 'Test Boss',
    duration: '1m 12s',
    model: 'forge-runtime · high effort',
    skills: ['forge-verify', 'ship-readiness'],
    detail:
      'Desktop passes in 6.4s. Mobile fails at step 3 on 390 x 844 — the confirm button is present in the DOM and never hit-testable. Reproduced three times out of three.',
  },
  {
    prototype: true,
    id: 'gn-test-3',
    label: 'Bug report',
    kind: 'step',
    status: 'completed',
    col: 5,
    row: 3,
    laneId: 'lane-test',
    agent: 'Test Boss',
    duration: '11m',
    model: 'forge-runtime · high effort',
    skills: ['forge-report'],
    detail:
      'Names the viewport, the intercepting element and the exact locator, with a trace and a video attached. No sentence in it contains the phrase "mobile is off".',
  },

  /* ----------------------------------------------------- lane: security */
  {
    prototype: true,
    id: 'gn-sec-1',
    label: 'Secret scan',
    kind: 'lane-agent',
    status: 'completed',
    col: 3,
    row: 4,
    laneId: 'lane-security',
    agent: 'Security Boss',
    duration: '27.3s',
    model: 'forge-runtime · high effort',
    skills: ['security-review', 'forge-doctor'],
    detail:
      '214 tracked files, zero live credentials. One near-miss quoted in full with its line number instead of being silently cleared.',
  },
  {
    prototype: true,
    id: 'gn-sec-2',
    label: 'Permissions review',
    kind: 'step',
    status: 'review',
    col: 4,
    row: 4,
    laneId: 'lane-security',
    agent: 'Security Boss',
    duration: '14m',
    model: 'forge-runtime · high effort',
    skills: ['security-review'],
    detail:
      'Three agents held write access. Integration Boss was granted elevated permission for a send step that never executed, and the recommendation is to take it back.',
  },
  {
    prototype: true,
    id: 'gn-sec-3',
    label: 'Risk report',
    kind: 'step',
    status: 'waiting',
    col: 5,
    row: 4,
    laneId: 'lane-security',
    agent: 'Security Boss',
    duration: '—',
    model: 'forge-runtime · high effort',
    skills: ['security-review', 'forge-integration'],
    detail:
      'Waiting on the payment surface. Reviewing code that has never been executed would produce a report about intentions rather than behaviour.',
  },

  /* --------------------------------------------------------- lane: docs */
  {
    prototype: true,
    id: 'gn-docs-1',
    label: 'Update docs',
    kind: 'lane-agent',
    status: 'review',
    col: 3,
    row: 5,
    laneId: 'lane-docs',
    agent: 'Docs Boss',
    duration: '48m',
    model: 'forge-runtime · medium effort',
    skills: ['forge-report', 'humanizer'],
    detail:
      'README and setup notes rewritten for a machine with nothing installed. The two unfinished areas are named in the opening section, not the closing one.',
  },
  {
    prototype: true,
    id: 'gn-docs-2',
    label: 'Markdown validation',
    kind: 'step',
    status: 'completed',
    col: 4,
    row: 5,
    laneId: 'lane-docs',
    agent: 'Docs Boss',
    duration: '2.4s',
    model: 'forge-runtime · medium effort',
    skills: ['forge-report'],
    detail:
      'Eleven documents, two with skipped heading levels. Both corrected — that pattern reads fine to a person and badly to a screen reader.',
  },
  {
    prototype: true,
    id: 'gn-docs-3',
    label: 'Handoff',
    kind: 'step',
    status: 'waiting',
    col: 5,
    row: 5,
    laneId: 'lane-docs',
    agent: 'Docs Boss',
    duration: '—',
    model: 'forge-runtime · medium effort',
    skills: ['ship-readiness', 'forge-report'],
    detail:
      'Deliberately last. A handoff written before verification closes would be rewritten within the hour, and the first version would already have been sent.',
  },

  /* ------------------------------------------------------------ col 6–9 */
  {
    prototype: true,
    id: 'gn-verify',
    label: 'Verify Agent',
    kind: 'verify',
    status: 'verify',
    col: 6,
    row: SPINE_ROW,
    laneId: null,
    agent: 'Verify Agent',
    duration: '22 claims',
    model: 'forge-runtime · high effort',
    skills: ['forge-verify', 'forge-graded-verify'],
    detail:
      'Nineteen claims accepted, three rejected, one open. Checks one thing: does the attached evidence show the claim, on the build the claim refers to.',
  },
  {
    prototype: true,
    id: 'gn-review',
    label: 'Review Boss',
    kind: 'review',
    status: 'review',
    col: 7,
    row: SPINE_ROW,
    laneId: null,
    agent: 'Review Boss',
    duration: '4m 02s',
    model: 'forge-runtime · max effort',
    skills: ['forge-graded-verify', 'forge-report'],
    detail:
      'Approved WP1 and WP2, requested changes on WP3, reopened WP4. The reopen was not stylistic: the summary claimed a passing mobile journey while the attached run showed a failure.',
  },
  {
    prototype: true,
    id: 'gn-fix',
    label: 'Fix Loop',
    kind: 'fix',
    status: 'running',
    col: 8,
    row: SPINE_ROW,
    laneId: null,
    agent: 'Head Chef',
    duration: '1h 37m',
    model: 'forge-runtime · high effort',
    skills: ['forge-verify'],
    detail:
      'WP7, opened by the loop rather than by a person: rebuild, recapture, re-run, re-check. Two repair attempts spent, which is the whole budget before the mission escalates to the owner.',
  },
  {
    prototype: true,
    id: 'gn-output',
    label: 'Final Output',
    kind: 'output',
    status: 'waiting',
    col: 9,
    row: SPINE_ROW,
    laneId: null,
    duration: '—',
    detail:
      'Not reached. The mission cannot close while the mobile journey fails, and the draft final report says so in its second paragraph rather than its last.',
  },
];

const EDGES: readonly GraphEdge[] = [
  /* spine into the lanes */
  { prototype: true, id: 'ge-req-boss', from: 'gn-request', to: 'gn-boss', kind: 'flow' },
  { prototype: true, id: 'ge-boss-chef', from: 'gn-boss', to: 'gn-head-chef', kind: 'flow', label: 'intake complete' },
  { prototype: true, id: 'ge-chef-search', from: 'gn-head-chef', to: 'gn-search-1', kind: 'flow' },
  { prototype: true, id: 'ge-chef-build', from: 'gn-head-chef', to: 'gn-build-1', kind: 'flow' },
  { prototype: true, id: 'ge-chef-ui', from: 'gn-head-chef', to: 'gn-ui-1', kind: 'flow' },
  { prototype: true, id: 'ge-chef-test', from: 'gn-head-chef', to: 'gn-test-1', kind: 'flow' },
  { prototype: true, id: 'ge-chef-sec', from: 'gn-head-chef', to: 'gn-sec-1', kind: 'flow' },
  { prototype: true, id: 'ge-chef-docs', from: 'gn-head-chef', to: 'gn-docs-1', kind: 'flow' },

  /* inside each lane */
  { prototype: true, id: 'ge-search-1-2', from: 'gn-search-1', to: 'gn-search-2', kind: 'flow' },
  { prototype: true, id: 'ge-search-2-3', from: 'gn-search-2', to: 'gn-search-3', kind: 'flow' },
  { prototype: true, id: 'ge-build-1-2', from: 'gn-build-1', to: 'gn-build-2', kind: 'flow' },
  { prototype: true, id: 'ge-build-2-3', from: 'gn-build-2', to: 'gn-build-3', kind: 'flow' },
  { prototype: true, id: 'ge-ui-1-2', from: 'gn-ui-1', to: 'gn-ui-2', kind: 'flow' },
  { prototype: true, id: 'ge-ui-2-3', from: 'gn-ui-2', to: 'gn-ui-3', kind: 'flow' },
  { prototype: true, id: 'ge-test-1-2', from: 'gn-test-1', to: 'gn-test-2', kind: 'flow' },
  { prototype: true, id: 'ge-test-2-3', from: 'gn-test-2', to: 'gn-test-3', kind: 'flow' },
  { prototype: true, id: 'ge-sec-1-2', from: 'gn-sec-1', to: 'gn-sec-2', kind: 'flow' },
  { prototype: true, id: 'ge-sec-2-3', from: 'gn-sec-2', to: 'gn-sec-3', kind: 'flow' },
  { prototype: true, id: 'ge-docs-1-2', from: 'gn-docs-1', to: 'gn-docs-2', kind: 'flow' },
  { prototype: true, id: 'ge-docs-2-3', from: 'gn-docs-2', to: 'gn-docs-3', kind: 'flow' },

  /* lanes into verification */
  { prototype: true, id: 'ge-search-verify', from: 'gn-search-3', to: 'gn-verify', kind: 'flow' },
  { prototype: true, id: 'ge-build-verify', from: 'gn-build-3', to: 'gn-verify', kind: 'flow' },
  { prototype: true, id: 'ge-ui-verify', from: 'gn-ui-3', to: 'gn-verify', kind: 'flow' },
  { prototype: true, id: 'ge-test-verify', from: 'gn-test-3', to: 'gn-verify', kind: 'flow' },
  { prototype: true, id: 'ge-sec-verify', from: 'gn-sec-3', to: 'gn-verify', kind: 'flow' },
  { prototype: true, id: 'ge-docs-verify', from: 'gn-docs-3', to: 'gn-verify', kind: 'flow' },

  /* the tail */
  { prototype: true, id: 'ge-verify-review', from: 'gn-verify', to: 'gn-review', kind: 'flow', label: '19 accepted' },
  { prototype: true, id: 'ge-review-fix', from: 'gn-review', to: 'gn-fix', kind: 'flow', label: 'changes requested' },
  { prototype: true, id: 'ge-fix-output', from: 'gn-fix', to: 'gn-output', kind: 'flow' },

  /* feedback */
  {
    prototype: true,
    id: 'ge-review-chef',
    from: 'gn-review',
    to: 'gn-head-chef',
    kind: 'feedback',
    label: 'reopen mission',
  },
  {
    prototype: true,
    id: 'ge-fix-build',
    from: 'gn-fix',
    to: 'gn-build-2',
    kind: 'feedback',
    label: 'rebuild and recapture',
  },

  /* dependencies */
  {
    prototype: true,
    id: 'ge-dep-search-build',
    from: 'gn-search-3',
    to: 'gn-build-1',
    kind: 'dependency',
    label: 'patterns',
  },
  {
    prototype: true,
    id: 'ge-dep-build-ui',
    from: 'gn-build-2',
    to: 'gn-ui-2',
    kind: 'dependency',
    label: 'markup',
  },
  {
    prototype: true,
    id: 'ge-dep-build-test',
    from: 'gn-build-3',
    to: 'gn-test-2',
    kind: 'dependency',
    label: 'build hash',
  },
  {
    prototype: true,
    id: 'ge-dep-test-fix',
    from: 'gn-test-3',
    to: 'gn-fix',
    kind: 'dependency',
    label: 'open defect',
  },
  {
    prototype: true,
    id: 'ge-dep-sec-review',
    from: 'gn-sec-3',
    to: 'gn-review',
    kind: 'dependency',
    label: 'risk sign-off',
  },
];

export const MISSION_GRAPH: MissionGraph = {
  prototype: true,
  id: 'graph-oac-booking',
  runId: 'run-oac-0841',
  lanes: LANES,
  nodes: NODES,
  edges: EDGES,
};
