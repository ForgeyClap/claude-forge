/**
 * Forge Workspace — example runs.
 *
 * Four missions across four projects. Durations are example values; no clock
 * was started and no agent was ever dispatched.
 */

import type { Run } from '@/prototype/types/prototype-types';

export const RUNS: readonly Run[] = [
  {
    prototype: true,
    id: 'run-oac-0841',
    projectId: 'proj-oac',
    goal: 'Build a premium booking website for a barbershop.',
    status: 'running',
    startedAt: '2026-07-24 08:41',
    duration: '7h 06m',
    workPackageIds: ['wp-1', 'wp-2', 'wp-3', 'wp-4', 'wp-5', 'wp-6', 'wp-7'],
    agentIds: [
      'agent-boss',
      'agent-head-chef',
      'agent-search-boss',
      'agent-ui-boss',
      'agent-build-boss',
      'agent-test-boss',
      'agent-security-boss',
      'agent-docs-boss',
      'agent-seo-boss',
      'agent-integration-boss',
      'agent-payment-integration',
      'agent-verify-agent',
      'agent-review-boss',
      'agent-skill-boss',
    ],
  },
  {
    prototype: true,
    id: 'run-acf-2213',
    projectId: 'proj-acf',
    goal: 'Recover the supplier feed importer after the upstream schema change dropped product variants.',
    status: 'failed',
    startedAt: '2026-07-23 22:13',
    duration: '2h 41m',
    workPackageIds: ['wp-3', 'wp-4'],
    agentIds: [
      'agent-boss',
      'agent-head-chef',
      'agent-build-boss',
      'agent-integration-boss',
      'agent-test-boss',
      'agent-verify-agent',
    ],
  },
  {
    prototype: true,
    id: 'run-fei-1902',
    projectId: 'proj-fei',
    goal: 'Backtest the value model over the 2025/26 season against closing odds and report the honest edge.',
    status: 'review',
    startedAt: '2026-07-24 04:19',
    duration: '3h 27m',
    workPackageIds: ['wp-1', 'wp-4', 'wp-5'],
    agentIds: [
      'agent-boss',
      'agent-data-scientist',
      'agent-ml-engineer',
      'agent-test-boss',
      'agent-review-boss',
    ],
  },
  {
    prototype: true,
    id: 'run-n8n-0715',
    projectId: 'proj-n8n',
    goal: 'Validate every workflow against the node schema and reject any without a retry policy and an error branch.',
    status: 'verify',
    startedAt: '2026-07-24 07:15',
    duration: '1h 58m',
    workPackageIds: ['wp-4', 'wp-5', 'wp-6'],
    agentIds: [
      'agent-head-chef',
      'agent-integration-boss',
      'agent-security-boss',
      'agent-docs-boss',
      'agent-verify-agent',
    ],
  },
];
