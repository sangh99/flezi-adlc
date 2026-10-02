# Beads holds specs and tasks; GitHub holds only code and PRs

The **ADLC kit** borrows heavily from Kiro, which keeps specs as files in the repo, and Matt's skills keep specs and tickets as GitHub issues. We do neither: a **spec** is a Beads epic, its **tasks** are child issues, and the blocking edges between them are Beads dependencies. GitHub holds only code and pull requests.

Beads already models what the workflow needs:

- `bd ready` is the frontier of unblocked tasks, which gives the **factory** its parallel waves without an LLM planner guessing dependencies.
- `bd history` gives each spec a version history.
- `bd lint` enforces required sections on epics (Requirements, Design).
- It is also Sandcastle's default **issue tracker**.

For the MVP the Beads database (Dolt, `.beads/`) lives on one **host**. The factory script does every `bd` read and write on the host, and agents in **sandboxes** receive task text as prompt arguments and never run `bd` themselves. This differs from Sandcastle's own Beads templates, where the agent lists and closes tasks.

## Considered Options

- **Spec files in the repo, Kiro-style** - rejected. It would split planning across two systems, and Beads already gives history and structure.
- **Specs on GitHub, tasks in Beads** - rejected. Two trackers means sync bugs.
- **Shared Beads database (Dolt remote or `bd serve`) from day one** - deferred until a second person needs to plan.

## Consequences

- `docs/agents/issue-tracker.md` and the vendored skills that call `gh issue` must be rewritten for Beads.
- The factory's GitHub-issue plumbing (`gh issue view`, `FACTORY_TASK_ISSUE_NUMBER`) must move to Beads IDs.
- Only the factory script changes task state, so an agent can't close or edit tasks.
- Bugs are filed directly in Beads (`bd create --type bug`), `/triage` works on Beads, and GitHub Issues is turned off.
