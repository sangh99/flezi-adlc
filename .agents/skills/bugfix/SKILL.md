---
name: bugfix
description: Start the Bugfix workflow. Diagnoses a Beads bug until a command reliably fails on it, records the root cause and fix approach, and stops at the Diagnosis gate.
disable-model-invocation: true
---

# Bugfix

The **Bugfix** workflow runs: diagnosis → **Diagnosis gate** → **factory** → **Merge gate**. This skill drives the diagnosis with the person; the factory writes the regression test and the fix, working from a clean checkout and the bug body alone. Only a person passes the gate, so print the gate commands for them and never run them yourself.

Beads conventions and the gate labels are in `docs/agents/issue-tracker.md`.

## 1. File or adopt the bug

With a bug ID, read it with `bd show <id>` and `bd comments <id>`. If it is not a `bug`, say so and stop. If it already carries `ready-for-agent` and has an `Approved: Diagnosis gate` comment, it is past the Diagnosis gate: say so and stop. If it carries `ready-for-agent` with no such comment, the label was most likely copied from its parent spec when the bug was filed, and the factory would take it undiagnosed: tell the person to remove it (`bd update <id> --remove-label ready-for-agent`) and stop.

With no ID, file one holding what the person reported:

```
bd create "<title>" --type bug --body-file - --silent <<'EOF'
## Symptom

<what the person reported>
EOF
```

## 2. Diagnose

Call the Skill tool for "diagnosing-bugs" and work through it with the person, up to the end of Phase 4. This repo's glossary is `CONTEXT.md`.

Done when both hold:

- Phase 1's completion criterion: one command, already run, that goes **red** on this bug. It must run from a clean checkout, so put the full content of any harness or fixture it needs into the bug body.
- The person agrees the root cause: the hypothesis your probes confirmed.

Phase 5 belongs to the factory. Stop here and clean up as Phase 6 lists: remove every `[DEBUG-...]` probe and throwaway harness from the working tree.

## 3. Agree the fix

Agree with the person the fix approach and the seam for the regression test (Phase 5's **correct seam**). If no correct seam exists, record that as the finding. The factory's implementer drives `/tdd` at this seam.

## 4. Record the diagnosis

Rewrite the bug body with `bd update <id> --body-file -`, keeping the reported symptom. Then run `bd lint <id>` and fix the body until it is clean.

<bug-template>

## Symptom

What the person reported, and what should happen instead.

## Steps to Reproduce

The reliably failing command, and its red output (redacted). Include the full content of any harness or fixture the command needs.

## Root Cause

The agreed root cause, and the probe result that confirmed it.

## Fix Approach

The agreed change, in terms of behaviour and modules rather than a diff.

## Testing

The seam for the regression test, or "No correct seam" and why.

## Acceptance Criteria

- [ ] The command in Steps to Reproduce goes green
- [ ] A regression test at the seam in Testing fails before the fix and passes after
- [ ] Any criterion specific to this bug

</bug-template>

## 5. Diagnosis gate

Take the snapshot ref from `bd history <id> --limit 1` and end with:

```
Waiting at the Diagnosis gate: <id> <title>

Review it with `bd show <id>`. To approve, run:

  bd update <id> --add-label ready-for-agent
  bd comment <id> "Approved: Diagnosis gate, <ref>"

The factory then writes the fix.
```

If the bug changes before approval, the ref must be re-taken from `bd history <id> --limit 1`; say so.
