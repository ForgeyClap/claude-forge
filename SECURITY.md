# Security Policy

Thanks for helping keep **claude-forge** and its users safe.

## Supported versions

Forge V2 is under active development. Security fixes are made against the latest
release and `main`.

| Version | Supported |
| --- | --- |
| 2.0.x | Yes |
| < 2.0 | No |

## Reporting a vulnerability

**Please report security issues privately — do not open a public issue for an
unpatched vulnerability.**

Preferred: use GitHub's private vulnerability reporting on the repository
(**Security → Report a vulnerability**) at
<https://github.com/ForgeyClap/claude-forge/security/advisories/new>.

Alternatively, contact the maintainer **[@ForgeyClap](https://github.com/ForgeyClap)**
through their GitHub profile. If you must use a public channel, open an issue
that says only that you found a security problem and asks for a private contact
— **do not include the details or any proof-of-concept publicly.**

When you report, please include, if you can:

- a description of the issue and its impact,
- steps to reproduce or a minimal proof-of-concept,
- affected files, versions, or install method (plugin / installer / manual),
- any suggested remediation.

**Never include real secrets, API keys, tokens, or personal data in a report.**
Redact them.

### What to expect

- We aim to acknowledge a report within a few days.
- We will investigate, confirm, and work on a fix, keeping you updated.
- Once a fix is released, we are happy to credit you in the release notes unless
  you prefer to remain anonymous.

Please give us reasonable time to release a fix before any public disclosure.

## How Forge handles your keys (by design)

Forge is built so that secrets never end up in the repository or in git history.
The honest, zero-dependency key handling works like this:

- **`.env` is gitignored and never committed.** The `.gitignore` covers `.env`,
  `.env.local`, `.env.*.local`, and the temporary setup files. The committed
  `.env.example` contains **key names and comments only — never values.**
- **The temporary fill-file is short-lived.** `/setup-forge` writes a
  `.env.forge-setup` fill-file that is *already gitignored the moment it is
  created*. After you paste your keys and say "done", Forge moves the real
  values into the gitignored `.env` and then **deletes the temporary file** so
  no stray copy of a secret lingers on disk.
- **Secrets are never echoed.** Forge confirms outcomes by **key name only**
  (for example, "saved `ANTHROPIC_API_KEY`") and never prints a secret value
  back to you or to any log.
- **A tracked `.env` is a hard stop.** If a `.env` is already tracked by git,
  setup refuses to proceed and tells you to run `git rm --cached .env` and
  rotate any exposed keys.
- **No secret storage dependency.** Forge uses a gitignored `.env` (with
  best-effort `0600` permissions on Unix) as its honest primary tier and does
  not bundle a native keychain module. Using your OS keychain is documented as
  an optional advanced upgrade, never a claim Forge makes falsely.
- **Zero runtime dependencies.** There are no third-party npm packages or native
  modules, which removes the usual supply-chain attack surface. Everything is
  plain Node `.cjs`, POSIX `sh`, PowerShell, and Markdown / JSON / YAML.

If you ever find a secret committed to this repository, treat it as a
vulnerability and report it privately using the process above — then the key
should be rotated immediately.
