---
name: feature
description: Start or resume the Feature workflow. Grills an idea, hands it to /to-spec and /to-tickets, and stops at the Spec gate and the Task gate.
disable-model-invocation: true
---

# Feature

The **Feature** workflow runs: grill → spec → **Spec gate** → tasks → **Task gate** → **factory** → **Merge gate**. This skill drives the parts before the factory and stops at every gate. Only a person passes a gate, so print the gate commands for them and never run them yourself.

Beads conventions and the gate labels are in `docs/agents/issue-tracker.md`.

## 1. Find where the work is

With no argument, this is a new feature: go to step 2.

With a spec ID, read it with `bd show <id> --json` and, if it carries `spec-approved`, list its tasks with `bd list --parent <id> --json --limit 0 --all`. Find its row below, do that row's next step, and stop.

| Where the spec is        | How to tell                                     | Next step                                                                                      |
| ------------------------ | ----------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Waiting at the Spec gate | No `spec-approved` label                        | Print the Spec gate message (step 4)                                                           |
| Approved, no tasks yet   | `spec-approved`, and the task list is empty     | Tell the person to type `/to-tickets <id>`. Once it has published the tasks, go to step 5      |
| Waiting at the Task gate | Has tasks, but no `ready-for-agent` on the spec | Print the Task gate message (step 5)                                                           |
| In the factory           | `ready-for-agent` on the spec                   | Report how many of its tasks are closed and say that each pull request waits at the Merge gate |

If the ID is not an epic, say so: a task belongs to `/quick`, a bug to `/bugfix`.

## 2. Grill

Call the Skill tool twice, for "grilling" and "domain-modeling", as `/grill-with-docs` does. This repo's glossary is `GLOSSARY.md`, with ADRs in `docs/adr/` (see `docs/agents/domain.md`).

Done when the grilling frontier is empty and the person has confirmed you share an understanding.

## 3. Hand off to /to-spec

Tell the person to type `/to-spec` in this session. It is person-only, so you can't invoke it, and running it in this unbroken context lets the spec build on the grilling. Then stop.

## 4. Spec gate

Once `/to-spec` has published the spec, take the snapshot ref from `bd history <id> --limit 1` and end with:

```
Waiting at the Spec gate: <id> <title>

Review it with `bd show <id>`. To approve, run:

  bd update <id> --add-label spec-approved
  bd comment <id> "Approved: Spec gate, <ref>"

Then run `/feature <id>` to break it into tasks.
```

If the spec changes before approval, the ref must be re-taken from `bd history <id> --limit 1`; say so.

## 5. Task gate

Once `/to-tickets` has published the tasks, take the snapshot ref from `bd history <id> --limit 1` for the spec and end with:

```
Waiting at the Task gate: <id> <title>, <n> tasks

Review them and their blocking edges with `bd graph <id>`. To approve, run:

  bd update <id> --add-label ready-for-agent
  bd comment <id> "Approved: Task gate, <ref>"

The factory then picks the tasks up.
```
