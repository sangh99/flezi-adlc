---
paths:
  - ".sandcastle/**"
  - ".factory/**"
---

# Sandboxed prompts and the factory

The prompts and scripts here run an **agent** inside a **sandbox** ([ADR-0022](../../docs/adr/0022-beads-holds-specs-and-tasks.md)):

- The host-side script (for example `.factory/implement-task.ts`) does every `bd` read and write and every GitHub call. It passes the task text into the prompt as prompt arguments (`promptArgs` mapped to `{{KEY}}`).
- The prompt asks the agent only for code and commits on the given branch. The factory pushes the branch and opens the PR.
- In prompts, word the agent's job as work on the task text it was given, with no `bd` or `gh` commands. The existing `gh issue view` lines are upstream leftovers that will move to Beads IDs.

This rule does not cover `src/templates/`. Those are Sandcastle's product scaffolds, where the agent does list and close tasks itself.
