# Forge reference — `/forge learn` (WAVE F, cross-project learning harvest)

Moved out of `.claude/commands/forge.md` (v2.9.0, WP-C context trim) so the command file only carries a
one-line pointer for this rarely-used, opt-in path. This file is the full, unmodified rule — read it before
running `/forge learn`. Nothing below was reworded from the original; it is the same rule that used to sit
inline.

## When this applies

The owner explicitly asks to harvest lessons from OTHER Forge projects into this one (never automatic,
never part of an ordinary `/forge <task>` run).

## The rule (verbatim)

**`learn`** (WAVE F, opt-in, read-only) → **cross-project learning harvest**: reads OTHER Forge projects'
`.claude/FORGE_*.md` memory files (never writes to them) and stores real, evidenced lines from them into THIS
project's reserved `global` lesson namespace — the same namespace `forge-recall.cjs` always blends into
every dispatch, so a lesson from project A can now surface as advisory guidance in project B.
`node .claude/forge-bin/forge-harvest.cjs --scan <portfolio-dir> [--global-store <file>] [--dry-run] [--json]`
(or `--projects <a,b,...>` for an explicit list; or `forge.cmd learn` / `forge.ps1 learn` / `bash forge.sh
learn`, passthrough args). **Explicit discovery only** — neither flag given means nothing is scanned;
`--scan <dir>` only checks that dir's IMMEDIATE child folders for a `.claude/FORGE_*` marker (one level,
never recursive, never a whole-disk walk). **Secrets/PII excluded**: `.env`/`.env.*`/`*.key`/`*.pem`/
`*secret*`/`*credential*`/`id_rsa*` are never opened, and every line read is redacted (reusing the same
secret-pattern set the leak scan uses) before it can become a lesson — a line that still looks secret-shaped
after redaction is dropped outright, never stored. **Evidenced-only**: a stored lesson is a verbatim quote
from a real logged line (a decision-log row, a "what worked" note, a recurring owner-ask) tagged with its
source project/file/line — never synthesised or summarised into a new claim; un-recorded history yields no
lesson. Always **read-only on other projects** — its only write is to this project's own global lesson
store. Use `--dry-run` first to see what WOULD be learned without writing anything. Log `lessons_harvested`
(projects scanned, lessons stored, skipped-secret, skipped-non-canonical) after a real (non-dry-run) harvest.
