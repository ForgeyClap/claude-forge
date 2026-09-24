---
description: Update CLAUDE.md with learnings from this session
allowed-tools: Read, Edit, Glob
---

<!--
  Source: https://github.com/anthropics/claude-plugins-official
  Pinned commit: 6bfd4e0c6d3da6050984fa5ed8281d915fa7ed69 (2026-09-23)
  Upstream path: plugins/claude-md-management/commands/revise-claude-md.md
  License: Apache-2.0 -- complete terms in .claude/skills/claude-md-improver/LICENSE.txt (byte-identical to this plugin's LICENSE)
  Forge vendor note: this provenance block added (Apache-2.0 section 4(b) change notice); frontmatter and body verbatim. Upstream neither invokes the claude-md-improver skill nor uses a plugin-relative path, so nothing needed rewriting; the audit counterpart ships as the claude-md-improver skill.
  Reviewed for prompt-injection patterns, hidden/zero-width/bidi/control unicode, network use and deletes by build-boss, 2026-09-24 -- clean; every upstream file sha256-verified against the pinned-commit manifest before copying.
-->

Review this session for learnings about working with Claude Code in this codebase. Update CLAUDE.md with context that would help future Claude sessions be more effective.

## Step 1: Reflect

What context was missing that would have helped Claude work more effectively?
- Bash commands that were used or discovered
- Code style patterns followed
- Testing approaches that worked
- Environment/configuration quirks
- Warnings or gotchas encountered

## Step 2: Find CLAUDE.md Files

```bash
find . -name "CLAUDE.md" -o -name ".claude.local.md" 2>/dev/null | head -20
```

Decide where each addition belongs:
- `CLAUDE.md` - Team-shared (checked into git)
- `.claude.local.md` - Personal/local only (gitignored)

## Step 3: Draft Additions

**Keep it concise** - one line per concept. CLAUDE.md is part of the prompt, so brevity matters.

Format: `<command or pattern>` - `<brief description>`

Avoid:
- Verbose explanations
- Obvious information
- One-off fixes unlikely to recur

## Step 4: Show Proposed Changes

For each addition:

```
### Update: ./CLAUDE.md

**Why:** [one-line reason]

\`\`\`diff
+ [the addition - keep it brief]
\`\`\`
```

## Step 5: Apply with Approval

Ask if the user wants to apply the changes. Only edit files they approve.
