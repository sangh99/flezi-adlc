---
"@ai-hero/sandcastle": minor
---

`sandcastle init` no longer asks for the agent or issue tracker: it uses **Claude Code** and **Beads** by default. Pass `--agent <name>` or `--issue-tracker github-issues` / `custom` to choose otherwise. `scaffold()` also defaults to Beads. The Beads task list now runs `bd ready --json --exclude-type epic`, so agents no longer pick up an epic (spec) as work.
