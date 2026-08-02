import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tmpStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-discord-test-'));
}

export function baseConfig(stateDir, overrides = {}) {
  return {
    transport: 'mock',
    botToken: '',
    guildId: 'g1',
    ownerUserIds: ['owner1'],
    expiryMs: 2 * 3600 * 1000,
    maxQueuedPerThread: 10,
    globalMaxActiveRuns: 2,
    stateDir,
    ...overrides,
  };
}
