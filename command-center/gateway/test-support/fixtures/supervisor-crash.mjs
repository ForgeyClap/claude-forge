// Test fixture for supervisor.test.mjs — NOT the real gateway, never binds any port. Exits
// immediately with a non-zero code to simulate an unexpected crash, so the supervisor's
// restart/backoff/crash-loop logic can be proven against a REAL child process without ever
// touching bin.mjs or the real port 4100.
//
// Lives under test-support/ (not test/) deliberately: node's test runner auto-discovers ANY .mjs
// file under a directory literally named `test` or `tests` and runs it as a standalone test file
// (verified for this WP) — a fixture that calls process.exit(1) would then be reported as a
// failing test in its own right. test-support/ is never scanned.
console.error('FIXTURE supervisor-crash: crashing now');
process.exit(1);
