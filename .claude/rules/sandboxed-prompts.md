---
paths:
  - ".sandcastle/**"
---

# Sandboxed prompts and the factory

The **factory** in `.sandcastle/factory/` runs an **agent** inside a **sandbox** on each of its prompts ([ADR-0022](../../docs/adr/0022-beads-holds-specs-and-tasks.md), [`docs/agents/factory.md`](../../docs/agents/factory.md)):

- The host-side factory (`factory.ts`, through its `Tracker` and `CodeHost` adapters) does every `bd` read and write and every GitHub call. It passes the task text into the prompt as prompt arguments (`promptArgs` mapped to `{{KEY}}`).
- The prompt asks the agent only for code and commits on the given branch, ending with a `<factory-result>` block. The factory runs the checks, pushes the branch, opens the PR and changes task state.
- In prompts, word the agent's job as work on the task text it was given, with no `bd` or `gh` commands.

`.sandcastle/agent-workflows/` holds the runners behind `.github/workflows/agent-*.yml`, not the factory. They still read GitHub issues.

This rule does not cover `src/templates/`. Those are Sandcastle's product scaffolds, where the agent does list and close tasks itself.
