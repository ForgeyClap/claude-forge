# Hosting Forge Workspace on a Mac mini

Status: **DESIGN AND CHECKLIST. NOT IMPLEMENTED.**

Nothing in this document has been executed. There is no macOS code in the repository, no
launchd plist, no migration script. `LAN_MODE` and `REMOTE_ACCESS` stay `false`; moving the
workspace to a Mac mini does not change that, and a Mac mini on the desk is still a
loopback-only install unless [`lan-mode-design.md`](./lan-mode-design.md) is separately
designed, built and approved.

Everything below labelled **FOUND** comes from reading the code in this repository on
2026-07-24. Everything labelled **UNVERIFIED** is a claim about macOS behaviour that I could
not test from a Windows machine, and it must be checked on the actual hardware before it is
relied on. The distinction is kept explicit on purpose — a migration checklist that mixes
what was measured with what sounds right is how a move goes wrong on day two.

See [`architecture.md`](./architecture.md) for what the system actually is today, including
the fact that only 7 of 39 contract operations are currently wired.

---

## 1. Cross-platform findings from the code

### 1.1 Process termination — the largest single difference

**FOUND** — `src/bridge/claude/adapter.ts`:

```ts
const child = spawn(this.options.located.executablePath, [...built.argv], {
  shell: false,
  windowsHide: true,
  detached: this.platform !== 'win32',   // ← macOS gets a process group
  ...
});
```

and in `terminateTree()`:

```ts
if (this.platform === 'win32') {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? null;
  const taskkill = systemRoot === null ? 'taskkill.exe' : join(systemRoot, 'System32', 'taskkill.exe');
  const argv = force ? ['/PID', String(pid), '/T', '/F'] : ['/PID', String(pid), '/T'];
  ...
}
const signal = force ? 'SIGKILL' : 'SIGTERM';
process.kill(-pid, signal);          // negative pid = the process group
```

The POSIX path already exists and is coherent: `detached: true` makes the child a process
group leader, and `process.kill(-pid, …)` reaches the whole tree. On failure it falls back to
`child.kill(signal)` on the single pid and *says so* in the returned detail string.

What changes on macOS, and what to check:

- **`detached: true` means the children outlive a bridge crash.** On Windows the same is true
  in practice, so this is not new, but it is more visible on a machine that is meant to stay
  up. The startup reconciler is the safety net: any run still claiming a live status becomes
  `INTERRUPTED` or `ORPHANED`, never `COMPLETED`.
- **SIGTERM to a process group is a real signal, unlike `taskkill /T`.** `claude` may install
  its own handler. The adapter's two-phase behaviour (graceful, wait `graceMs`, then force,
  wait `forceWaitMs`, then record `EXIT_NOT_OBSERVED` and leave the run `STOPPING`) is
  correct for this, but the grace window may want re-tuning once real numbers exist.
  **UNVERIFIED** — no timing measured on macOS.
- **`process.kill(-pid, …)` throws `EPERM` if the child changed its group.** The fallback
  handles it, but the detail string is what tells you it happened. Watch for
  `"the process group was unavailable"` in cancel results after the move.
- `windowsHide: true` is ignored on macOS. Harmless.
- **`launchd` will reap what it started.** If the bridge is a LaunchAgent with `KeepAlive`,
  killing the bridge does *not* kill the detached `claude` children; launchd restarts the
  bridge, the reconciler marks the old runs `ORPHANED`, and the old children keep burning
  tokens until they finish. Decide deliberately whether `stopAll()` on shutdown is enough.
  **FOUND** — `stopAll()` exists on the adapter but is **not** registered as a shutdown task
  in `startBridge()`, because the adapter is not wired into the running bridge at all yet. The
  shutdown-task mechanism itself is real and in use: `startBridge()` registers a
  `claude-code-probe` task with a 1 s budget, on the stated principle that "a liveness check
  must never be the reason a process refuses to exit". Registering `stopAll()` the same way is
  the obvious move once the adapter is wired, with a budget larger than
  `graceMs + forceWaitMs` so a timeout actually means something.

### 1.2 Locating the Claude Code CLI

**FOUND** — `src/bridge/claude/locate.ts` discovers candidates from three sources, in order:

1. `options.executablePath` or `process.env.FORGE_CLAUDE_PATH`
2. `<%APPDATA%>/Claude/claude-code/<version>/claude.{exe,cmd,bat}` — version directories
   sorted numerically, newest first
3. every entry of `PATH`, looking for `claude` (POSIX) or `claude.exe|.cmd|.bat` (Windows)

On macOS, source 2 yields nothing: `process.env.APPDATA` is undefined, so the whole branch is
skipped. **That leaves PATH and `FORGE_CLAUDE_PATH` as the only ways to find the CLI.**

This matters more than it looks, because **a launchd job does not inherit your shell's PATH**.
A LaunchAgent gets a minimal `PATH` (conventionally `/usr/bin:/bin:/usr/sbin:/sbin`) unless
the plist sets one. Homebrew (`/opt/homebrew/bin`), `~/.local/bin` and npm global prefixes are
all absent from that. **UNVERIFIED** — the exact inherited PATH under launchd on the target
macOS version must be confirmed with a one-line job that logs `echo $PATH`.

Recommended: set `FORGE_CLAUDE_PATH` explicitly in the plist to the absolute path of the
installed `claude`. That is the source the locator checks first, and it removes the whole
PATH question.

Also **FOUND**: candidate filtering is `statSync(candidate).isFile()`. It does **not** check
the execute bit. On macOS a `claude` that is a file but not `+x` passes discovery and then
fails at `spawn` with `EACCES`. The locator would report the executable as a candidate and
then note `could not be started`. Correct behaviour, confusing message. Consider an
`fs.accessSync(candidate, fs.constants.X_OK)` check as part of the port.

The probe itself is platform-neutral: run `--version`, run `--help` once, parse the option
column, and refuse any executable whose flag set cannot be established. `FORBIDDEN_FLAGS`
(`--max-turns`, `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`) are
refused regardless of what `--help` says on any platform.

**UNVERIFIED and important**: on macOS, Claude Code's credentials are widely understood to
live in the login Keychain. A launchd job that starts before the user logs into the GUI may
run with a locked or absent login keychain, in which case `claude -p` will fail
authentication with no way to prompt. See §3.4.

### 1.3 Path separators and the path guard

**FOUND** — `src/bridge/security/paths.ts` already has a clean platform seam:

```ts
function usesWin32(options?) { return (options?.platform ?? os.platform()) === 'win32'; }
function pathFor(win32) { return win32 ? path.win32 : path.posix; }
```

On macOS every path operation goes through `path.posix`, and the Windows-only checks
(reserved device names, trailing dots and spaces, alternate data streams, `\\?\` and UNC
prefixes) are correctly skipped. Nothing needs to change for separators.

Three real macOS-specific risks the seam does **not** cover:

**(a) Case sensitivity.** `foldCase()` lowercases segments only on win32:

```ts
function foldCase(segment: string, win32: boolean): string {
  return win32 ? segment.toLowerCase() : segment;
}
```

macOS APFS is **case-insensitive by default** (case-sensitive is an opt-in format). So
`/Users/x/Documents/ForgeProjecten/foo` and `/Users/x/documents/forgeprojecten/foo` are the
same directory on disk, but `assertInsideRoot` compares segments case-sensitively and would
call the second one `OUTSIDE_TRUSTED_ROOT`. The same applies to `containedPath()` in
`storage/atomic.ts`, which lowercases only on win32.

This **fails closed** — it rejects a valid path rather than accepting an invalid one — so it
is a usability bug, not a security hole. It will still bite: any path that arrives with
different casing than the stored canonical path is refused with a confusing message.

*Mitigation*: `canonicalise()` uses `fs.realpathSync.native`, and on macOS that may or may not
return the true on-disk casing. **UNVERIFIED** — this is the single most important thing to
test first, with a two-line script:

```bash
mkdir -p /tmp/CaseTest/Sub && node -e '
  const fs=require("fs");
  console.log(fs.realpathSync.native("/tmp/casetest/sub"));
'
```

If that prints `/tmp/CaseTest/Sub`, the guard is fine as written. If it prints
`/tmp/casetest/sub`, `foldCase` must fold on darwin too — and `paths.test-vectors.ts` needs a
`darwin` platform arm.

**(b) Unicode normalisation.** `inspectSlug()` normalises display names to NFKC before
slugging. HFS+ stored filenames in a decomposed (NFD-ish) form, and while APFS is
normalisation-*preserving*, `readdirSync` returns the bytes that are actually on disk. So a
project folder created as NFC `café` can come back from a directory listing as NFD `cafe´`.
`discover.ts` compares paths with `===` on non-win32:

```ts
return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
```

Two byte-different-but-identical names compare unequal, and discovery would treat a known
project as new. **UNVERIFIED** on APFS; it was definitely true on HFS+. Test with an accented
project name before trusting discovery. If it reproduces, the fix is to compare
`.normalize('NFC')` on both sides on darwin, not to change the slug rules.

**(c) `PATH_MAX`.** `MAX_PATH_LENGTH` is 4096 and `WINDOWS_MAX_PATH` (260) is advisory only.
macOS `PATH_MAX` is **1024**. A path the guard accepts at 2000 characters will fail at the
syscall with `ENAMETOOLONG`. The guard would pass it and the open would fail with an error the
user cannot act on. Add a darwin ceiling of 1024, or lower `MAX_PATH_LENGTH` globally — 4096
buys nothing here since `MAX_SLUG_LENGTH` is already 64.

### 1.4 The Documents resolution strategy

**FOUND** — `resolveProjectsRootInfo()` in `security/paths.ts`:

1. On non-win32, read `~/.config/user-dirs.dirs` **as a file** and look for
   `XDG_DOCUMENTS_DIR`. macOS does not have this file, so this returns `null` and the code
   falls through. Harmless.
2. Probe 28 localised Documents folder names under `$HOME`. macOS keeps the *physical* folder
   name as `Documents` in every locale (localisation is a `.localized` marker file the Finder
   reads), so `~/Documents` is hit on the first entry of the list. This works unchanged.
3. The OneDrive branch is win32-only and is skipped.
4. Every candidate must exist **and** resolve under the user profile
   (`isInsideRoot(dir, home)`), otherwise it is recorded in `rejectedCandidates` with the
   reason and skipped.
5. If nothing is confirmed: `source: 'fallback-unverified'`, `documentsDirExists: false`, and
   `ensureProjectsRoot()` refuses to create anything.

**The iCloud problem.** If "Desktop & Documents Folders" iCloud sync is enabled, macOS
replaces `~/Documents` with a symlink into
`~/Library/Mobile Documents/com~apple~CloudDocs/Documents`. Tracing the code: `isDirectory()`
uses `statSync`, which follows the link and returns true; `canonicalise()` resolves it;
`isInsideRoot(resolved, home)` still passes because `~/Library/...` is under the home
directory. **So the guard accepts it and every project ends up syncing to Apple's servers.**

That is a policy decision, not a bug, and it must be made deliberately:

- Leave iCloud Documents sync **off** on the Mac mini, or
- Set `FORGE_PROJECTS_ROOT` — which **does not exist yet**; there is currently no environment
  or option path to move the projects root, only the `documentsDir` test seam. Adding one is a
  small change to `resolveProjectsRootInfo()` and it should be part of the port, with the same
  "must exist and must resolve under the profile" rules.

**The TCC problem.** macOS gates `~/Documents`, `~/Desktop` and `~/Downloads` behind
Transparency, Consent and Control. A process started by launchd cannot answer a consent
prompt; it simply gets `EPERM`/`EACCES`. Tracing that through the code: `canonicalise()`
explicitly refuses to swallow it —

```ts
if (code !== 'ENOENT' && code !== 'ENOTDIR') {
  reject(`Cannot canonicalise path (${code ?? 'unknown error'}).`, absolute);
}
```

— so it fails loudly with `PATH_REJECTED`, which is the right behaviour. The operator still
has to grant the access. See the checklist in §4.

### 1.5 The MinGit fallback and git on macOS

**FOUND** — `src/bridge/projects/git.ts`:

```ts
function executableName() { return process.platform === 'win32' ? 'git.exe' : 'git'; }

function minGitFallbacks(): readonly string[] {
  if (process.platform !== 'win32') return [];   // ← nothing on macOS
  ...
}
```

The MinGit fallback exists because on this Windows machine git is a portable install at
`%LOCALAPPDATA%\Programs\MinGit\cmd\git.exe` and is **not** on a freshly-spawned process's
PATH. That was measured, not assumed. On macOS the fallback list is empty, so **git must be on
the bridge process's PATH or it is reported as absent** — with an honest `triedPaths` list, but
absent.

Two macOS specifics:

- `/usr/bin/git` exists on a stock macOS but it is a **stub**. If the Xcode Command Line Tools
  are not installed, running it pops a GUI installer dialog and returns non-zero. Under
  launchd there is no one to click it. `runGit` reads the real exit code and reports
  `ok: false`, which is correct but opaque. **Install the Command Line Tools
  (`xcode-select --install`) or Homebrew git before first run, and pin the absolute path.**
- The PATH split is already correct (`';'` on win32, `':'` otherwise), and
  `isExecutableFile()` uses `statSync().isFile()` — same missing execute-bit check as the
  Claude locator. `/usr/bin/git` is a real file, so this passes either way.

Recommendation for the port: add an explicit `FORGE_GIT_PATH` environment override mirroring
`FORGE_CLAUDE_PATH`, and set it in the plist. `locateGit()` already accepts an
`explicitPath` argument; only the env read is missing.

The subcommand allowlist, the network deny list and the `shell: false` argv discipline are all
platform-neutral and need no change.

### 1.6 Drive letters and other Windows assumptions

**FOUND**, and the news is good — there are fewer drive-letter assumptions than expected:

| Location | What it does | macOS impact |
| --- | --- | --- |
| `inspectSlug()` rejects `/^[a-z]:/i` | Refuses `C:\...` and the drive-*relative* `C:project` as display names | Still correct on macOS; a name starting `c:` is not a name anywhere. |
| `attachments/policy.ts` rejects archive entries matching `/^[A-Za-z]:/` | Zip-slip defence | Still correct. |
| `paths.test-vectors.ts` uses `C:\root` / `C:\Users\test\Documents\ForgeProjecten` | Test corpus, tagged `platform: 'win32'` | The corpus already carries a `VectorPlatform` tag with `'win32' \| 'posix' \| 'any'`, so the posix vectors run on macOS unchanged. No drive letters leak into production paths. |
| `store.ts` `WINDOWS_RESERVED` regex on ids | Rejects `con`, `nul`, `com1`… as record ids on every platform | Conservative, harmless, keep it — it means a workspace stays portable in both directions. |
| `adapter.ts` `MAX_PROMPT_CHARS = 28_000` | Sized against Windows' 32767-character `CreateProcess` limit | macOS `ARG_MAX` is far larger. The limit is conservative, not wrong. Leave it — a shared ceiling keeps behaviour identical on both hosts. |
| `paths.ts` `exceedsWindowsMaxPath()` | Advisory 260-char warning | Meaningless on macOS. Gate the UI warning on platform rather than deleting it, so a workspace moved *back* to Windows still gets it. |

No production code builds a path from a hardcoded drive letter. Project paths come from
`ProjectRecord.canonicalPath`, which is stored once at creation and only ever read back.

### 1.7 Durability and permissions

**FOUND** — `src/bridge/storage/atomic.ts` writes temp file → `fsyncSync(fd)` → `renameSync`,
then tries to fsync the containing directory and reports `directorySynced` honestly rather
than pretending.

- On macOS the directory fsync will actually **succeed**, so `directorySynced` becomes `true`
  where it is `false` on Windows. Strictly better.
- **But**: on macOS, `fsync(2)` flushes to the drive but does **not** flush the drive's own
  write cache. `F_FULLFSYNC` is required for that, and Node's `fs.fsyncSync` does not issue
  it. So the module's guarantee "the machine can lose power mid-write and we can tell damaged
  from fine" is *weaker* on macOS than the comment implies. This does not corrupt the
  all-or-nothing rename property, but a power cut can lose recently-fsynced bytes.
  **UNVERIFIED** in the sense that I did not measure it; the `F_FULLFSYNC` behaviour is
  documented Apple behaviour. Worth a line in the module comment during the port.

**FOUND** — a grep for `chmod`, `umask`, `0o600` and `0o700` across `src/` returns **nothing**.
Every file and directory the bridge creates uses the process umask. On macOS the default umask
is `022`, so `.forge-workspace/`, the event log, the audit ledger and every staged attachment
are **world-readable**. On a single-user Mac mini that is survivable; on a shared machine it
is not, and the event log contains user prose.

Fix during the port, in order of preference:

1. Set `Umask` in the launchd plist (see §3) so everything the job creates is `0700`/`0600`.
2. Pass an explicit `mode` to `ensureDir` and the atomic writers.
3. At minimum, `chmod -R go-rwx` the workspace directory after first run and document it.

---

## 2. Storage location conventions on macOS

Today, **FOUND**: the workspace directory resolves as
explicit option → `FORGE_WORKSPACE_DIR` → `<repoRoot>/.forge-workspace`. It must be absolute
and must not be a filesystem root.

`<repoRoot>/.forge-workspace` is fine for development and wrong for a hosted service — the
data lives inside a checkout that someone will eventually `git clean`. Apple's conventions:

| What | Conventional macOS location | How to set it |
| --- | --- | --- |
| Workspace data (events, records, audit, lock) | `~/Library/Application Support/ForgeWorkspace` | `FORGE_WORKSPACE_DIR` — **already supported** |
| Logs (bridge stdout/stderr) | `~/Library/Logs/ForgeWorkspace/` | launchd `StandardOutPath` / `StandardErrorPath` |
| launchd job definition | `~/Library/LaunchAgents/com.forge.workspace.bridge.plist` | see §3 |
| Projects | `~/Documents/ForgeProjecten` (unchanged) | **no override exists yet** — see §1.4 |
| Caches (nothing today) | `~/Library/Caches/ForgeWorkspace` | n/a |

Do **not** put the workspace in `~/Library/Containers/…` — the bridge is not sandboxed and
never will be while it spawns a CLI that writes arbitrary project files.

Do **not** put the workspace inside `~/Documents` or `~/Desktop`. Those are TCC-protected
(§1.4) and a background job may simply be denied. `~/Library/Application Support` is not.

---

## 3. launchd service definition

**NOT IMPLEMENTED.** This file does not exist in the repository. It is written here so the
eventual change is a review of a known design rather than an improvisation.

### 3.1 Agent, not daemon

It must be a **LaunchAgent** in `~/Library/LaunchAgents`, not a LaunchDaemon in
`/Library/LaunchDaemons`. The reasons are structural, not stylistic:

- The bridge resolves the trusted root from `os.homedir()`. A root daemon has a different home
  and would refuse to find Documents at all.
- Claude Code's authentication is per-user. A daemon running as `root` or `_forge` is not the
  authenticated user.
- The path guard's entire containment model is "under this user's profile".

### 3.2 The plist

`~/Library/LaunchAgents/com.forge.workspace.bridge.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.forge.workspace.bridge</string>

  <!-- Absolute paths only. launchd does not use a shell and does not expand ~ -->
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/USERNAME/Code/forge-workspace/src/bridge/main.ts</string>
  </array>

  <key>WorkingDirectory</key>
  <string>/Users/USERNAME/Code/forge-workspace</string>

  <key>EnvironmentVariables</key>
  <dict>
    <!-- launchd supplies a minimal PATH; name every tool explicitly instead. -->
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>FORGE_CLAUDE_PATH</key>
    <string>/Users/USERNAME/.local/bin/claude</string>
    <key>FORGE_WORKSPACE_DIR</key>
    <string>/Users/USERNAME/Library/Application Support/ForgeWorkspace</string>
    <key>FORGE_BRIDGE_PORT</key>
    <string>4517</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <!-- Restart only on an abnormal exit. Exit 2 (config refused) and exit 3
       (lock unavailable) are deliberate refusals; restarting them in a loop
       turns a clear message into a log flood. See §3.3. -->
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <key>ThrottleInterval</key>
  <integer>30</integer>

  <key>ProcessType</key>
  <string>Background</string>

  <!-- 0o077 in decimal. Without this, the event log and audit ledger are
       world-readable under the default 022 umask. -->
  <key>Umask</key>
  <integer>63</integer>

  <key>StandardOutPath</key>
  <string>/Users/USERNAME/Library/Logs/ForgeWorkspace/bridge.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/USERNAME/Library/Logs/ForgeWorkspace/bridge.err.log</string>
</dict>
</plist>
```

Notes tied to code that already exists:

- `StandardOutPath` and `StandardErrorPath` are separate on purpose. **FOUND**: `main.ts`
  sends every human-readable line to **stderr** and exactly one machine-readable JSON line to
  **stdout** (`{"event":"bridge.ready",…}` and `{"event":"bridge.shutdown",…}`). Keeping them
  apart means `bridge.out.log` is a parseable ndjson lifecycle log and `bridge.err.log` is the
  narrative. Do not merge them.
- `--port` can be passed in `ProgramArguments` instead of `FORGE_BRIDGE_PORT`; both are
  supported and both are range-checked.
- Do **not** put any of `FORGE_BRIDGE_BIND`, `FORGE_BRIDGE_HOST`, `FORGE_BRIDGE_LAN`,
  `FORGE_BRIDGE_REMOTE`, `FORGE_BRIDGE_TUNNEL` or their siblings in `EnvironmentVariables`.
  **FOUND**: `loadConfig()` refuses to produce a config at all if any of the eleven frozen
  names is merely *present*, and the bridge exits 2 before a socket exists. That is the
  designed behaviour, not a bug to work around.

### 3.3 Restart semantics and the exit codes

**FOUND** — `main.ts` exit codes: `0` clean · `2` configuration refused · `3` workspace lock
unavailable · `4` could not listen · `5` unexpected failure.

`KeepAlive: { SuccessfulExit: false }` restarts on any non-zero exit, which includes 2 and 3.
That is wrong for both:

- **exit 2** means someone put a frozen environment variable in the plist. Restarting cannot
  fix it and will write the refusal message to the log forever.
- **exit 3** means another bridge holds the workspace lock. Restarting races the other
  instance.

`ThrottleInterval: 30` limits the damage to two lines a minute, which is tolerable but not
right. The clean solution is a small wrapper that maps 2 and 3 to exit 0 (so launchd treats
them as a deliberate stop) while leaving 4 and 5 restartable. **NOT IMPLEMENTED** — decide
during the port whether to add the wrapper or accept the throttled loop.

### 3.4 Launch on boot — the honest position

Loading and starting:

```bash
mkdir -p ~/Library/Logs/ForgeWorkspace
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.forge.workspace.bridge.plist
launchctl kickstart -p gui/$(id -u)/com.forge.workspace.bridge
launchctl print gui/$(id -u)/com.forge.workspace.bridge     # state, last exit, env
```

Unloading:

```bash
launchctl bootout gui/$(id -u)/com.forge.workspace.bridge
```

A `gui/<uid>` agent runs when the user is logged into the GUI. For a headless Mac mini that
means one of:

1. **Enable automatic login** for the user. Simplest, and it also unlocks the login keychain
   at boot, which is likely what Claude Code's stored credentials need. Cost: anyone with
   physical access gets a logged-in session, and FileVault plus auto-login interact in ways
   that must be checked.
2. **Keep FileVault on and log in once after each reboot.** Safest, and it makes the machine
   not truly unattended.
3. `LimitLoadToSessionType: Background` to load in the user's pre-login background session.
   **UNVERIFIED** — I did not test whether Claude Code can authenticate from a background
   session with a locked login keychain. My expectation is that it cannot, and that this
   option therefore does not work for this application, but that is an expectation and not a
   measurement.

**This is the single biggest unknown in the whole migration.** Before committing to a launchd
design, run the experiment: reboot without logging in, have a trivial LaunchAgent execute
`claude -p 'Reply with exactly: FORGE_HEALTH_OK' --output-format json`, and read the exit code
and the envelope. The bridge already has exactly this probe implemented in
`healthCheck()` — `src/bridge/claude/locate.ts` — including the rule that `authenticated:
true` requires exit 0 **and** `is_error: false` **and** a session id. Reuse it rather than
writing a new one.

---

## 4. File permissions and privacy prompts

| Concern | What happens | Action |
| --- | --- | --- |
| Default umask | 022 → workspace is world-readable | `Umask` 63 in the plist (§3.2) and/or explicit modes in `atomic.ts` |
| `~/Documents` access (TCC) | A launchd job is denied without consent; `canonicalise()` raises `PATH_REJECTED` with the errno | System Settings → Privacy & Security → **Files and Folders**, grant the *node binary* Documents access. If that is not offered for a launchd job, grant **Full Disk Access** to the node binary instead. **UNVERIFIED** which of the two the target macOS version requires. |
| Gatekeeper / quarantine | Files copied from another Mac carry `com.apple.quarantine`; a quarantined `node` may be blocked | `xattr -dr com.apple.quarantine <path>` on the transferred tree, deliberately and only after checking provenance |
| Keychain | See §3.4 | Test before committing to unattended boot |
| `~/Library/Application Support/ForgeWorkspace` | Not TCC-protected | No prompt expected |

The bridge's own defence in depth is unchanged by any of this: the path guard still refuses
anything outside the trusted root, `describeSensitivePath()` still forces an owner approval for
`.env*`, `.ssh`, `id_ed25519`, `*.pem` and friends, and the git wrapper still cannot reach a
network verb.

---

## 5. Project transfer and backup export

### 5.1 What moves and what must not be copied verbatim

| Item | Move it? | Why |
| --- | --- | --- |
| Project folders under `Documents\ForgeProjecten\` | **Yes** | Each carries `.forge/project.json` — the marker that makes a move survivable. See §5.2. |
| `.forge-workspace/events/*.jsonl` | Yes | Append-only, UTF-8, platform-neutral content. |
| `.forge-workspace/records/**/*.json` | **Yes, but rewrite paths** | `ProjectRecord.canonicalPath` and `relativePath` hold Windows absolute paths. See §5.2. |
| `.forge-workspace/audit/ledger.jsonl` | Yes | Ids and counts only; no paths. |
| `.forge-workspace/bridge.lock` | **No** | Holds a Windows pid. Delete it; the store re-creates it. |
| `.forge-workspace/meta/*.json` | Yes | Layout and migration state. |
| `node_modules/` | **No** | Reinstall from `package-lock.json`; native optional deps differ by platform. |
| `dist/`, `test-results/`, `playwright-report/` | No | Reproducible. |
| Per-run evidence dirs (stdout/stderr/exit captures) | Yes | Referenced by `evidenceRefs`. Large; consider archiving cold runs instead. |

### 5.2 Re-homing projects — do not hand-edit the JSON

**FOUND** — `projects/discover.ts` and `projects/registry.ts` are built for exactly this:

- Every project created by `create.ts` gets a marker at `<project>/.forge/project.json`
  carrying the id that was generated for it (`MARKER_DIRECTORY_NAME = '.forge'`,
  `MARKER_FILENAME = 'project.json'`).
- Discovery matches on two stable keys, in order: **the marker id**, then the canonical path.
- "A moved project is followed, not re-created." When a folder turns up somewhere else under
  the root carrying a marker the registry already knows, the record's path is **updated**.
- "A vanished project is marked, never deleted." A record whose path is empty becomes
  `MISSING` and stays. A folder can be absent because a volume is not mounted or a backup tool
  moved it; deleting the only thing that knows the project's id, conversations and runs turns
  a recoverable situation into a permanent one.
- Registry ids are `crypto.randomUUID` and are **never** derived from a name, slug or path, so
  a re-home does not orphan history.
- The marker is validated: it must carry an id of the shape this system generates, plus a slug
  and a display name. A hand-edited marker cannot smuggle in an arbitrary id.

**Therefore the migration procedure is: copy the project folders under the new
`ForgeProjecten`, copy the workspace records, start the bridge, and let discovery re-home
them.** Do not rewrite `canonicalPath` by hand. If discovery is not yet wired
(see [`architecture.md`](./architecture.md) §7 — `listProjects` and friends have no handler in
this build), then **do not migrate records at all yet**: migrate only the project folders, and
let the registry be rebuilt from the markers once discovery is registered.

### 5.3 Copying

Use `ditto`, not `cp -r`. `ditto` preserves extended attributes, ACLs and resource forks, and
it handles the Windows-to-Mac direction predictably when the source has been staged locally:

```bash
ditto --noqtn /Volumes/Transfer/ForgeProjecten ~/Documents/ForgeProjecten
```

If the transfer is over the network from the Windows machine, `rsync -av --no-perms` into a
staging directory first, then `ditto` into place, so a partial transfer never lands in the
trusted root.

Things to check after copying:

- **Line endings.** If the Windows checkouts were made with `core.autocrlf=true`, working
  trees contain CRLF. `git status` on macOS will show every file as modified. Decide per repo:
  either `git add --renormalize .` or set `core.autocrlf=input` and re-checkout.
- **Case collisions.** Two files differing only in case cannot coexist on a default APFS
  volume. NTFS is also case-insensitive, so this only bites for repos that were cloned from a
  case-sensitive Linux host. `git ls-files | sort -f | uniq -Di` finds them before the copy.
- **Quarantine.** `xattr -r -d com.apple.quarantine ~/Documents/ForgeProjecten` if Gatekeeper
  starts objecting, and only after you are satisfied where the files came from.
- **Symlinks.** Any Windows junction in a project tree becomes a broken link. The path guard
  will refuse anything that resolves outside the root, which is correct, but the error will be
  confusing until the link is fixed.

### 5.4 Backup export

There is a `createCheckpoint` / `listCheckpoints` pair already registered on the router
(**FOUND** — two of the seven working operations), and it reports `complete: false` when it
could not read every in-scope record, which is passed through unchanged so a partial
checkpoint is never presented as a full one. That is a snapshot of the *workspace*, not of the
projects.

A full export is therefore two things, and the checklist should treat them separately:

```bash
# 1. Workspace state, quiesced. The lock means the bridge must be stopped.
launchctl bootout gui/$(id -u)/com.forge.workspace.bridge
tar --disable-copyfile -czf ~/Backups/forge-workspace-$(date +%Y%m%d-%H%M%S).tar.gz \
    -C ~/Library/Application\ Support ForgeWorkspace
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.forge.workspace.bridge.plist

# 2. Projects, which are ordinary git repositories plus their markers.
tar --disable-copyfile -czf ~/Backups/forge-projects-$(date +%Y%m%d-%H%M%S).tar.gz \
    -C ~/Documents ForgeProjecten

shasum -a 256 ~/Backups/forge-*.tar.gz > ~/Backups/manifest-$(date +%Y%m%d).txt
```

`--disable-copyfile` stops bsdtar writing `._` AppleDouble files into the archive, which
otherwise appear as junk on any non-Mac host and, worse, as extra entries the attachment
policy would have to reason about.

**Take the backup with the bridge stopped.** The workspace lock exists precisely because
concurrent writers corrupt a JSONL log; a `tar` of a live event stream can capture a
half-written final line. `readJsonlSafe` handles that (it reports the damage rather than
throwing), but a backup that is knowingly torn is a worse backup than one taken 30 seconds
later.

---

## 6. The migration checklist

Ordered so that each step can be verified before the next depends on it. Nothing here has been
executed.

### Phase 0 — before touching the Mac

- [ ] Read [`architecture.md`](./architecture.md) §7 and **re-run the two probe commands at
      the top of it**. The count was 7/39 at 03:28Z and 22/39 at 03:40Z on 2026-07-24; it is
      moving. What matters for this migration is specifically whether **`sendMessage` and
      `stopRun`** are registered. While they are not, the bridge cannot start or stop a Claude
      Code run at all, §1.1 cannot be tested end to end, and Phase 6 is not executable — so
      defer the whole migration rather than half-verify it.
- [ ] Take a full Windows-side backup and record its SHA-256.
- [ ] `git status` clean; tag the commit you are migrating.

### Phase 1 — prove the host

- [ ] Install Node 24. Record `node --version`; it must be a version that executes TypeScript
      directly, because there is no build step for the bridge and no transpiled copy.
- [ ] `xcode-select --install` (or install git via Homebrew). Record `git --version` and the
      absolute path.
- [ ] Install Claude Code. Record the absolute path and `claude --version`.
- [ ] Run `claude -p 'Reply with exactly: FORGE_HEALTH_OK' --output-format json` **as the
      target user, from a normal terminal**. Record exit code, `is_error`, `session_id`.
- [ ] Run the same command **from a trivial LaunchAgent after a reboot with no GUI login**.
      Record the result. This answers §3.4 and decides the whole boot strategy.

### Phase 2 — prove the code on this host

- [ ] Clone the repository, `npm ci`.
- [ ] `npx tsc --noEmit` — record the real output.
- [ ] `npm run test` — record pass/fail counts, not a verdict.
- [ ] Run the case-sensitivity probe from §1.3(a). Record what `realpathSync.native` returns.
- [ ] Create a project folder with an accented name and `readdirSync` it. Record whether the
      bytes come back NFC or NFD (§1.3(b)).
- [ ] Fix `foldCase`, `containedPath` and the discovery comparison for darwin if either probe
      says they are needed. Add darwin vectors to `paths.test-vectors.ts`.
- [ ] Add the darwin `PATH_MAX` ceiling (§1.3(c)).
- [ ] Add `FORGE_GIT_PATH` (§1.5) and a projects-root override (§1.4), both with the same
      "must exist, must resolve under the profile" rules the existing resolution uses.
- [ ] Add explicit file modes or confirm the plist `Umask` covers everything (§1.7).

### Phase 3 — prove the bridge

- [ ] `FORGE_WORKSPACE_DIR=~/Library/Application\ Support/ForgeWorkspace node src/bridge/main.ts --print-config`
      — confirm `bindAddress` is `127.0.0.1`, `lanMode` and `remoteAccess` are `false`.
- [ ] Start it in the foreground. Record the `[bridge]` startup block verbatim, including the
      `operations N/39 registered` line and the `NOT YET IMPLEMENTED` list.
- [ ] `node src/bridge/main.ts --health` — confirm `verdict: HEALTHY`, and read the `degraded`
      array rather than only the `ok` boolean.
- [ ] Confirm `projectsRoot` in the health output points where you expect and that
      `documentsDirExists` is `true`. If it is `false`, read `rejectedCandidates` — it names
      the reason.
- [ ] Confirm nothing is listening on any interface but loopback:
      `lsof -nP -iTCP:4517 -sTCP:LISTEN` must show `127.0.0.1:4517` and nothing else.
- [ ] Confirm the frozen variables still refuse: `FORGE_BRIDGE_HOST=0.0.0.0 node src/bridge/main.ts`
      must exit **2** with the refusal message. If it starts, stop the migration.

### Phase 4 — move the data

- [ ] Stop the bridge. Delete any copied `bridge.lock`.
- [ ] Stage the transfer, then `ditto` into `~/Documents/ForgeProjecten` (§5.3).
- [ ] Fix line endings and case collisions per §5.3.
- [ ] Confirm each project still has `.forge/project.json` and that the id inside it matches
      the record it belongs to.
- [ ] Start the bridge, run discovery, and confirm each project is **re-homed, not
      re-created** — the record id must be unchanged and the path must be the new one.
- [ ] Confirm no project ended up `MISSING`. If one did, its folder is not under the root or
      the marker did not survive the copy.

### Phase 5 — make it a service

- [ ] Write the plist (§3.2) with absolute paths and no frozen variables.
- [ ] `mkdir -p ~/Library/Logs/ForgeWorkspace`.
- [ ] `launchctl bootstrap gui/$(id -u) …`, then `launchctl print …` and read `last exit code`.
- [ ] Confirm `bridge.out.log` contains exactly one `{"event":"bridge.ready",…}` line per start
      and `bridge.err.log` contains the narrative. If they are interleaved, the plist merged
      the streams.
- [ ] Reboot. Confirm the bridge comes up, the lock is taken, and reconciliation reports
      whatever it reports — the number is the evidence, whatever it is.
- [ ] `launchctl bootout`, confirm a clean shutdown report with `lockReleased: true`.
- [ ] Grant TCC access if `~/Documents` operations fail with `PATH_REJECTED` (§4).
- [ ] Verify permissions: `ls -la ~/Library/Application\ Support/ForgeWorkspace` — nothing
      should be group- or world-readable.

### Phase 6 — prove it end to end

- [ ] Create a project through the bridge. Confirm the folder, the marker and the git repo on
      `main`.
- [ ] Send one real message. Confirm a session id, streamed output, and a `COMPLETED` run that
      passed through `VERIFYING` and `REVIEWING`.
- [ ] Cancel a run mid-flight. Confirm the process **group** died, that `exitObserved` is true,
      and that the result detail names the signal actually delivered.
- [ ] Kill the bridge with `SIGKILL` while a run is live, restart, and confirm the run is
      reconciled to `INTERRUPTED` or `ORPHANED` and **never** to `COMPLETED`.
- [ ] Take a backup per §5.4 and restore it into a scratch directory. A backup that has not
      been restored once is not a backup.

---

## 7. What this document does not cover

- **Remote access of any kind.** The Mac mini is still a loopback-only host. Reaching it from
  another device is [`lan-mode-design.md`](./lan-mode-design.md), which is a design, not a
  plan, and is gated on a separate approval.
- **Apple Silicon vs Intel.** Nothing in the bridge is architecture-sensitive (no native
  modules; `ws` is pure JavaScript), but the Node and Claude Code installs obviously are.
- **Multi-user hosting.** One user, one home directory, one trusted root. Everything from the
  path guard's containment model to the workspace lock assumes it.
- **Time Machine.** Excluding or including `~/Library/Application Support/ForgeWorkspace` and
  `~/Documents/ForgeProjecten` is a decision, and a live event log in a Time Machine snapshot
  has the same torn-write caveat as §5.4.
