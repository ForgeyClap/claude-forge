---
allowed-tools: Bash(git add:*), Bash(git status:*), Bash(git commit:*)
description: Create a git commit
disable-model-invocation: true
---

<!--
  Source: https://github.com/anthropics/claude-plugins-official
  Pinned commit: 6bfd4e0c6d3da6050984fa5ed8281d915fa7ed69 (2026-09-23)
  Upstream path: plugins/commit-commands/commands/commit.md
  License: Apache-2.0 -- complete terms in .claude/skills/claude-md-improver/LICENSE.txt (byte-identical to this plugin's LICENSE)
  Forge vendor note: this provenance block added (Apache-2.0 section 4(b) change notice); frontmatter and body verbatim, including the read-only inline git context lines (a documented slash-command feature). Only commit.md is vendored from commit-commands: commit-push-pr.md (pushes and opens PRs) and clean_gone.md (deletes branches and worktrees) are deliberately not shipped -- see .claude/skills/VENDORED-SKILLS.md.
  Reviewed for prompt-injection patterns, hidden/zero-width/bidi/control unicode, network use and deletes by build-boss, 2026-09-24 -- clean; every upstream file sha256-verified against the pinned-commit manifest before copying.
-->

## Context

- Current git status: !`git status`
- Current git diff (staged and unstaged changes): !`git diff HEAD`
- Current branch: !`git branch --show-current`
- Recent commits: !`git log --oneline -10`

## Your task

Based on the above changes, create a single git commit.

You have the capability to call multiple tools in a single response. Stage and create the commit using a single message. Do not use any other tools or do anything else. Do not send any other text or messages besides these tool calls.
