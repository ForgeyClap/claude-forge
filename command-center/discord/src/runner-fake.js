// Canary-runner: simuleert een Forge/Claude Code-run met een abortbare delay.
// Wordt in fase 2 vervangen door een echte runner (Claude Code sessie/subprocess);
// de interface is: async ({ item, signal }) => { answer, finalReport? }.

function abortError() {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

export function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });
}

export function createFakeRunner({ delayMs = 10, makeReport = null } = {}) {
  return async function fakeRunner({ item, signal }) {
    await abortableDelay(delayMs, signal);
    const result = { answer: `Echo: ${item.content}` };
    if (makeReport) result.finalReport = makeReport(item);
    return result;
  };
}
