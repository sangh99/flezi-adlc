# Issue tracker: Beads

Issues and specs for this repo live in [Beads](https://github.com/steveyegge/beads), a local, dependency-aware issue tracker. Use the `bd` CLI for all operations. Pass `--json` when you need to parse the output.

Run `bd` on the **host** only. Agents inside a sandbox never call `bd`; the orchestrator passes them task text and changes task state itself.

## Conventions

- **Issue types**: a spec is an `epic`; implementation tickets are `task`s whose parent is the spec epic; bugs are `bug`s.
- **Create an issue**: `bd create "<title>" --type <epic|task|bug> --body-file - --silent`, piping a heredoc as the body. `--silent` prints only the new ID.
- **Create a child**: add `--parent <epic-id>`.
- **Read an issue**: `bd show <id>` for the body, labels and dependencies, and `bd comments <id>` for the comments.
- **List issues**: `bd list --json` with filters such as `--type`, `--label`, `--status` and `--parent <epic-id>`. Use `--limit 0` so the full backlog is visible (the default is 50). Add `--all` to include closed issues.
- **List unblocked work**: `bd ready --json --exclude-type epic`, optionally with `--parent <epic-id>` and `--label <label>`.
- **Comment on an issue**: `bd comment <id> --stdin`, piping a heredoc.
- **Apply / remove labels**: `bd update <id> --add-label "..."` / `--remove-label "..."`
- **Blocking**: `bd dep add <blocked-id> --blocked-by <blocker-id>`. Blocked issues drop out of `bd ready` until their blockers close.
- **Close**: `bd close <id> --reason "..."`

IDs look like `bd-a3f8`. Refer to issues by ID, never by a GitHub-style `#42`.

## Approval gates

Gates are passed by a person, never by an agent. Anyone on the team can approve.

- **Spec gate**: add `spec-approved` to the spec epic.
- **Task gate**: add `ready-for-agent` to the spec epic (or to the single task, for a Quick workflow).
- **Diagnosis gate**: add `ready-for-agent` to the bug.

When you pass a gate, also comment the snapshot you approved: `bd comment <id> "Approved: <gate>, <latest bd history ref>"`, taking the ref from `bd history <id> --limit 1`.

## Workflows

Each workflow starts from a person-only skill that stops at its approval gate and prints the commands for passing it.

- **Feature**: [`/feature`](../../.agents/skills/feature/SKILL.md) grills an idea, then hands it to `/to-spec` (Spec gate) and `/to-tickets` (Task gate). `/feature <spec-id>` reports where an existing spec is and the next step.
- **Quick**: [`/quick`](../../.agents/skills/quick/SKILL.md) writes one parentless task with its agreed test boundary (Task gate).
- **Bugfix**: [`/bugfix`](../../.agents/skills/bugfix/SKILL.md) files or adopts a bug and diagnoses it until a command reliably fails on it (Diagnosis gate).

Past its last gate, work goes to the [factory](factory.md), which builds it and opens the pull request for the merge gate.

## Pull requests as a triage surface

**PRs as a request surface: no.** Beads holds issues only; pull requests live on the code host and are not triaged.

## When a skill says "publish to the issue tracker"

Create a Beads issue: an `epic` for a spec, a `task` with `--parent <epic-id>` for a ticket, a `bug` for a bug report.

## When a skill says "fetch the relevant ticket"

Run `bd show <id>` and `bd comments <id>`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is an epic, with one **child** issue per ticket.

- **Map**: an `epic` labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `bd create "<title>" --type epic --labels wayfinder:map --body-file -`.
- **Child ticket**: `bd create "<question>" --type task --parent <map-id> --labels wayfinder:<type> --body-file -`.
- **Blocking**: `bd dep add <child> --blocked-by <blocker>`, Beads' native dependency.
- **Frontier query**: `bd ready --json --parent <map-id> --unassigned`.
- **Claim**: `bd update <id> --claim`, the session's first write. It sets you as assignee and the status to in progress.
- **Resolve**: `bd comment <id> --stdin` with the answer, then `bd close <id> --reason "resolved"`, then append a context pointer (gist + ID) to the map's Decisions-so-far with `bd update <map-id> --body-file -`.
