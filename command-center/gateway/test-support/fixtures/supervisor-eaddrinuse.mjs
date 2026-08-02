// Test fixture for supervisor.test.mjs — mimics bin.mjs's OWN real EADDRINUSE stderr line (see
// bin.mjs's `server.on('error', ...)` handler) so the supervisor's EADDRINUSE fast-stop path can
// be proven without ever binding the real port 4100 itself. See supervisor-crash.mjs's header for
// why this lives under test-support/fixtures/ rather than test/fixtures/.
console.error('Forge Command Center gateway failed to start: listen EADDRINUSE: address already in use 127.0.0.1:4100');
process.exit(1);
