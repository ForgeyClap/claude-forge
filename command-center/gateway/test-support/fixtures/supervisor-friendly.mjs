// Test fixture for supervisor.test.mjs — a long-lived, well-behaved child (no HTTP server, no
// port 4100 involved) used to prove the supervisor's stop() path really terminates a REAL child
// process and never attempts to restart it. See supervisor-crash.mjs's header for why this lives
// under test-support/fixtures/ rather than test/fixtures/.
process.stdout.write('FIXTURE_READY pid=' + process.pid + '\n');
const keepAlive = setInterval(() => {}, 60000);
process.on('SIGTERM', () => { clearInterval(keepAlive); process.exit(0); });
process.on('SIGINT', () => { clearInterval(keepAlive); process.exit(0); });
