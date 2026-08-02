# LAN mode — what it would require, and why it is off

Status: **DESIGN ONLY. NOT IMPLEMENTED. NOT APPROVED.**

`LAN_MODE = false` and `REMOTE_ACCESS = false` in `src/bridge/config.ts`. Both are `const`
declarations with no environment path into them. `INVARIANT_DECLARATIONS.LAN_MODE` and
`INVARIANT_DECLARATIONS.REMOTE_ACCESS` in `src/shared/protocol.ts` are `false` to match, and
`INVARIANT_DECLARATION_PROOFS` names the test that proves each — for `LAN_MODE`, *"LAN mode is
a compile-time false with no environment path into it"*. This document does not change any of
that and must not be read as a plan to.

It exists so that if LAN access is ever wanted, the change is a **review of a written design**
rather than an improvisation under time pressure. Every section ends in something that would
have to be **built and independently reviewed**, and §12 collects them into a single gate.

`src/bridge/config.ts` already carries a seven-point `FUTURE_LAN_DESIGN` comment block. This
document is the long form of it and does not contradict it; where the two differ in detail,
the code comment is the one under version control next to the constant it guards, and it wins.

See [`architecture.md`](./architecture.md) for what exists today, including the trust
boundaries this document is about to remove.

---

## 1. The one sentence that matters

**The Forge bridge has no authentication.**

Not weak authentication. None. There is no credential, no token, no session, no user. Any
process that can open a TCP connection to the listener can POST to `/api/operation` and, once
the remaining operations are wired, can create projects, read project files, stage
attachments, run approved tests and spawn Claude Code with a prompt of its choosing.

This is **safe today and only today**, for one reason: the socket is bound to `127.0.0.1`.
Anything that can reach it is already running as this user on this machine, and such a process
could do everything the bridge can do without going near the bridge. The absence of
authentication costs nothing because there is no privilege to gain.

That reasoning collapses entirely the moment the socket leaves the machine. Every other
section of this document is a consequence of that single sentence.

---

## 2. What actually changes when the socket leaves the machine

| Property | Loopback today | On a LAN |
| --- | --- | --- |
| Who can connect | Processes running as this user | Every device on the subnet, including guests, IoT devices, and anything that joined the wifi |
| What a connection proves | The peer is already this user | Nothing at all |
| Origin header | Reliable from browsers, absent from local tools | Trivially forged by any non-browser client |
| Confidentiality | The kernel loopback interface never touches a wire | Plaintext frames on shared media; prompts, file contents and project paths are readable by anyone on the segment |
| Integrity | No path for a man in the middle | ARP spoofing, rogue AP, hostile switch port |
| Consequence of a bug in the path guard | A local process escalates to something it already had | A stranger reads `~/.ssh` |
| Consequence of an unauthenticated write | A local process writes files it could already write | A stranger writes files into the user's Documents and runs a CLI as the user |
| Denial of service | A local process could already kill the bridge | A remote peer can exhaust the workspace, the disk and the token budget |
| Audit meaning | "This machine did it" | "Somebody did it" — and nothing records who |

The last row is the one that is easiest to underweight. Today's audit ledger is honest and
complete for what it claims: it records `requestId`, `op`, `projectId`, `clientId`, transport,
outcome, error code and duration. But `clientId` is a `randomUUID()` minted per WebSocket
connection (`server.ts`, `attachSocket`) and is `null` for every HTTP request. **There is no
principal in the ledger, because today there is only one possible principal.** On a LAN the
ledger would answer "what was asked of this bridge" while being structurally incapable of
answering "by whom", which is the only question that matters after an incident.

---

## 3. Threat model on a private LAN

Assume: a home or small-office network, WPA2/WPA3, one router, a printer, some phones, a smart
TV, possibly a guest network that is not as separate as everyone believes.

**T1 — A compromised device on the same subnet.** The realistic one. A phone with a malicious
app, a laptop with a browser extension, an IoT device with a five-year-old firmware. It scans
the /24, finds `4517`, and speaks the protocol. With no authentication it has the full
operation surface. *Mitigated by: authentication, per-client authorisation, rate limiting.*

**T2 — A guest.** Someone the owner deliberately let onto the wifi. Not hostile, but not
trusted with the contents of `~/Documents` either. *Mitigated by: authentication, network
segmentation, an explicit device allowlist.*

**T3 — Passive interception.** Plaintext HTTP and WebSocket frames carry the user's prompts,
Claude's replies, file diffs, project paths and attachment previews. On wifi with a shared
PSK, or on any hub-like segment, this is a read of everything the workspace does.
*Mitigated by: TLS, and only TLS.*

**T4 — Active interception.** ARP spoofing or a rogue AP puts an attacker between the browser
and the bridge. Without TLS they can rewrite a `sendMessage` payload, inject an
`approveAction`, or replay a `runApprovedTest`. *Mitigated by: TLS with a pinned certificate,
plus request-level integrity.*

**T5 — A hostile web page, from a browser on the LAN.** The current Origin check assumes
browsers. It is a genuinely good check *against browsers* — `isLocalOrigin()` rejects `null`
origins, rejects anything with a path, query, fragment or credentials in the header, and
compares the parsed hostname rather than a substring so `localhost.attacker.com` fails. But it
is worthless against a non-browser client, which simply sends whatever Origin string it likes.
Today that does not matter, because a non-browser client on loopback is already the user. On a
LAN it is the primary attacker. *Mitigated by: authentication. The Origin check stays, but it
stops being sufficient.*

**T6 — DNS rebinding, widened.** `isLocalHostHeader()` currently requires the Host header to
name `127.0.0.1`/`localhost`/`::1` **and** carry the exact bound port. That is a strong
rebinding defence precisely because the expected Host is a fixed literal. A LAN bridge has to
accept a Host that is a routable address or an mDNS name, which is a much weaker predicate and
is exactly the shape rebinding attacks like. *Mitigated by: an exact-match Host allowlist
derived from the bound address, plus TLS, plus authentication.*

**T7 — Resource exhaustion.** There is no rate limiting anywhere in the bridge and no
connection cap. A single peer can open sockets until the process runs out of descriptors, or
issue operations until the disk fills with event log lines and audit entries, or (once
`sendMessage` is wired) burn the owner's entire Claude subscription in an afternoon.
*Mitigated by: per-client rate limits, a connection cap, and a per-client spend/turn budget.*

**T8 — The bridge as a lateral-movement pivot.** The bridge spawns a CLI that can write
arbitrary files and run tests inside project directories. An attacker who reaches the
operation surface does not need a memory-safety bug; the surface *is* the capability.
*Mitigated by: shrinking the operation set on non-loopback connections, and by making every
dangerous verb require an approval that is answered on the host machine.*

**Out of scope for LAN mode entirely**: an attacker with local access to the Mac mini or the
Windows host, and anything on the public internet. The second of those is `REMOTE_ACCESS`,
which has no design here on purpose — see §11.

---

## 4. Authentication

Nothing exists. This is the largest single piece of work and everything else depends on it.

### 4.1 Why not a shared bearer token

The obvious answer is one secret in a config file that every device sends. It is the wrong
answer, for reasons that are structural rather than aesthetic:

- **It cannot be revoked.** Revoking it revokes every device at once, including the owner's.
- **It cannot be attributed.** Every ledger line says "the token", which is exactly the gap
  §2 identified.
- **It leaks by design.** It has to be typed into, pasted into, or stored on every device that
  uses it. It ends up in a note, a screenshot, a clipboard history, a shell profile.
- **It has no lifetime.** A device lost in 2027 still holds a credential minted in 2026.

`FUTURE_LAN_DESIGN` point 4 already says this: authentication must be **per-client, not a
shared bearer token**. That is the requirement, not a preference.

### 4.2 The shape that would be reviewable

A pairing model, because it is the only one that gives revocation and attribution without
standing up an identity provider on a Mac mini:

1. **Enrolment happens at the host, physically.** The owner runs a pairing command on the
   machine itself. It prints a short code with a short lifetime (say 120 seconds) and a single
   use. There is no remote self-enrolment, ever.
2. **The device generates its own keypair** and sends the public half with the pairing code
   over the already-TLS'd channel. The private key never leaves the device.
3. **The bridge stores a `ClientRecord`**: an id, a display name the owner typed, the public
   key, the enrolment timestamp, a capability set, and a revocation field. Stored as an
   ordinary record kind alongside `project`, `run` and the rest, so it inherits the atomic
   write, the workspace lock and the crash reconciliation the store already provides.
4. **Every request is authenticated per request**, not per connection: a signature over
   (method, path, body hash, timestamp, nonce) with a small clock skew window and a replay
   cache keyed on the nonce. Per-connection authentication is not enough on a channel a
   proxy can splice.
5. **Revocation is immediate and is an operation the owner performs on the host**, never over
   the network. A revoked client's next request fails closed, and its open sockets are closed.
6. **The audit ledger gains a `clientRecordId` field** and it is non-null for every
   non-loopback request. A request that cannot be attributed is refused before it reaches a
   handler.

### 4.3 What loopback keeps

A loopback connection stays unauthenticated. It is the same trust argument as today, it keeps
the local development loop working, and it means the authentication path is additive rather
than a rewrite. The distinction is drawn from the *socket*, `req.socket.remoteAddress`, never
from a header — a header-derived "I am local" claim is a forgery waiting to happen.

**Must be built:** `ClientRecord` kind, pairing operation, per-request signature verification,
replay cache, revocation, ledger principal field, and a UI on the host that shows every paired
device and lets the owner revoke one.

---

## 5. TLS

Over loopback a plaintext socket cannot leave the machine. Over a LAN it is on the wire. TLS
becomes **mandatory**, not recommended, and there is no configuration in which LAN mode may
serve plaintext.

The awkward part is not the TLS itself, it is the trust decision:

- **A self-signed certificate** means the browser shows a warning the user must click through.
  Training a user to click through certificate warnings destroys the only signal that would
  tell them about T4. Unacceptable on its own.
- **A local CA** (mkcert-style) means installing a root certificate into the system trust
  store of every device. That is a large, durable capability to hand to a workspace tool, and
  a compromise of the CA key is a compromise of every TLS connection that device makes to
  anything.
- **A real certificate** requires a real domain and either DNS-01 or a reachable port 80,
  which drags in either public DNS records naming an internal host or public reachability.
  Both are worse than what they solve.

The least-bad shape, and the one that would have to be reviewed:

- The bridge generates a long-lived self-signed certificate on first LAN start, stores the key
  with `0600` permissions in the workspace directory, and **prints the SHA-256 fingerprint** at
  startup and in `--print-config`.
- The pairing flow (§4.2) carries the expected fingerprint in the pairing payload, and the
  client **pins** it. A pinned self-signed certificate is strictly stronger than a CA-issued
  one for a fixed pair of endpoints.
- The UI displays the fingerprint permanently, not just at enrolment, so a change is visible.
- Certificate rotation is an explicit owner action that re-pairs, not a silent renewal.

`FUTURE_LAN_DESIGN` point 3 already states the requirement: TLS mandatory, which means a
certificate, which means a trust decision, which means the UI must show the fingerprint.

**Must be built:** key/cert generation and storage, `https.createServer` and `wss` paths,
fingerprint display, fingerprint pinning in the client, rotation flow, and a hard refusal to
start LAN mode without a certificate.

---

## 6. Origin, Host and CSRF

The existing checks are good and stay. They stop being sufficient.

**Origin.** `isLocalOrigin()` and the exact-match allowlist keep doing their job against
browsers. On LAN the allowlist has to include the LAN origin, which means it can no longer be
computed from a hardcoded loopback list. Two rules would need to hold:

- The allowlist is still **exact strings**, never a wildcard, never a suffix match, never a
  regex. `Access-Control-Allow-Origin: *` must remain impossible to reach.
- Adding a LAN origin is a **code or owner-approved config change**, not an environment
  variable. `FORGE_BRIDGE_EXTRA_ORIGINS` today is additive-only and every entry must itself
  pass `isLocalOrigin()`; that guard must not be relaxed to admit LAN hosts, or the same
  variable becomes a remote-widening back door on a loopback build.

**Host.** `isLocalHostHeader()` must become "matches the address this server actually bound,
or an explicitly enrolled hostname, and carries the bound port". Derived from
`server.address()`, which the server already records as `boundAddress`/`boundPort` and already
treats as the only evidence of where it is listening. Never derived from a configured
*intention*.

**CSRF.** Today the answer is "the Origin check, plus there is nothing to steal" — the bridge
has no cookies and no ambient credential, so a cross-site request carries no authority. That
is stated explicitly in `corsHeaders()`, which never sets
`Access-Control-Allow-Credentials`.

Introducing authentication (§4) could destroy that property overnight if the credential were
ambient. So the rule is: **the LAN credential must never be a cookie and must never be
automatically attached by the browser.** It is a signature the client computes and places in a
header. A cross-site page cannot compute it, because it cannot read the private key. This is
not a nice-to-have; it is what keeps CSRF from becoming a live class of attack the moment
authentication is added.

**Must be built:** bound-address-derived Host predicate, LAN origin enrolment that cannot be
set by environment, and a written argument (reviewed) that the credential is non-ambient.

---

## 7. Per-session isolation

Today there is one user, one workspace, one lock, one trusted root, and `clientId` exists only
so the transport can route frames and count connections. Nothing is isolated because nothing
needs to be.

On a LAN, "which device asked" becomes a security-relevant fact, and several things that are
currently global become per-client:

- **Subscriptions.** A client subscribing to `*` (`ALL_STREAMS`) currently receives every
  event on every stream in the workspace. On a LAN that must be an authorised capability, not
  a default. A device paired to read one project must not receive another project's
  `claude.message` deltas.
- **Event visibility.** `listEvents` and `replayEvents` accept a `projectId` filter but do not
  *require* one and do not check authority over it. They would need an authorisation check
  against the client's capability set, applied in the store query rather than as a filter on
  the way out.
- **Idempotency cache.** Keyed on `requestId` alone. Two clients can collide, and a collision
  currently returns the *other* client's response. That is an information leak the moment
  there is more than one principal. The key must become `(clientRecordId, requestId)`.
- **Approvals.** `approveAction` / `denyAction` decide whether a dangerous thing happens.
  These must be **owner-only and host-only**. A paired device must not be able to approve its
  own request. This is the same self-approval principle already enforced for verification in
  `isSelfApproval()`, applied to a different domain.
- **Run ownership.** `stopRun` must be scoped: a client may stop runs it started, and the
  owner may stop anything.

**Must be built:** a capability set on `ClientRecord`, authorisation checks inside the store
queries, per-client idempotency keys, per-client subscription authorisation, and an
owner-only class of operation.

---

## 8. Rate limiting and quotas

There is none today. The bridge has bounds on *sizes* (1 MiB request body, 1 MiB WebSocket
payload, 8 MiB stderr capture, 512 cached responses, 512 subscriptions per client, 5000 events
per replay) and on *time* (10 s headers, 30 s request, 5 s keep-alive), but nothing bounds the
*rate* at which a peer may ask for things, and nothing caps the number of connections.

`FUTURE_LAN_DESIGN` point 6 states the requirement: per-client rate limiting and a connection
cap become required, because the set of possible clients stops being "processes the user
already trusts on their own machine".

What would need bounding, and why each one specifically:

| Bound | Why |
| --- | --- |
| Connections per client record, and total | File descriptor exhaustion; the transport already tracks connected clients but never refuses one |
| Operations per second per client, with burst | The audit ledger is an append per dispatch; an unthrottled client fills the disk with its own audit trail |
| `sendMessage` per hour per client, plus a token/cost budget | The expensive one. A run spawns a CLI against the owner's subscription. `usage/aggregator.ts` already produces EXACT token and cost figures from the result envelope — those are the numbers a budget should be enforced against, not an estimate |
| Concurrent runs per client, and total | Each run is a child process tree |
| `stageAttachment` bytes per hour per client | Disk |
| `replayEvents` per minute per client | Each replay is a full JSONL read |
| Failed-authentication attempts per source address | Pairing-code brute force |

Rate limit state has to survive nothing — in-memory is fine, because a restart is not an
attacker-controlled event. Rejections should use the existing `QUOTA_EXCEEDED` error code,
which is already in `OperationErrorCode` and already carries a precedent:
`attachments/policy.ts` returns it when every rejection finding is a quota rule rather than a
content rule, and `operations/attachments.ts` uses it for the in-flight upload buffer. Reuse
that meaning — "you asked for something legitimate, but too much of it" — rather than minting
a new code.

**Must be built:** all of the above, plus a decision on whether a rate-limited client is told
its limit (helpful, and an information leak) or simply refused.

---

## 9. Firewall scope, hostname and discovery

**Bind address.** `FUTURE_LAN_DESIGN` point 2 is unambiguous and must be kept: the bind
address stays a **fixed allowlist, never `0.0.0.0`**. The operator names one interface address;
the server enumerates the machine's interfaces and **refuses to bind an address it cannot
find**, so a typo fails closed instead of falling back to "everything". `0.0.0.0` would put the
bridge on every interface including any VPN or hotspot the machine later joins.

**Firewall.** Binding one interface is not a firewall. On macOS the application firewall is
per-application and does not do per-subnet rules; `pf` does. The scope that would need writing
and reviewing:

- Inbound on the bridge port: allow **only** the LAN subnet, and preferably only the specific
  addresses of paired devices. Deny everything else.
- Explicitly deny the port on any VPN, tunnel or hotspot interface.
- A rule that survives reboot, and a documented way to verify it
  (`sudo pfctl -sr`, plus an actual connection attempt from an unpaired device).

**Hostname and mDNS.** A LAN bridge needs to be reachable by name, and `hostname.local` via
Bonjour is the obvious mechanism. It is also an **advertisement**: mDNS broadcasts the
service, its port and its instance name to the entire segment, including to whatever is
listening. Requirements:

- Advertising is **opt-in and separate** from enabling LAN mode. LAN mode without discovery
  must be a supported configuration.
- The advertised TXT record carries no version, no path, no workspace name, and nothing that
  helps fingerprint the install.
- The Host header check (§6) must accept the mDNS name only if it was explicitly enrolled, not
  merely because it resolves.

**Must be built:** interface enumeration with fail-closed binding, a written and tested
firewall ruleset, an opt-in discovery switch, and a documented verification that an unpaired
device on the subnet is refused.

---

## 10. Audit logging and remote shutdown

### 10.1 Audit

The ledger today is genuinely good: append-only, control characters stripped from
client-supplied fields so a newline cannot forge a line, write failures counted and surfaced
as `bridge.degraded` rather than silently swallowed, and payloads deliberately excluded
because they carry user prose and could carry a secret.

For LAN it needs four additions:

1. **A principal.** `clientRecordId`, non-null for every non-loopback request. Already argued
   in §2.
2. **A source address**, recorded as a field, so a compromised device is identifiable even
   before it is attributed.
3. **Authentication outcomes**, including failures. Today the ledger records `REJECTED` for
   protocol-level refusals; an auth failure is a different and more interesting event.
4. **Tamper evidence.** An append-only file on the same machine that the operations run on is
   evidence right up until the attacker gets write access. A hash chain (each line carrying
   the hash of the previous) makes truncation and edits detectable, which is a meaningful
   improvement for a modest cost. Full tamper-*proofing* requires off-machine shipping, which
   is a different project and should not be claimed.

The health and declarations endpoints are deliberately exempt from the ledger today, on the
stated grounds that an audit trail that is 99% health probes is one nobody reads. That
reasoning still holds on a LAN **only if** those endpoints remain incapable of revealing
anything. They do not. An unauthenticated `GET /api/health` currently returns, among other
things:

- the absolute projects root and Documents paths, inside `EvidenceRef`s on the derived
  declarations — e.g. `"ref": "C:\\Users\\faitz\\Documents\\ForgeProjecten"`, which leaks the
  **username**;
- the Claude Code executable path, version and full supported-flag list once the probe
  completes;
- active run count, connected client count, events persisted, uptime, bridge instance id;
- the entire `degraded` array, which is a list of the installation's current weaknesses,
  written in plain English;
- the number of registered projects and whether any records were unreadable.

That is a reconnaissance package with a username in it. On LAN, `getHealth` must be either
authenticated or reduced, for unauthenticated callers, to a bare liveness boolean with no
paths, no counts and no version.

`exportDiagnostics` is worse and must be **owner-only, host-only**. It is careful about what it
excludes — no `process.env` in any form, no file contents, no payloads, no headers — but it
returns the workspace path, the pid, the platform, the full config description, every degraded
note and the complete router statistics. That is a map of the installation.

### 10.2 Remote shutdown

There is **no shutdown operation** in the contract. `OPERATIONS` contains no `shutdownBridge`,
no `restart`, no `killAll`. Shutdown happens through SIGINT/SIGTERM, which is a local signal,
delivered by whoever controls the process — launchd, or a person at the machine.

**This should stay true.** A remote shutdown verb is a denial-of-service primitive handed to
every paired device, and it buys almost nothing: the owner is by definition able to reach the
host to stop it. If remote lifecycle control is ever genuinely needed, the shape to review is
narrow and specific:

- Owner-only, and only from a client record flagged as the owner's own device.
- Drain-only: stop accepting new operations and let live runs finish. Never a force-kill,
  because a force-kill leaves exactly the orphaned Claude Code process trees that the
  reconciler then has to mark `ORPHANED`.
- Audited as its own event type with the principal recorded.
- Rate limited to something like once per hour, because a legitimate use is rare and an
  illegitimate one is a loop.

The existing shutdown machinery is already honest about partial failure — each registered task
is recorded as `COMPLETED`, `FAILED` or `TIMED_OUT`, and `clean` is false unless every task
completed **and** the lock was released. A remote caller would need to receive that report
unmodified, including the case where cleanup is not guaranteed.

---

## 11. Why `REMOTE_ACCESS` has no design here

Deliberately absent, and the reason in `config.ts` is the whole argument:

> Tunnels, relays and reverse proxies put an operation surface that can write files and spawn
> processes on the public internet. That is not a feature with a safe configuration.

Nothing in this document should be read as a partial design for remote access. LAN mode has a
bounded, enumerable set of possible peers and a physical enrolment step. A tunnel has neither.
If remote access is ever seriously wanted, the correct shape is not to widen the bridge but to
put a separately-designed, separately-audited service in front of it — and that is a different
product, not a configuration flag.

---

## 12. The gate

LAN mode may not be enabled until **all** of the following exist, are tested, and have been
reviewed by someone who did not write them.

### Must be built and independently reviewed

**Authentication and identity**

1. `ClientRecord` record kind with public key, capabilities, and revocation.
2. Physical, host-side pairing with a short-lived single-use code. No remote enrolment.
3. Per-request signature verification with a clock-skew window and a nonce replay cache.
4. Immediate revocation, performed on the host, that also closes open sockets.
5. Non-ambient credential — a computed header, never a cookie — with a written CSRF argument.
6. `clientRecordId` and source address in every audit line; unattributable requests refused
   before reaching a handler.

**Transport security**

7. TLS mandatory, with a hard refusal to start LAN mode without a certificate.
8. Certificate generation, `0600` key storage, and fingerprint printed at startup and in
   `--print-config`.
9. Fingerprint pinning in the client, permanent display in the UI, and an explicit
   owner-driven rotation-and-re-pair flow.

**Network scope**

10. Bind to a named interface address from a fixed allowlist. Never `0.0.0.0`. Interface
    enumeration with fail-closed refusal when the address is not found.
11. Host header predicate derived from `server.address()`, plus exact-match origin allowlist
    that cannot be widened by an environment variable.
12. A written, tested, reboot-surviving firewall ruleset scoped to the LAN subnet, denying the
    port on VPN, tunnel and hotspot interfaces.
13. Discovery/mDNS opt-in and separate from LAN mode, with a TXT record that fingerprints
    nothing.

**Authorisation and isolation**

14. A shrunken operation set for non-loopback clients. Per `FUTURE_LAN_DESIGN` point 5, the
    filesystem verbs (`readProjectFile`, `listProjectFiles`, `getFileDiff`, `stageAttachment`)
    and `runApprovedTest` are **denied to a non-loopback client outright**: path containment
    protects the trusted root, not the machine's owner from a device on a coffee-shop wifi.
15. `exportDiagnostics` owner-only and host-only. `getHealth` authenticated or reduced to a
    bare liveness boolean.
16. `approveAction` / `denyAction` owner-only and host-only. No device approves its own
    request.
17. Per-client idempotency keys `(clientRecordId, requestId)`.
18. Subscription and event-read authorisation enforced inside the store query, not as an
    output filter.

**Availability**

19. Per-client rate limits and a connection cap, using the existing `QUOTA_EXCEEDED` code.
20. A token and cost budget per client, enforced against the EXACT figures the usage
    aggregator already produces.
21. Concurrent-run caps, per client and total.
22. Failed-authentication throttling per source address.

**Honesty**

23. `LAN_MODE = true` in `src/bridge/config.ts` in a reviewed commit — no environment variable,
    no CLI flag, no settings toggle in the UI. The blast radius of this switch is the whole
    machine, so it must cost a code review.
24. `INVARIANT_DECLARATIONS.LAN_MODE` in `src/shared/protocol.ts` changed in the **same
    commit**, its entry in `INVARIANT_DECLARATION_PROOFS` rewritten to name a proof that is
    still true, and `tests/unit/runtime-declarations.test.ts` updated to match. The declaration
    is a claim about reality and would otherwise become false. Note that `LAN_MODE` is an
    *invariant*, not a derived declaration: it is a property of the build, so its proof is a
    static scan and the scan must be rewritten, not merely re-run.
25. `describeConfig()` and the health endpoint report the bound address and LAN state
    truthfully, and the UI shows an unmistakable indicator that the workspace is reachable from
    the network.
26. Audit hash chain, and a documented statement of what it does and does not prove.

**Evidence**

27. An adversarial test corpus for the new boundary, in the style of
    `src/bridge/security/paths.test-vectors.ts`: forged Origin, forged Host, replayed
    signature, expired pairing code, revoked client, rate-limit bypass attempt, unpaired
    device on the subnet.
28. A recorded penetration attempt from an unpaired device on a real LAN, with the results
    written down — including anything that worked.

### Approval

**Enabling LAN mode requires separate, explicit owner approval.**

Completing the twenty-eight items above does not enable it. It makes it *reviewable*. The
decision to flip `LAN_MODE` is the owner's alone, made with the threat model in §3 in front of
them, and recorded — who approved it, on what date, against which reviewed commit, and for
which specific network.

Until that approval exists and is recorded, `LAN_MODE` stays `false`, `REMOTE_ACCESS` stays
`false`, and the bridge stays on `127.0.0.1`.
