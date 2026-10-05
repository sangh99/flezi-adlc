---
name: quick
description: Start the Quick workflow. Turns a small change into one agent-ready Beads task and stops at the Task gate.
disable-model-invocation: true
---

# Quick

The **Quick** workflow runs: one task → **Task gate** → **factory** → **Merge gate**. There is no spec and no Spec gate, so the task itself carries everything the factory needs. Only a person passes the gate, so print the gate commands for them and never run them yourself.

Beads conventions and the gate labels are in `docs/agents/issue-tracker.md`.

## 1. Size it

A Quick change is one **tracer bullet**: a single vertical slice that fits one fresh context window. If it needs more than one task, say so, suggest `/feature`, and stop.

## 2. Grill only the gaps

If the request already settles what to build and how you'll know it's done, skip to step 3. Otherwise call the Skill tool for "grilling" and ask only the rounds needed to fill the template below.

## 3. Agree the test boundary

Propose the seams the tests will sit at, as `tdd` requires, and confirm them with the person. The factory's implementer drives `/tdd` at exactly these seams and reports the task blocked without them.

Done when the person has confirmed the seams.

## 4. Write the task

Create one parentless task, with no labels:

```
bd create "<title>" --type task --body-file - --silent <<'EOF'
<body from the template>
EOF
```

Then run `bd lint <id>` and fix the body (`bd update <id> --body-file -`) until it is clean.

<task-template>

## What to build

The end-to-end behaviour this task makes work, from the user's perspective, not a layer-by-layer implementation list.

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2

## Testing

The seams agreed in step 3, and the behaviour each test observes there. Name prior art (a similar test in the codebase) if there is one.

</task-template>

## 5. Task gate

Take the snapshot ref from `bd history <id> --limit 1` and end with:

```
Waiting at the Task gate: <id> <title>

Review it with `bd show <id>`. To approve, run:

  bd update <id> --add-label ready-for-agent
  bd comment <id> "Approved: Task gate, <ref>"

The factory then picks it up.
```

If the task changes before approval, the ref must be re-taken from `bd history <id> --limit 1`; say so.
