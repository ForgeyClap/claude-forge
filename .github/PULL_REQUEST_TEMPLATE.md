<!--
Thanks for contributing to Forge V2!
Keep the zero-dependency rule for the core: plain Node .cjs, POSIX sh, PowerShell, Markdown/JSON/YAML only.
No npm packages, no native modules, no runtime dependencies in `.claude/forge-bin` or the global core.
The one scoped exception is the optional Command Center dashboard (command-center/dashboard/), which has
its own package.json and a one-time npm build — that stays confined to its own folder.
-->

## What does this PR do?

<!-- A short summary of the change and why it's needed. -->

## Related issues

<!-- e.g. Closes #123 -->

## Checklist

- [ ] `node .claude/forge-bin/forge-doctor.cjs` is **ALL GREEN** locally
- [ ] Relevant `*.test.cjs` suites pass (`node .claude/forge-bin/<name>.test.cjs`)
- [ ] Plugin manifests still validate (`.claude-plugin/marketplace.json` + `plugins/*/.claude-plugin/plugin.json` are valid JSON with required fields)
- [ ] Docs updated (README / skill docs / comments) where behavior changed
- [ ] **No secrets** committed — no real API keys, tokens, or `.env` values; placeholders only
- [ ] Zero new runtime dependencies (no `npm install`, no external packages)
- [ ] Cross-platform: works on Windows, macOS, and Linux

## Notes for reviewers

<!-- Anything reviewers should focus on, trade-offs, or follow-ups. -->
