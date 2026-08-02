# The legacy bridge — what it is, and why its test suites are labelled that way

_Written 2026-07-30, after a read-only system-checkup flagged this as one of two HIGH findings._

## The short version

`dashboard/src/bridge/**` (35 TypeScript files) is a 39-operation **WebSocket bridge** from an
earlier design of this dashboard. **The shipped product never runs it.** The live data path is
REST + SSE to the zero-dependency Node gateway on `127.0.0.1:4100`.

The bridge files are **not deleted** — the owner's standing rule is "niks verwijderen", and a
deletion would also throw away a working implementation that a future design might want back.
They simply are not mounted.

Proof, all checkable:

| Claim | Where to see it |
|---|---|
| The live send path is the gateway controller, not the bridge one | `src/prototype/PrototypeProvider.tsx` mounts `useGatewayChatSendController` |
| The bridge client is type-only in live code | `src/prototype/state/bridge-client.ts` — `import type` |
| The live store's socket is constructed but never connected | `src/prototype/state/live-store.ts` header; only `statusKeyOf` has live consumers |
| Live requests go to the gateway | `src/prototype/state/gateway-client.ts` |

## Why the test **labels** changed (and nothing else did)

Five test directories exercise the bridge and only the bridge:

- `tests/chaos/**`, `tests/idempotency/**`, `tests/negative/**` — direct `@/bridge/**` imports
- `tests/security/**` — every file imports `@/bridge/**` (router, `security/paths`, storage,
  attachments, the Claude adapter)
- `tests/integration/**` — imports no bridge module, but spawns the real `node src/bridge/main.ts`
  as a child process from its own `helpers.ts`, which amounts to the same thing

Before this change their vitest projects were called **`bridge`** and **`security`**. A passing run
therefore printed lines that read like assurances about the shipped Command Center — most
misleadingly `security`, which sounds like the live gateway's security is covered here. It is not.

**Live security coverage lives in the gateway suite** (`gateway/test/`): `security.test.mjs`,
`static-security.test.mjs`, `recovery-redaction.test.mjs`, `chaos.test.mjs`, plus the route tests.
That suite is the one to look at when asking "is the running thing hardened".

So the projects were renamed to say what they prove:

| Directory | Project label |
|---|---|
| `tests/chaos`, `tests/idempotency`, `tests/negative` | `legacy-bridge` |
| `tests/security` | `legacy-bridge-paths` |
| `tests/property` | `shared` — **not** legacy: it tests `@/shared/**` (protocol + state machines), which the live path really does import |
| `tests/unit` | `unit` — live code (3 of its files also touch `@/bridge`; they stay put, noted here rather than moved) |

**Nothing was removed from `npm run verify`.** Every one of these suites still runs on every
verify, so reviving the bridge stays safe. Excluding them was considered and rejected: it would
have traded a labelling problem for a coverage problem.

## The guard

`tests/unit/legacy-bridge-labels.test.ts` reads these directories off disk and fails if:

- a test in a legacy-labelled directory does **not** target the bridge — i.e. real coverage of live
  code would be hidden behind a "dead code" label, the mirror image of the original bug; or
- a bridge test appears in `tests/property`, which is labelled `shared` for live code.

If that guard fails, move the file rather than loosening the guard.

## If you ever revive the bridge

Rename the projects back, delete this file, and say so in the commit — at that point the labels
would be lying in the other direction.
