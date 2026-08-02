#!/usr/bin/env node
/**
 * Forge Workspace — perf-report (mission section I).
 *
 * Folds the measurements the load suite writes to a temp JSON into
 * `artifacts/perf-report.json`, with a clear banner, the real numbers and the
 * sample counts behind them.
 *
 * WHAT THIS IS NOT. Every number here comes from CLEARLY SYNTHETIC transport and
 * rendering events fabricated inside the tests. It is a measurement of the store,
 * the transport client and the layout maths — NOT evidence that any real Claude
 * Code run happened. The banner says so, and this script never invents a number:
 * a measurement that was not recorded is reported as absent, not as a pass.
 *
 * Usage:
 *   node scripts/perf-report.cjs           summarise whatever the load suite left
 *   node scripts/perf-report.cjs --run     run the load suite first, then summarise
 *   node scripts/perf-report.cjs --out P   write the report to path P as well
 *
 * The temp inputs are written by:
 *   tests/load/rendering.test.ts        -> <tmp>/forge-perf-suite/rendering.json
 *   tests/load/event-throughput.test.ts -> <tmp>/forge-perf-suite/event-throughput.json
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(os.tmpdir(), 'forge-perf-suite');
const RENDER_FILE = path.join(OUT_DIR, 'rendering.json');
const THROUGHPUT_FILE = path.join(OUT_DIR, 'event-throughput.json');
const REPORT_PATH = path.join(REPO_ROOT, 'artifacts', 'perf-report.json');
const LOAD_CONFIG = path.join(REPO_ROOT, 'vitest.load.config.ts');

const BANNER = 'SYNTHETIC — rendering/throughput only, not execution proof';
const DISCLAIMER =
  'Every number in this report was produced from fabricated, clearly-labelled synthetic ' +
  'events. It measures the durable store, the transport client and the graph-layout maths. ' +
  'It is NOT evidence that any real Claude Code run happened. Percentile targets are goals, ' +
  'not results: a target is reported as met only when a measured p95 says so.';

/* --------------------------------------------------------------------- args */

const args = process.argv.slice(2);
const wantRun = args.includes('--run');
const outIndex = args.indexOf('--out');
const extraOut = outIndex >= 0 && args[outIndex + 1] ? path.resolve(args[outIndex + 1]) : null;

/* ---------------------------------------------------------------- run suite */

function findVitestBin() {
  try {
    const pkg = require.resolve('vitest/package.json');
    const bin = path.join(path.dirname(pkg), 'vitest.mjs');
    if (fs.existsSync(bin)) return bin;
  } catch (_err) {
    /* fall through to the guess below */
  }
  const guess = path.join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');
  return fs.existsSync(guess) ? guess : null;
}

function runSuite() {
  const bin = findVitestBin();
  if (bin === null) {
    console.error('perf-report: could not locate the vitest binary to run the load suite.');
    process.exit(1);
  }
  console.log('perf-report: running the load suite (vitest.load.config.ts)…');
  const result = spawnSync(process.execPath, [bin, 'run', '--config', LOAD_CONFIG], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    console.error(`perf-report: the load suite exited with status ${result.status}.`);
    process.exit(result.status === null ? 1 : result.status);
  }
}

/* ------------------------------------------------------------------- helpers */

function readJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`perf-report: could not read ${file}: ${err.message}`);
    return null;
  }
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Compact one duration summary to the trio the human table shows. */
function trio(summary) {
  if (!summary || typeof summary !== 'object') return null;
  return {
    sampleCount: num(summary.sampleCount),
    p50Ms: num(summary.p50Ms),
    p95Ms: num(summary.p95Ms),
    p99Ms: num(summary.p99Ms),
  };
}

/* --------------------------------------------------------------- summarise */

function summariseRendering(rendering) {
  if (!rendering) return { present: false, note: 'not found — run: node scripts/perf-report.cjs --run' };
  const graphLayout = Array.isArray(rendering.graphLayout) ? rendering.graphLayout : [];
  const conversation = Array.isArray(rendering.conversationMapping) ? rendering.conversationMapping : [];
  const fileTree = rendering.fileTree && Array.isArray(rendering.fileTree.cases) ? rendering.fileTree.cases : [];
  return {
    present: true,
    graphLayout: graphLayout.map((c) => ({
      nodes: c.nodes,
      boxes: c.boxes,
      nanFound: c.nanFound === true,
      iterations: c.iterations,
      durationsMs: trio(c.durationsMs),
    })),
    conversationMapping: conversation.map((c) => ({
      messages: c.messages,
      passes: c.passes,
      meanPerMessageMs: num(c.meanPerMessageMs),
      wholeConversationMs: trio(c.wholeConversationDurationsMs),
    })),
    fileTree: {
      provenance: rendering.fileTree ? rendering.fileTree.provenance : null,
      cases: fileTree.map((c) => ({
        nodeCount: c.nodeCount,
        flattenMs: trio(c.flattenDurationsMs),
        visibleRowsMs: trio(c.visibleRowsDurationsMs),
      })),
    },
  };
}

function summariseThroughput(throughput) {
  if (!throughput) return { present: false, note: 'not found — run: node scripts/perf-report.cjs --run' };
  const store = throughput.store || {};
  const transport = throughput.transport || {};
  const append = Array.isArray(store.append) ? store.append : [];
  const replay = Array.isArray(store.replay) ? store.replay : [];
  const gapDetection = Array.isArray(store.gapDetection) ? store.gapDetection : [];
  const delivery = Array.isArray(transport.delivery) ? transport.delivery : [];
  return {
    present: true,
    storeAppend: append.map((c) =>
      c.skipped
        ? { events: c.events, skipped: true, reason: c.reason, projectedMs: num(c.projectedMs) }
        : {
            events: c.events,
            monotonic: c.monotonic === true,
            lossless: c.lossless === true,
            gaps: num(c.gaps),
            eventsPerSecond: num(c.eventsPerSecond),
            appendMs: trio(c.appendMs),
          },
    ),
    storeGapDetection: gapDetection.map((c) => ({ events: c.events, detectGapsMs: num(c.detectGapsMs), gaps: num(c.gaps) })),
    storeReplay: replay.map((c) => ({
      events: c.events,
      pages: c.pages,
      replayedCount: c.replayedCount,
      monotonic: c.monotonic === true,
      lossless: c.lossless === true,
      replayPageMs: num(c.replayPageMs),
      replayFullMs: num(c.replayFullMs),
      eventsPerSecondFull: num(c.eventsPerSecondFull),
    })),
    transportDelivery: delivery.map((c) => ({
      events: c.events,
      deliveredCount: c.deliveredCount,
      monotonic: c.monotonic === true,
      lossless: c.lossless === true,
      eventsPerSecond: num(c.eventsPerSecond),
      deliveryLatency: c.deliveryLatency
        ? {
            measured: c.deliveryLatency.measured === true,
            sampleCount: num(c.deliveryLatency.sampleCount),
            totalObserved: num(c.deliveryLatency.totalObserved),
            p50Ms: num(c.deliveryLatency.p50Ms),
            p95Ms: num(c.deliveryLatency.p95Ms),
            p99Ms: num(c.deliveryLatency.p99Ms),
            clockBasis: c.deliveryLatency.clockBasis,
            meetsP95Target: c.deliveryLatency.meetsP95Target,
          }
        : null,
    })),
    gapReconciliation: transport.gapReconciliation || null,
    assessment: throughput.assessment || null,
  };
}

/* ------------------------------------------------------------------ compose */

if (wantRun) runSuite();

const rendering = readJson(RENDER_FILE);
const throughput = readJson(THROUGHPUT_FILE);

if (rendering === null && throughput === null) {
  console.error(
    'perf-report: no measurements found. Run the load suite first:\n' +
      '  npx vitest run --config vitest.load.config.ts\n' +
      'or let this script run it:\n' +
      '  node scripts/perf-report.cjs --run',
  );
  process.exit(1);
}

const report = {
  banner: BANNER,
  disclaimer: DISCLAIMER,
  generatedAt: new Date().toISOString(),
  tool: 'scripts/perf-report.cjs',
  env: (rendering && rendering.env) || (throughput && throughput.env) || null,
  targets: {
    ingestionP95Ms: 25,
    deliveryP95Ms: 50,
    note: 'targets are goals, not results — reported met only when a measured p95 says so',
  },
  sources: {
    rendering: { file: RENDER_FILE, present: rendering !== null },
    eventThroughput: { file: THROUGHPUT_FILE, present: throughput !== null },
  },
  rendering: summariseRendering(rendering),
  eventThroughput: summariseThroughput(throughput),
  raw: {
    rendering: rendering || null,
    eventThroughput: throughput || null,
  },
};

fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
if (extraOut) {
  fs.mkdirSync(path.dirname(extraOut), { recursive: true });
  fs.writeFileSync(extraOut, JSON.stringify(report, null, 2), 'utf8');
}

/* --------------------------------------------------------- human-readable */

console.log('');
console.log(`  ${BANNER}`);
console.log('  ' + '-'.repeat(BANNER.length));

if (report.rendering.present) {
  console.log('  graph layout (real computeGraphLayout):');
  for (const c of report.rendering.graphLayout) {
    const d = c.durationsMs || {};
    console.log(
      `    ${String(c.nodes).padStart(5)} nodes  p50=${d.p50Ms}ms p95=${d.p95Ms}ms p99=${d.p99Ms}ms  (n=${d.sampleCount}, NaN=${c.nanFound})`,
    );
  }
}

if (report.eventThroughput.present) {
  console.log('  store append (durable ingestion):');
  for (const c of report.eventThroughput.storeAppend) {
    if (c.skipped) {
      console.log(`    ${String(c.events).padStart(6)} events  SKIPPED — projected ~${c.projectedMs}ms`);
    } else {
      const a = c.appendMs || {};
      console.log(
        `    ${String(c.events).padStart(6)} events  p50=${a.p50Ms}ms p95=${a.p95Ms}ms p99=${a.p99Ms}ms  (${c.eventsPerSecond}/s, lossless=${c.lossless})`,
      );
    }
  }
  console.log('  transport delivery (real client sequencing):');
  for (const c of report.eventThroughput.transportDelivery) {
    const d = c.deliveryLatency || {};
    console.log(
      `    ${String(c.events).padStart(6)} events  p50=${d.p50Ms}ms p95=${d.p95Ms}ms p99=${d.p99Ms}ms  (delivered=${c.deliveredCount}, monotonic=${c.monotonic})`,
    );
  }
  const a = report.eventThroughput.assessment;
  if (a) {
    const ing = a.ingestion || {};
    const del = a.delivery || {};
    console.log('  assessment vs mission targets (measured, not asserted):');
    console.log(`    ingestion p95=${ing.p95Ms}ms  target<${ing.targetP95Ms}ms  meets=${ing.meetsP95Target}`);
    console.log(`    delivery  p95=${del.p95Ms}ms  target<${del.targetP95Ms}ms  meets=${del.meetsP95Target}`);
  }
}

console.log('');
console.log(`  report written: ${REPORT_PATH}`);
if (extraOut) console.log(`  report written: ${extraOut}`);
console.log('');
